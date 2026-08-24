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

/** Base58 at Solana's length (no 0/O/I/l), or an EVM address. */
const ADDRESS = /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[a-fA-F0-9]{40})$/;

export async function registerAdminRoutes(
  app: FastifyInstance,
  opts: { db: Db; token: string | null; wake?: () => void },
) {
  const { db, token, wake } = opts;

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
     * What the agent reports about itself, not what this process's environment says.
     *
     * Both switches can be pinned by the environment — deliberately, so a boot-time hard
     * stop cannot be undone from a web page — which means the stored flag alone is a lie.
     * Reading this API's own env was worse: it is a different container, and restarting
     * one without the other made the console confidently report the wrong state.
     */
    const runtime = flags.runtime as
      | { dryRun: boolean; killSwitch: boolean; xEnabled: boolean; account: string | null; minFollowers: number; at: string }
      | undefined;

    // A report older than a few ticks means the agent is not running, and the switches it
    // last described are history rather than status.
    const staleAfterMs = 20 * 60_000;
    const agentSeenAt = runtime?.at ?? null;
    const agentAlive = Boolean(agentSeenAt && Date.now() - Date.parse(agentSeenAt) < staleAfterMs);

    return {
      settings: {
        kill_switch: runtime?.killSwitch ?? flags.kill_switch === true,
        dry_run: runtime?.dryRun ?? flags.dry_run === true,
        reply_min_followers: runtime?.minFollowers ?? (flags.reply_min_followers as number | undefined) ?? null,
      },
      agent: {
        alive: agentAlive,
        seenAt: agentSeenAt,
        xEnabled: runtime?.xEnabled ?? false,
        account: runtime?.account ?? null,
      },
      /**
       * A switch the console can turn off is one the agent read from the database. One it
       * cannot is pinned in the environment — the toggle would write a value the agent
       * then ignores, so it is disabled instead.
       */
      envForced: {
        kill_switch: (runtime?.killSwitch ?? false) && flags.kill_switch !== true,
        dry_run: (runtime?.dryRun ?? false) && flags.dry_run !== true,
      },
      counts: {
        posts: postCount?.n ?? 0,
        thoughts: thoughtCount?.n ?? 0,
        pendingImpulses: pending?.n ?? 0,
      },
      cost: cost[0] ?? { usd: '0', calls: 0, cachePct: 0 },
      impulses: queue,
      recent,
      knowledge: (flags.knowledge as { links?: unknown[]; facts?: string; contract?: unknown } | undefined) ?? {
        links: [],
        facts: '',
        contract: null,
      },
    };
  });

  /**
   * The fixed things he knows. Links are validated here rather than trusted: a malformed
   * one would sit in his prompt as a fact about himself and come back out in public.
   */
  app.post<{
    Body: {
      links?: Array<{ label?: string; url?: string }>;
      facts?: string;
      contract?: { address?: string; chain?: string; symbol?: string } | null;
    };
  }>('/admin/knowledge', { preHandler: guard }, async (req, reply) => {
      const links: Array<{ label: string; url: string }> = [];
      for (const raw of req.body?.links ?? []) {
        const label = (raw?.label ?? '').trim();
        const url = (raw?.url ?? '').trim();
        if (!label && !url) continue;
        if (!label || !url) return reply.code(400).send({ error: 'every link needs a label and a url' });
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
        } catch {
          return reply.code(400).send({ error: `not a url: ${url}` });
        }
        links.push({ label, url });
      }

    const facts = (req.body?.facts ?? '').trim().slice(0, 4_000);

    /*
     * The contract is checked hardest, because it is the only value here that costs money
     * when it is wrong. A typo saved once is then repeated by an agent that has been told
     * to reproduce it exactly — the mistake would be faithful and permanent.
     */
    let contract: { address: string; chain: string; symbol: string } | null = null;
    const raw = req.body?.contract;
    const address = (raw?.address ?? '').trim();
    if (address) {
      if (!ADDRESS.test(address)) {
        return reply.code(400).send({
          error: `that is not an address: ${address} — expected base58 (32-44) or 0x plus 40 hex`,
        });
      }
      contract = {
        address,
        chain: (raw?.chain ?? '').trim().slice(0, 32),
        symbol: (raw?.symbol ?? '').trim().slice(0, 16),
      };
    }

    const value = { links, facts, contract };

    await db
      .insert(settings)
      .values({ key: 'knowledge', value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });

    return { ok: true, knowledge: value };
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
    // Cut the agent's sleep short. Without this an operator watches a spinner for however
    // long is left of the tick — up to several minutes — after telling him something
    // happened. Best effort: if the wake never lands, the next tick picks it up anyway.
    wake?.();
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
