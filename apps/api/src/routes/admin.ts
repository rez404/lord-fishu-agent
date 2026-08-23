import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@fishnu/db';
import { actionLog, impulses, llmCalls, posts, settings, thoughts } from '@fishnu/db';

/**
 * The operator's controls.
 *
 * Guarded by a single bearer token rather than accounts: there is one operator, and a
 * login system would be more surface area than the thing it protects. The token lives in
 * ADMIN_TOKEN on the server and never in the repo.
 *
 * If ADMIN_TOKEN is unset every route here returns 503 — an unauthenticated kill switch
 * on a public URL is worse than no kill switch at all.
 */

const SETTABLE = new Set(['kill_switch', 'dry_run', 'reply_min_followers']);

export async function registerAdminRoutes(app: FastifyInstance, opts: { db: Db; token: string | null }) {
  const { db, token } = opts;

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!token) {
      return reply.code(503).send({ error: 'admin is disabled: ADMIN_TOKEN is not set' });
    }
    const header = req.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Length check first so the comparison below never runs on mismatched sizes.
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
      return reply.code(401).send({ error: 'no' });
    }
  };

  app.get('/admin/state', { preHandler: guard }, async () => {
    const [[postCount], [thoughtCount], [pending], cost, recent, queue] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(posts),
      db.select({ n: sql<number>`count(*)::int` }).from(thoughts),
      db.select({ n: sql<number>`count(*)::int` }).from(impulses).where(eq(impulses.status, 'pending')),
      db
        .select({
          usd: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text`,
          calls: sql<number>`count(*)::int`,
          cachePct: sql<number>`coalesce(round(100.0 * sum(${llmCalls.cachedInputTokens}) / nullif(sum(${llmCalls.inputTokens}), 0)), 0)::int`,
        })
        .from(llmCalls)
        .where(sql`${llmCalls.createdAt} > now() - interval '30 days'`),
      db.select().from(actionLog).orderBy(desc(actionLog.createdAt)).limit(20),
      db.select().from(impulses).orderBy(desc(impulses.createdAt)).limit(20),
    ]);

    const rows = await db.select().from(settings);
    const flags = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    /**
     * What is actually true, not what the database says.
     *
     * The agent lets the environment override both switches — DRY_RUN and KILL_SWITCH in
     * the env win over the stored value, deliberately, so a boot-time hard stop cannot be
     * undone from a web page. That means the stored flag on its own is a lie: an operator
     * could toggle DRY RUN off here, see it go off, and still be posting nothing. Report
     * the effective value and say when the environment is the one deciding.
     */
    const envForced = {
      kill_switch: process.env.KILL_SWITCH === 'true' || process.env.KILL_SWITCH === '1',
      dry_run: process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1',
    };

    return {
      settings: {
        kill_switch: envForced.kill_switch || flags.kill_switch === true,
        dry_run: envForced.dry_run || flags.dry_run === true,
        reply_min_followers:
          (flags.reply_min_followers as number | undefined) ??
          Number(process.env.REPLY_MIN_FOLLOWERS ?? 1000),
      },
      /** Switches the environment is pinning on, which this console cannot turn off. */
      envForced,
      counts: {
        posts: postCount?.n ?? 0,
        thoughts: thoughtCount?.n ?? 0,
        pendingImpulses: pending?.n ?? 0,
      },
      cost: cost[0] ?? { usd: '0', calls: 0, cachePct: 0 },
      impulses: queue,
      recent,
    };
  });

  app.post<{ Body: { key?: string; value?: unknown } }>(
    '/admin/settings',
    { preHandler: guard },
    async (req, reply) => {
      const key = req.body?.key ?? '';
      if (!SETTABLE.has(key)) {
        return reply.code(400).send({ error: `not settable: ${key}` });
      }
      await db
        .insert(settings)
        .values({ key, value: req.body!.value as object, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: req.body!.value as object, updatedAt: new Date() },
        });
      return { ok: true, key, value: req.body!.value };
    },
  );

  /**
   * A fact for him to react to — never a draft. What comes back out is his wording, run
   * through the same critic, guards and repetition checks as anything else he says.
   */
  app.post<{ Body: { body?: string } }>('/admin/impulse', { preHandler: guard }, async (req, reply) => {
    const body = (req.body?.body ?? '').trim();
    if (body.length < 3 || body.length > 600) {
      return reply.code(400).send({ error: 'between 3 and 600 characters' });
    }
    const [row] = await db.insert(impulses).values({ body }).returning({ id: impulses.id });
    return { ok: true, id: row?.id };
  });

  app.delete<{ Params: { id: string } }>('/admin/impulse/:id', { preHandler: guard }, async (req) => {
    await db
      .update(impulses)
      .set({ status: 'abandoned', usedAt: new Date() })
      .where(eq(impulses.id, Number(req.params.id)));
    return { ok: true };
  });
}

/** Constant-time comparison, so a wrong token cannot be discovered a character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
