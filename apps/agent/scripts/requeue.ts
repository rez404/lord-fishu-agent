/**
 * Requeues mentions that were parked below the follower threshold.
 *
 *   pnpm --filter @fishnu/agent requeue 250      # revive everyone with 250+ followers
 *   pnpm --filter @fishnu/agent requeue 0        # revive everything that was parked
 *   pnpm --filter @fishnu/agent requeue 250 --dry
 *
 * This is the "deal with the rest later" lever: parked mentions keep their follower
 * count, so the bar can be moved after the fact instead of the backlog being lost.
 * It does not change the live threshold — set `reply_min_followers` in the settings
 * table for that, or the agent will simply park them again on the next tick.
 */
import { and, eq, sql } from 'drizzle-orm';
import { createDb, inboundTweets } from '@fishnu/db';
import { loadEnv } from '@fishnu/shared';

async function main() {
  const threshold = Number(process.argv[2]);
  const dry = process.argv.includes('--dry');

  if (!Number.isInteger(threshold) || threshold < 0) {
    console.error('usage: requeue <minFollowers> [--dry]');
    process.exit(1);
  }

  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const match = and(
    eq(inboundTweets.status, 'skipped_low_reach'),
    sql`coalesce(${inboundTweets.authorFollowers}, 0) >= ${threshold}`,
  );

  if (dry) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(inboundTweets).where(match);
    console.log(`${row?.n ?? 0} parked mention(s) have >= ${threshold} followers`);
    process.exit(0);
  }

  const revived = await db
    .update(inboundTweets)
    .set({ status: 'pending', handledAt: null })
    .where(match)
    .returning({ tweetId: inboundTweets.tweetId });

  console.log(`requeued ${revived.length} mention(s) with >= ${threshold} followers`);

  const live = await db
    .select({ value: sql<unknown>`value` })
    .from(sql`settings`)
    .where(sql`key = 'reply_min_followers'`);
  const liveThreshold = Number(live[0]?.value ?? env.REPLY_MIN_FOLLOWERS);
  if (liveThreshold > threshold) {
    console.warn(
      `warning: the live threshold is still ${liveThreshold}, so the agent will park these again.\n` +
        `         update settings.reply_min_followers to ${threshold} to actually answer them.`,
    );
  }

  process.exit(0);
}

void main();
