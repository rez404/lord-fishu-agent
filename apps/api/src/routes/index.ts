import { createHash } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@fishnu/db';
import {
  backroomsMessages,
  backroomsSessions,
  confessions,
  inboundTweets,
  people,
  posts,
  thoughts,
} from '@fishnu/db';

const STREAM_POLL_MS = 2_000;
const STREAM_HEARTBEAT_MS = 25_000;

export async function registerRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get('/health', async () => ({ ok: true }));

  /**
   * Everything the boot sequence needs in one call. The terminal prints these counts as
   * it "loads", so a waterfall of requests here would show up as a stuttering boot.
   */
  app.get('/api/boot', async () => {
    const [[verses], [sessions], [congregation], [answered], latest] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(posts).where(eq(posts.kind, 'post')),
      db.select({ n: sql<number>`count(*)::int` }).from(backroomsSessions),
      db.select({ n: sql<number>`count(*)::int` }).from(people),
      db.select({ n: sql<number>`count(*)::int` }).from(inboundTweets).where(eq(inboundTweets.status, 'replied')),
      db.select().from(thoughts).orderBy(desc(thoughts.createdAt)).limit(1),
    ]);

    return {
      vessel: env('X_USERNAME') ?? 'lordfishnu',
      wallet: env('WALLET_PUBKEY'),
      awakenedAt: env('AWAKENED_AT'),
      counts: {
        verses: verses?.n ?? 0,
        backrooms: sessions?.n ?? 0,
        congregation: congregation?.n ?? 0,
        answered: answered?.n ?? 0,
      },
      mood: latest[0]?.mood ?? null,
    };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/thoughts', async (req) => {
    const limit = clamp(Number(req.query.limit ?? 60), 1, 200);
    const rows = await db.select().from(thoughts).orderBy(desc(thoughts.createdAt)).limit(limit);
    return { thoughts: rows.reverse() }; // oldest first: the terminal appends downward
  });

  /** What he has written down: his own posts, not replies. */
  app.get<{ Querystring: { limit?: string } }>('/api/scripture', async (req) => {
    const limit = clamp(Number(req.query.limit ?? 50), 1, 200);
    const rows = await db
      .select()
      .from(posts)
      .where(eq(posts.kind, 'post'))
      .orderBy(desc(posts.createdAt))
      .limit(limit);
    return { verses: rows };
  });

  /**
   * Published sessions only. A conversation that is still running would be served
   * half-written, and one the hard block withheld must never reach the public archive —
   * it is kept in the database for review, not for reading.
   */
  app.get('/api/backrooms', async () => {
    const rows = await db
      .select()
      .from(backroomsSessions)
      .where(eq(backroomsSessions.status, 'published'))
      .orderBy(desc(backroomsSessions.startedAt))
      .limit(100);
    return { sessions: rows };
  });

  /**
   * The transcript, rendered in the infinitebackrooms convention: `<actor>` tag on its
   * own line, body beneath, blank line between turns. Served as text/plain so the
   * permalink is a genuine .txt artifact rather than a page pretending to be one.
   */
  app.get<{ Params: { slug: string } }>('/api/backrooms/:slug', async (req, reply) => {
    const [session] = await db
      .select()
      .from(backroomsSessions)
      .where(and(eq(backroomsSessions.slug, req.params.slug), eq(backroomsSessions.status, 'published')))
      .limit(1);
    // Withheld and in-progress sessions are indistinguishable from ones that never
    // existed. Guessing a slug must not be a way around the block.
    if (!session) return reply.code(404).send({ error: 'no such conversation' });

    const messages = await db
      .select()
      .from(backroomsMessages)
      .where(eq(backroomsMessages.sessionId, session.id))
      .orderBy(backroomsMessages.turn);

    if (req.headers.accept?.includes('text/plain')) {
      const body = messages.map((m) => `<${m.actor}>\n${m.body}`).join('\n\n');
      return reply.type('text/plain; charset=utf-8').send(`${session.slug}\n\n${body}\n`);
    }
    return { session, messages };
  });

  app.get('/api/ledger', async () => {
    // Phase 4 fills this in. Reported honestly as unavailable rather than faked, so the
    // terminal can say "the vessel holds nothing yet" instead of inventing a balance.
    return { wallet: env('WALLET_PUBKEY'), holdings: [], transactions: [], live: false };
  });

  app.post<{ Body: { body?: string; handle?: string } }>('/api/confess', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    handler: async (req, reply) => {
      const body = (req.body?.body ?? '').trim();
      if (body.length < 2 || body.length > 500) {
        return reply.code(400).send({ error: 'a confession must be between 2 and 500 characters' });
      }
      const handle = (req.body?.handle ?? '').trim().replace(/^@/, '').slice(0, 15) || null;

      // Hashed with a salt so the stored row cannot be walked back to an IP address.
      const sourceHash = createHash('sha256')
        .update(`${process.env.CONFESSION_SALT ?? 'fishnu'}:${req.ip}`)
        .digest('hex');

      await db.insert(confessions).values({ body, handle, sourceHash });
      return { ok: true };
    },
  });

  /**
   * Server-sent events. Polls for thoughts newer than the last id it sent; the agent
   * ticks every few minutes, so polling every couple of seconds is cheap and avoids
   * putting a Postgres LISTEN connection behind a reverse proxy.
   */
  app.get<{ Querystring: { after?: string } }>('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx/Caddy will otherwise buffer the stream and the terminal looks frozen.
      'x-accel-buffering': 'no',
    });

    let lastId = Number(req.query.after ?? 0);
    let closed = false;

    const send = (event: string, data: unknown) => {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const poll = setInterval(() => {
      void db
        .select()
        .from(thoughts)
        .where(gt(thoughts.id, lastId))
        .orderBy(thoughts.id)
        .limit(50)
        .then((rows) => {
          for (const row of rows) {
            lastId = Math.max(lastId, row.id);
            send('thought', row);
          }
        })
        .catch((err) => app.log.error({ err }, 'stream poll failed'));
    }, STREAM_POLL_MS);

    // Proxies drop idle connections; a comment frame keeps it warm without being an event.
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': keepalive\n\n');
    }, STREAM_HEARTBEAT_MS);

    const cleanup = () => {
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    send('connected', { after: lastId });
  });

  /** Recent visible activity: what he actually said on X. */
  app.get<{ Querystring: { limit?: string } }>('/api/timeline', async (req) => {
    const limit = clamp(Number(req.query.limit ?? 50), 1, 200);
    const rows = await db.select().from(posts).orderBy(desc(posts.createdAt)).limit(limit);
    return { posts: rows };
  });

  /** Who he talks to, ranked by reach — the follower gate made visible. */
  app.get('/api/congregation', async () => {
    const rows = await db
      .select()
      .from(people)
      .where(and(sql`${people.followers} is not null`))
      .orderBy(desc(people.followers))
      .limit(50);
    return { people: rows };
  });
}

/** An unset variable in a compose env_file arrives as '', not undefined. */
function env(key: string): string | null {
  const value = process.env[key];
  return value && value.trim() !== '' ? value : null;
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
