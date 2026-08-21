import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { actionLog, inboundTweets, people, posts } from '@fishnu/db';
import { logger } from '@fishnu/shared';
import { composeReply, type ReplyDeps } from '../mind/reply.js';
import { think } from '../mind/thoughts.js';
import { QuotaExceededError } from '../quota/manager.js';
import type { CursorStore } from '../runtime/cursors.js';
import type { XClient, XTweet } from '../x/types.js';

const MENTIONS_CURSOR = 'mentions_since_id';
const REPLIES_PER_TICK = 3;

export interface TickResult {
  ingested: number;
  replied: number;
  parked: number;
  declined: number;
}

/**
 * One tick: take in what was said to him, decide who is worth answering, answer them.
 *
 * The shape is unchanged from Phase 0 — poll → persist → triage by reach → publish →
 * audit. What changed is the middle: a fixed string became a pipeline that can decline,
 * and declining is now a normal outcome rather than an error.
 */
export async function runTick(deps: {
  db: Db;
  x: XClient;
  cursors: CursorStore;
  dryRun: boolean;
  minFollowers: number;
  mind: Omit<ReplyDeps, 'db'>;
}): Promise<TickResult> {
  const { db, x, cursors, dryRun, minFollowers, mind } = deps;

  const ingested = await ingestMentions(db, x, cursors);
  const parked = await parkLowReach(db, minFollowers);
  const { replied, declined } = await answerPending(db, x, dryRun, { ...mind, db });

  return { ingested, replied, parked, declined };
}

async function ingestMentions(db: Db, x: XClient, cursors: CursorStore): Promise<number> {
  const sinceId = await cursors.get(MENTIONS_CURSOR);

  let page;
  try {
    page = await x.fetchMentions({ sinceId, max: 25 });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      await log(db, 'ingest_mentions', 'skipped', err.message);
      return 0;
    }
    throw err;
  }

  for (const t of page.items) {
    await persistInbound(db, t, 'mention');
  }

  // Advance the cursor only on a successful page, so a crash re-reads instead of skipping.
  if (page.newestId) await cursors.set(MENTIONS_CURSOR, page.newestId);

  if (page.items.length > 0) {
    logger.info({ count: page.items.length }, 'ingested mentions');
  }
  return page.items.length;
}

async function persistInbound(db: Db, t: XTweet, source: string): Promise<void> {
  await db
    .insert(inboundTweets)
    .values({
      tweetId: t.id,
      authorId: t.authorId,
      authorUsername: t.authorUsername ?? null,
      authorFollowers: t.authorFollowers ?? null,
      text: t.text,
      source,
      status: 'pending',
      conversationId: t.conversationId ?? null,
      tweetCreatedAt: t.createdAt ?? null,
    })
    .onConflictDoNothing({ target: inboundTweets.tweetId });

  if (!t.authorId) return;
  await db
    .insert(people)
    .values({
      userId: t.authorId,
      username: t.authorUsername ?? null,
      followers: t.authorFollowers ?? null,
      interactionCount: 1,
    })
    .onConflictDoUpdate({
      target: people.userId,
      set: {
        username: t.authorUsername ?? null,
        followers: t.authorFollowers ?? null,
        lastSeenAt: new Date(),
        interactionCount: sql`${people.interactionCount} + 1`,
      },
    });
}

/**
 * The write budget is ~100 posts a day against an unbounded mention volume, so reach is
 * the rationing rule: only accounts at or above the threshold get one.
 *
 * Parked mentions are kept, not discarded. Their follower count is stored, so lowering
 * the bar later can requeue them (see scripts/requeue.ts). An unknown follower count is
 * treated as zero — X only withholds the user object for suspended or protected
 * accounts, which are not worth a reply anyway.
 */
async function parkLowReach(db: Db, minFollowers: number): Promise<number> {
  if (minFollowers <= 0) return 0;

  const parked = await db
    .update(inboundTweets)
    .set({ status: 'skipped_low_reach', handledAt: new Date() })
    .where(
      and(
        eq(inboundTweets.status, 'pending'),
        eq(inboundTweets.source, 'mention'),
        sql`coalesce(${inboundTweets.authorFollowers}, 0) < ${minFollowers}`,
      ),
    )
    .returning({ tweetId: inboundTweets.tweetId });

  if (parked.length > 0) {
    // Aggregated on purpose: one audit row per tick, not one per ignored account.
    await log(db, 'triage', 'skipped', `below ${minFollowers} followers`, { count: parked.length, minFollowers });
    logger.info({ count: parked.length, minFollowers }, 'parked low-reach mentions');
  }
  return parked.length;
}

async function answerPending(
  db: Db,
  x: XClient,
  dryRun: boolean,
  mind: ReplyDeps,
): Promise<{ replied: number; declined: number }> {
  // Highest reach first: when the per-tick cap bites, the biggest account should be the
  // one that gets answered.
  const pending = await db
    .select()
    .from(inboundTweets)
    .where(and(eq(inboundTweets.status, 'pending'), eq(inboundTweets.source, 'mention')))
    .orderBy(desc(sql`coalesce(${inboundTweets.authorFollowers}, 0)`), asc(inboundTweets.seenAt))
    .limit(REPLIES_PER_TICK);

  let replied = 0;
  let declined = 0;

  for (const mention of pending) {
    let outcome;
    try {
      outcome = await composeReply(mind, {
        tweetId: mention.tweetId,
        authorId: mention.authorId,
        authorUsername: mention.authorUsername,
        authorFollowers: mention.authorFollowers,
        text: mention.text,
      });
    } catch (err) {
      // A model outage must not consume the mention: leave it pending and try next tick.
      await log(db, 'compose', 'error', String(err), { inReplyTo: mention.tweetId });
      logger.error({ err, tweetId: mention.tweetId }, 'composition failed');
      break;
    }

    if (outcome.kind === 'declined') {
      // Deliberate silence, not a failure. Settled so it is not reconsidered every tick.
      await settle(db, mention.tweetId, 'declined');
      await log(db, 'reply', 'skipped', outcome.reason, { inReplyTo: mention.tweetId });
      declined += 1;
      continue;
    }

    try {
      const result = await x.publish({ text: outcome.text, inReplyToTweetId: mention.tweetId });

      await db.insert(posts).values({
        tweetId: result.tweetId,
        kind: 'reply',
        text: outcome.text,
        inReplyToTweetId: mention.tweetId,
        dryRun: String(result.dryRun),
        // Stored so future drafts can be checked against it without re-embedding.
        embedding: outcome.embedding,
        meta: { respondingTo: mention.authorUsername, followers: mention.authorFollowers },
      });

      await think(db, 'utterance', outcome.text, { mood: mind.mood, meta: { tweetId: result.tweetId } });
      await settle(db, mention.tweetId, 'replied');
      await log(db, 'reply', 'ok', null, {
        tweetId: result.tweetId,
        inReplyTo: mention.tweetId,
        followers: mention.authorFollowers,
        dryRun: result.dryRun,
      });
      replied += 1;
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        // Leave it pending: it gets picked up once the budget refreshes. The composition
        // is lost, which is a few cents — cheaper than holding a write slot open.
        await log(db, 'reply', 'skipped', err.message, { inReplyTo: mention.tweetId });
        break;
      }
      // A permanently un-repliable mention (deleted, blocked, protected) must not wedge
      // the queue, so it is settled as failed and recorded.
      await settle(db, mention.tweetId, 'failed');
      await log(db, 'reply', 'error', String(err), { inReplyTo: mention.tweetId });
      logger.error({ err, tweetId: mention.tweetId }, 'reply failed');
    }
  }

  if (dryRun && replied > 0) {
    logger.info({ replied }, 'DRY_RUN: replies were composed and logged, not sent');
  }
  return { replied, declined };
}

async function settle(
  db: Db,
  tweetId: string,
  status: 'replied' | 'failed' | 'declined',
): Promise<void> {
  await db
    .update(inboundTweets)
    .set({ status, handledAt: new Date() })
    .where(eq(inboundTweets.tweetId, tweetId));
}

async function log(
  db: Db,
  action: string,
  status: string,
  reason: string | null,
  payload?: unknown,
): Promise<void> {
  await db.insert(actionLog).values({ action, status, reason, payload: (payload ?? null) as object });
}
