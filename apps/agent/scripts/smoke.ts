/**
 * Phase 0 verification harness.
 *
 * Exercises the whole backbone — quota ledger, degraded mode, tick lock, kill switch,
 * cursor resumption, and the ingest→reply→audit pipe — against a real Postgres and Redis
 * but a fake X client, so it can run without burning API quota.
 *
 *   pnpm --filter @fishnu/agent smoke
 */
import Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import { createDb, actionLog, inboundTweets, posts, quotaUsage } from '@fishnu/db';
import type { Env } from '@fishnu/shared';
import { config } from 'dotenv';
import { runEchoTick } from '../src/jobs/echo.js';
import { QuotaExceededError, QuotaManager } from '../src/quota/manager.js';
import { CursorStore } from '../src/runtime/cursors.js';
import { withLock } from '../src/runtime/lock.js';
import { SettingsStore } from '../src/runtime/settings.js';
import type { ReadPage, XClient, XPublishResult, XTweet, XUser } from '../src/x/types.js';

config({ path: '../../.env' });

let failures = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

/** A fake X that spends no quota of its own — the QuotaManager is driven directly. */
class FakeXClient implements XClient {
  published: Array<{ text: string; inReplyToTweetId?: string }> = [];
  private seq = 0;

  constructor(
    private readonly mentions: XTweet[],
    private readonly quota: QuotaManager,
    private readonly failOn?: string,
  ) {}

  async me(): Promise<XUser> {
    return { id: '1', username: 'lordfishnu' };
  }

  async fetchMentions({ sinceId, max }: { sinceId?: string; max: number }): Promise<ReadPage<XTweet>> {
    const grant = await this.quota.consume('read', 'mentions', 'GET /2/users/:id/mentions', Math.max(5, max));
    const items = this.mentions.filter((m) => !sinceId || m.id > sinceId).slice(0, grant.granted);
    await this.quota.reconcile(grant, items.length);
    return { items, newestId: items.at(-1)?.id, consumed: items.length };
  }

  async searchRecent(): Promise<ReadPage<XTweet>> {
    return { items: [], consumed: 0 };
  }

  async fetchUserTweets(): Promise<ReadPage<XTweet>> {
    return { items: [], consumed: 0 };
  }

  async publish({ text, inReplyToTweetId }: { text: string; inReplyToTweetId?: string }): Promise<XPublishResult> {
    await this.quota.consume('write', inReplyToTweetId ? 'reply' : 'post', 'POST /2/tweets', 1);
    if (this.failOn && inReplyToTweetId === this.failOn) {
      throw new Error('simulated X failure (tweet deleted)');
    }
    this.published.push({ text, inReplyToTweetId });
    return { tweetId: `pub-${++this.seq}`, dryRun: false };
  }

  async like(): Promise<void> {}
  async follow(): Promise<void> {}
}

/** Pass `null` for followers to simulate X withholding the user object. */
function mention(id: string, username: string, followers: number | null = 5_000): XTweet {
  return {
    id,
    authorId: `u-${username}`,
    authorUsername: username,
    authorFollowers: followers ?? undefined,
    text: `hey @lordfishnu ${id}`,
    createdAt: new Date(),
  };
}

async function main() {
  const env: Env = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DRY_RUN: false,
    KILL_SWITCH: false,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://fishnu:fishnu@localhost:5433/fishnu',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380',
    X_APP_KEY: 'x',
    X_APP_SECRET: 'x',
    X_ACCESS_TOKEN: 'x',
    X_ACCESS_SECRET: 'x',
    X_USER_ID: '1',
    X_USERNAME: 'lordfishnu',
    QUOTA_MONTHLY_READS: 15_000,
    QUOTA_MONTHLY_WRITES: 3_000,
    QUOTA_DAILY_READS: 500,
    QUOTA_DAILY_WRITES: 100,
    REPLY_MIN_FOLLOWERS: 1_000,
    TICK_INTERVAL_MS: 300_000,
    TICK_JITTER_MS: 90_000,
    SLEEP_WINDOW_UTC: '',
  };

  const db = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const reset = async () => {
    await db.execute(
      sql`truncate quota_usage, posts, inbound_tweets, action_log, cursors, settings, people restart identity`,
    );
  };

  // ── 1. quota ledger reserves up front and reconciles down ──────────────────
  console.log('\nquota ledger');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const grant = await quota.consume('read', 'mentions', 'GET /2/users/:id/mentions', 25);
    check('reserves the full requested amount', grant.granted === 25, `got ${grant.granted}`);
    let snap = await quota.snapshot();
    check('ledger reflects the reservation before the call returns', snap.dayReads === 25, `got ${snap.dayReads}`);

    await quota.reconcile(grant, 3);
    snap = await quota.snapshot();
    check('reconciles down to what the call actually consumed', snap.dayReads === 3, `got ${snap.dayReads}`);
  }

  // ── 2. per-bucket read allocation ──────────────────────────────────────────
  console.log('\nread allocation');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cap = Math.floor(env.QUOTA_DAILY_READS * 0.3); // mentions bucket = 150
    for (let i = 0; i < cap / 50; i++) await quota.consume('read', 'mentions', 'e', 50);

    const partial = await quota.consume('read', 'search', 'e', 100);
    check('a different bucket still has its own budget', partial.granted === 100, `got ${partial.granted}`);

    let threw: unknown;
    try {
      await quota.consume('read', 'mentions', 'e', 10);
    } catch (err) {
      threw = err;
    }
    check('exhausted bucket refuses further reads', threw instanceof QuotaExceededError, String(threw));
  }

  // ── 3. partial grants ──────────────────────────────────────────────────────
  console.log('\npartial grants');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    await quota.consume('read', 'mentions', 'e', 140); // 10 left of 150
    const grant = await quota.consume('read', 'mentions', 'e', 100);
    check('asking for more than remains grants what is left', grant.granted === 10, `got ${grant.granted}`);
  }

  // ── 4. writes are indivisible and daily-capped ─────────────────────────────
  console.log('\nwrite budget');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    for (let i = 0; i < env.QUOTA_DAILY_WRITES; i++) await quota.consume('write', 'reply', 'POST /2/tweets', 1);
    let threw: unknown;
    try {
      await quota.consume('write', 'reply', 'POST /2/tweets', 1);
    } catch (err) {
      threw = err;
    }
    check('daily write cap is enforced', threw instanceof QuotaExceededError, String(threw));
  }

  // ── 5. degraded mode keeps mentions, drops discovery ───────────────────────
  console.log('\ndegraded mode');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    // Burn 90% of the month directly into the ledger.
    await db.insert(quotaUsage).values({
      kind: 'read',
      bucket: 'search',
      endpoint: 'seed',
      amount: Math.floor(env.QUOTA_MONTHLY_READS * 0.9),
      dayKey: '1970-01-01', // an old day: monthly pressure without spending today's budget
      monthKey: new Date().toISOString().slice(0, 7),
    });

    const snap = await quota.snapshot();
    check('snapshot reports degraded', snap.degraded, JSON.stringify(snap));

    let searchThrew: unknown;
    try {
      await quota.consume('read', 'search', 'e', 10);
    } catch (err) {
      searchThrew = err;
    }
    check('discovery is cut off', searchThrew instanceof QuotaExceededError, String(searchThrew));

    const mentions = await quota.consume('read', 'mentions', 'e', 10);
    check('mentions keep running', mentions.granted === 10, `got ${mentions.granted}`);
  }

  // ── 6. single-instance tick lock ───────────────────────────────────────────
  console.log('\ntick lock');
  {
    await redis.del('smoke:lock');
    let concurrent = 0;
    let maxConcurrent = 0;
    const worker = () =>
      withLock(redis, 'smoke:lock', 5_000, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 100));
        concurrent -= 1;
        return 'ran';
      });

    const [a, b] = await Promise.all([worker(), worker()]);
    check('only one holder at a time', maxConcurrent === 1, `max ${maxConcurrent}`);
    check('the loser skips rather than queues', [a, b].filter((r) => r === null).length === 1, `${a} / ${b}`);
    check('the lock is released afterwards', (await redis.get('smoke:lock')) === null);
  }

  // ── 7. kill switch ─────────────────────────────────────────────────────────
  console.log('\nkill switch');
  await reset();
  {
    const store = new SettingsStore(db, env);
    check('disengaged by default', (await store.killSwitchEngaged()) === false);
    await store.set('kill_switch', true);
    check('engages from the database without a deploy', (await store.killSwitchEngaged()) === true);

    const envForced = new SettingsStore(db, { ...env, KILL_SWITCH: true });
    await store.set('kill_switch', false);
    check('env value cannot be overridden from the database', (await envForced.killSwitchEngaged()) === true);
  }

  // ── 8. the ingest → reply → audit pipe ─────────────────────────────────────
  console.log('\necho tick');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    const x = new FakeXClient([mention('101', 'alice'), mention('102', 'bob'), mention('103', 'carol')], quota);

    const first = await runEchoTick({ db, x, cursors, dryRun: false, minFollowers: 0 });
    check('ingests every mention', first.ingested === 3, `got ${first.ingested}`);
    check('replies within the per-tick cap', first.replied === 3, `got ${first.replied}`);
    check('replies actually reached the client', x.published.length === 3, `got ${x.published.length}`);
    check('replies are threaded to the right tweets', x.published.every((p) => !!p.inReplyToTweetId));

    const second = await runEchoTick({ db, x, cursors, dryRun: false, minFollowers: 0 });
    check('the cursor prevents re-ingesting', second.ingested === 0, `got ${second.ingested}`);
    check('handled mentions are not answered twice', second.replied === 0, `got ${second.replied}`);

    const [postRow] = await db.select({ n: sql<number>`count(*)::int` }).from(posts);
    check('every reply is persisted', postRow?.n === 3, `got ${postRow?.n}`);

    const [handled] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(inboundTweets)
      .where(sql`status = 'replied'`);
    check('every mention is marked replied', handled?.n === 3, `got ${handled?.n}`);

    const snap = await quota.snapshot();
    check('the tick spent write quota', snap.dayWrites === 3, `got ${snap.dayWrites}`);
  }

  // ── 9. dry run writes nothing outward ──────────────────────────────────────
  console.log('\ndry run');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    // DRY_RUN lives in OfficialXClient, so this asserts the shape the job relies on:
    // the job persists whatever the client reports back.
    const x = new FakeXClient([mention('201', 'dave')], quota);
    x.publish = async ({ text, inReplyToTweetId }) => {
      x.published.push({ text, inReplyToTweetId });
      return { tweetId: null, dryRun: true };
    };

    await runEchoTick({ db, x, cursors, dryRun: true, minFollowers: 0 });
    const [row] = await db.select().from(posts).limit(1);
    check('dry-run posts are recorded as such', row?.dryRun === 'true', String(row?.dryRun));
    check('dry-run posts carry no tweet id', row?.tweetId === null, String(row?.tweetId));
  }

  // ── 10. a failing reply must not wedge the queue ───────────────────────────
  console.log('\nfailure handling');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    const x = new FakeXClient([mention('301', 'erin'), mention('302', 'frank')], quota, '301');

    const result = await runEchoTick({ db, x, cursors, dryRun: false, minFollowers: 0 });
    check('the healthy mention still gets a reply', result.replied === 1, `got ${result.replied}`);

    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(inboundTweets)
      .where(sql`status = 'pending'`);
    check('the failing mention is not retried forever', pending?.n === 0, `${pending?.n} left pending`);

    const [errors] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(actionLog)
      .where(sql`status = 'error'`);
    check('the failure is in the audit log', errors?.n === 1, `got ${errors?.n}`);
  }

  // ── 11. follower threshold ─────────────────────────────────────────────────
  console.log('\nfollower gate');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    const x = new FakeXClient(
      [
        mention('401', 'whale', 50_000),
        mention('402', 'nobody', 12),
        mention('403', 'midcurve', 1_000), // exactly at the bar: must pass
        mention('404', 'ghost', null), // follower count withheld by X
      ],
      quota,
    );

    const result = await runEchoTick({ db, x, cursors, dryRun: false, minFollowers: 1_000 });
    check('only accounts over the bar are answered', result.replied === 2, `got ${result.replied}`);
    check('the rest are parked, not dropped', result.parked === 2, `got ${result.parked}`);
    check(
      'the threshold is inclusive',
      x.published.some((p) => p.inReplyToTweetId === '403'),
      JSON.stringify(x.published.map((p) => p.inReplyToTweetId)),
    );
    check(
      'an unknown follower count is treated as zero',
      !x.published.some((p) => p.inReplyToTweetId === '404'),
    );

    const [parked] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(inboundTweets)
      .where(sql`status = 'skipped_low_reach'`);
    check('parked mentions are retained for later', parked?.n === 2, `got ${parked?.n}`);

    const [triage] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(actionLog)
      .where(sql`action = 'triage'`);
    check('triage is audited once per tick, not once per account', triage?.n === 1, `got ${triage?.n}`);
  }

  // ── 12. highest reach is answered first ────────────────────────────────────
  console.log('\nreach ordering');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    // Four eligible accounts, three reply slots: the smallest must be the one left over.
    const x = new FakeXClient(
      [
        mention('501', 'small', 1_200),
        mention('502', 'huge', 900_000),
        mention('503', 'big', 40_000),
        mention('504', 'medium', 8_000),
      ],
      quota,
    );

    await runEchoTick({ db, x, cursors, dryRun: false, minFollowers: 1_000 });
    check(
      'the biggest account is answered first',
      x.published[0]?.inReplyToTweetId === '502',
      JSON.stringify(x.published.map((p) => p.inReplyToTweetId)),
    );
    check(
      'the smallest waits for the next tick',
      !x.published.some((p) => p.inReplyToTweetId === '501'),
    );

    const [stillPending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(inboundTweets)
      .where(sql`status = 'pending'`);
    check('the overflow stays pending', stillPending?.n === 1, `got ${stillPending?.n}`);
  }

  // ── 13. requeueing parked mentions ─────────────────────────────────────────
  console.log('\nrequeue');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    const x = new FakeXClient([mention('601', 'tiny', 300), mention('602', 'dust', 5)], quota);
    await runEchoTick({ db, x, cursors, dryRun: false, minFollowers: 1_000 });
    check('both start out parked', x.published.length === 0, `got ${x.published.length}`);

    // Lowering the bar to 250 should revive only the 300-follower account.
    await db
      .update(inboundTweets)
      .set({ status: 'pending', handledAt: null })
      .where(sql`status = 'skipped_low_reach' and coalesce(author_followers, 0) >= 250`);

    const after = await runEchoTick({ db, x, cursors, dryRun: false, minFollowers: 250 });
    check('lowering the bar answers the backlog', after.replied === 1, `got ${after.replied}`);
    check('accounts still under the new bar stay parked', x.published.length === 1, `got ${x.published.length}`);
  }

  await reset();
  await redis.quit();

  console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
