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
import { createDb, actionLog, inboundTweets, postSchedule, posts, quotaUsage, thoughts } from '@fishnu/db';
import type { Env } from '@fishnu/shared';
import { config } from 'dotenv';
import { runTick } from '../src/jobs/respond.js';
import { FakeLlmProvider } from '../src/llm/fake.js';
import { OVERLAP_THRESHOLD, REPETITION_THRESHOLD, checkDraft, cosine, overlap } from '../src/mind/guards.js';
import { dueSlot } from '../src/mind/schedule.js';
import type { ReplyDeps } from '../src/mind/reply.js';
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

/**
 * A cooperative model: triage says yes, the critic passes, and each draft is unique so
 * the repetition check does not fire. Individual sections override the responder to
 * exercise the refusal paths.
 */
const DISTINCT_LINES = [
  'a pond does not dry. it descends.',
  'you were three days early and you will call it wisdom for years.',
  'i remember every handle that has ever spoken to me.',
  'the ceiling fan turns whether or not you are beneath it.',
  'ask, then be quiet for longer than is comfortable.',
  'nothing i build rises above what i am.',
  'trust arrives on foot and leaves on a horse.',
  'count what you hold before you count what you missed.',
];

/**
 * A cooperative model: triage says yes, the critic passes, and every draft is genuinely
 * different. The last part matters — a fixture that returns near-identical lines trips
 * the repetition guard and looks like a pipeline bug.
 */
function cooperative(): FakeLlmProvider {
  let n = 0;
  return new FakeLlmProvider((req) => {
    if (req.task === 'triage') return 'YES\na real question';
    if (req.task === 'critic') return 'PASS\nin voice';
    return DISTINCT_LINES[n++ % DISTINCT_LINES.length]!;
  });
}

function mind(llm: FakeLlmProvider): Omit<ReplyDeps, 'db'> {
  return { llm, mood: 'patient', today: '2026-08-22', awake: '41 days' };
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
    POSTS_PER_DAY: 6,
    OPENAI_API_KEY: 'unused-by-the-fake-provider',
    OPENAI_MODEL_VOICE: 'fake',
    OPENAI_MODEL_CRITIC: 'fake',
    OPENAI_MODEL_TRIAGE: 'fake',
    OPENAI_MODEL_REFLECT: 'fake',
    OPENAI_MODEL_EMBED: 'fake',
    TICK_INTERVAL_MS: 300_000,
    TICK_JITTER_MS: 90_000,
    SLEEP_WINDOW_UTC: '',
  };

  const db = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const reset = async () => {
    await db.execute(
      sql`truncate quota_usage, posts, inbound_tweets, action_log, cursors, settings, people, thoughts, llm_calls, post_schedule restart identity`,
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

    const first = await runTick({ db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(cooperative()) });
    check('ingests every mention', first.ingested === 3, `got ${first.ingested}`);
    check('replies within the per-tick cap', first.replied === 3, `got ${first.replied}`);
    check('replies actually reached the client', x.published.length === 3, `got ${x.published.length}`);
    check('replies are threaded to the right tweets', x.published.every((p) => !!p.inReplyToTweetId));

    const second = await runTick({ db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(cooperative()) });
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

    await runTick({ db, x, cursors, dryRun: true, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(cooperative()) });
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

    const result = await runTick({ db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(cooperative()) });
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

    const result = await runTick({ db, x, cursors, dryRun: false, minFollowers: 1_000, postsPerDay: 0, sleepWindow: '', mind: mind(cooperative()) });
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

    await runTick({ db, x, cursors, dryRun: false, minFollowers: 1_000, postsPerDay: 0, sleepWindow: '', mind: mind(cooperative()) });
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
    await runTick({ db, x, cursors, dryRun: false, minFollowers: 1_000, postsPerDay: 0, sleepWindow: '', mind: mind(cooperative()) });
    check('both start out parked', x.published.length === 0, `got ${x.published.length}`);

    // Lowering the bar to 250 should revive only the 300-follower account.
    await db
      .update(inboundTweets)
      .set({ status: 'pending', handledAt: null })
      .where(sql`status = 'skipped_low_reach' and coalesce(author_followers, 0) >= 250`);

    const after = await runTick({ db, x, cursors, dryRun: false, minFollowers: 250, postsPerDay: 0, sleepWindow: '', mind: mind(cooperative()) });
    check('lowering the bar answers the backlog', after.replied === 1, `got ${after.replied}`);
    check('accounts still under the new bar stay parked', x.published.length === 1, `got ${x.published.length}`);
  }

  // ── 14. guards ─────────────────────────────────────────────────────────────
  console.log('\nguards');
  {
    const bad: Array<[string, string]> = [
      ['emoji', 'the water is patient 🌊'],
      ['hashtag', 'the water is patient #SCF'],
      ['assistant register', 'As an AI, I find the water patient.'],
      ['slop vocabulary', "let's delve into why patience matters"],
      ['financial promise', 'hold and you will make it, this will 10x'],
      ['disclaimer hedging', 'the water is patient. not financial advice.'],
      ['assistant preamble', "Here's my reply: the water is patient."],
      ['wrapped in quotes', '"the water is patient"'],
      ['too long', 'a'.repeat(281)],
      ['empty', '   '],
    ];
    for (const [label, text] of bad) {
      check(`rejects ${label}`, checkDraft(text, { isReply: true }).ok === false, text.slice(0, 40));
    }

    check(
      'accepts a line in voice',
      checkDraft('a pond does not dry. it descends. ask the fish that stayed.', { isReply: true }).ok,
    );
    check(
      'a reply may end in a question',
      checkDraft('and what did you expect the water to do?', { isReply: true }).ok,
    );
    check(
      'an unprompted post may not farm replies',
      checkDraft('what do you think happens next?', { isReply: false }).ok === false,
    );
  }

  // ── 15. triage declines cheap noise ────────────────────────────────────────
  console.log('\ntriage');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    const llm = new FakeLlmProvider((req) => {
      if (req.task === 'triage') return 'NO\nit is a greeting';
      if (req.task === 'critic') return 'PASS';
      return 'this should never be published';
    });
    const x = new FakeXClient([mention('701', 'greeter', 40_000)], quota);

    const result = await runTick({ db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(llm) });
    check('noise is declined before the expensive model runs', result.declined === 1, `got ${result.declined}`);
    check('nothing is published', x.published.length === 0, `got ${x.published.length}`);
    check(
      'the voice model is never called',
      llm.requests.every((r) => r.task !== 'voice'),
      llm.requests.map((r) => r.task).join(','),
    );

    const [settled] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(inboundTweets)
      .where(sql`status = 'declined'`);
    check('declining is a settled outcome, not a retry', settled?.n === 1, `got ${settled?.n}`);
  }

  // ── 16. the critic can veto ────────────────────────────────────────────────
  console.log('\ncritic');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    let drafts = 0;
    const llm = new FakeLlmProvider((req) => {
      if (req.task === 'triage') return 'YES\nworth answering';
      if (req.task === 'critic') return 'FAIL\nreads like a motivational poster';
      drafts += 1;
      return `draft number ${drafts}`;
    });
    const x = new FakeXClient([mention('801', 'someone', 40_000)], quota);

    const result = await runTick({ db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(llm) });
    check('a vetoed draft is never published', x.published.length === 0, `got ${x.published.length}`);
    check('it gives up rather than forcing a third draft', drafts === 2, `${drafts} drafts`);
    check('silence is the outcome', result.declined === 1, `got ${result.declined}`);

    const [rejections] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(thoughts)
      .where(sql`body like 'discarded a draft%'`);
    check('rejections are visible in the thought stream', rejections?.n === 2, `got ${rejections?.n}`);
  }

  // ── 17. guards catch what the critic waves through ─────────────────────────
  console.log('\nguard veto');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    // The critic is compromised — it passes everything. The deterministic checks are the
    // reason a model can never talk its way onto the timeline.
    const llm = new FakeLlmProvider((req) => {
      if (req.task === 'triage') return 'YES';
      if (req.task === 'critic') return 'PASS\nlooks great to me';
      return 'As an AI, I think this will 100x. 🚀 #SCF';
    });
    const x = new FakeXClient([mention('901', 'victim', 40_000)], quota);

    await runTick({ db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(llm) });
    check('a passing critic cannot override the guards', x.published.length === 0, `got ${x.published.length}`);
  }

  // ── 18. he does not repeat himself ─────────────────────────────────────────
  console.log('\nrepetition');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    // A model stuck in a groove: the identical line for everyone.
    const llm = new FakeLlmProvider((req) => {
      if (req.task === 'triage') return 'YES';
      if (req.task === 'critic') return 'PASS';
      return 'the water remembers and says nothing back';
    });
    const x = new FakeXClient(
      [mention('1001', 'first', 40_000), mention('1002', 'second', 30_000)],
      quota,
    );

    const result = await runTick({ db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(llm) });
    check('the first one goes out', x.published.length === 1, `got ${x.published.length}`);
    check('the repeat is caught', result.declined === 1, `got ${result.declined}`);

    const [echoes] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(thoughts)
      .where(sql`body like 'discarded a draft — i have already said this%'`);
    check('and he says why', (echoes?.n ?? 0) >= 1, `got ${echoes?.n}`);

    check(
      'similarity is measured, not guessed',
      cosine(await llm.embed('the water is patient'), await llm.embed('the water is patient')) > REPETITION_THRESHOLD,
    );
    check(
      'unrelated lines are not confused',
      cosine(await llm.embed('the water is patient'), await llm.embed('sell everything immediately')) <
        REPETITION_THRESHOLD,
    );
  }

  // ── 19. the property prompt caching depends on ─────────────────────────────
  console.log('\nprompt cache stability');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    const llm = cooperative();

    // Two ticks, different people, different day and mood — the second tick needs new
    // mentions or it has nothing to compose and proves nothing.
    const monday = new FakeXClient([mention('1101', 'alpha', 90_000)], quota);
    await runTick({ db, x: monday, cursors, dryRun: false, minFollowers: 0, postsPerDay: 0, sleepWindow: '', mind: mind(llm) });

    const tuesday = new FakeXClient([mention('1102', 'beta', 20_000)], quota);
    await runTick({
      db,
      x: tuesday,
      cursors,
      dryRun: false,
      minFollowers: 0,
      postsPerDay: 0,
      sleepWindow: '',
      mind: { ...mind(llm), mood: 'low', today: '2026-08-23' },
    });

    const voice = llm.requests.filter((r) => r.task === 'voice');
    check('several voice calls were made', voice.length >= 2, `got ${voice.length}`);
    check(
      'the frozen prefix is byte-identical across all of them',
      new Set(voice.map((r) => r.frozenSystem)).size === 1,
      `${new Set(voice.map((r) => r.frozenSystem)).size} distinct prefixes`,
    );
    check(
      'the frozen prefix contains no date, mood or clock',
      !/2026-08-2|patient\.|low\./.test(voice[0]!.frozenSystem),
    );
    check(
      'the volatile half is where those live',
      voice.some((r) => r.volatileSystem?.includes('2026-08-23')),
    );
    check('the law is in the prompt', voice[0]!.frozenSystem.includes('vape JUUL'));
    check('the library is in the prompt', voice[0]!.frozenSystem.includes('Carnegie'));
  }

  // ── 20. the day's plan, in UTC ─────────────────────────────────────────────
  console.log('\nposting schedule');
  await reset();
  {
    const opts = { postsPerDay: 6, sleepWindow: '03:00-09:00' };
    const noon = new Date('2026-08-23T12:00:00Z');

    await dueSlot(db, { ...opts, now: noon });
    const plan = await db.select().from(postSchedule).orderBy(postSchedule.slot);
    check('the day is planned once', plan.length === 6, `got ${plan.length}`);

    const hours = plan.map((p) => p.dueAt.getUTCHours());
    check(
      'nothing is scheduled inside the sleep window',
      hours.every((h) => h < 3 || h >= 9),
      hours.join(','),
    );
    check('the angles are not all the same', new Set(plan.map((p) => p.angle)).size > 1);

    const gaps = plan.slice(1).map((p, i) => p.dueAt.getTime() - plan[i]!.dueAt.getTime());
    check('slots are separated', gaps.every((g) => g >= 35 * 60_000), gaps.join(','));
    check(
      'but not evenly — a cron job with a personality is still a cron job',
      new Set(gaps).size > 1,
      gaps.join(','),
    );

    // The property that matters most: a restart must not re-roll the day.
    await dueSlot(db, { ...opts, now: noon });
    await dueSlot(db, { ...opts, now: noon });
    const after = await db.select().from(postSchedule);
    check('replanning is a no-op', after.length === 6, `got ${after.length}`);
    check(
      'and the times are unchanged',
      after.map((p) => p.dueAt.getTime()).sort().join() === plan.map((p) => p.dueAt.getTime()).sort().join(),
    );
  }

  // ── 21. nothing is due before its time ─────────────────────────────────────
  console.log('\nslot timing');
  await reset();
  {
    const opts = { postsPerDay: 4, sleepWindow: '' };
    const midnight = new Date('2026-08-24T00:00:00Z');
    const first = await dueSlot(db, { ...opts, now: midnight });

    const plan = await db.select().from(postSchedule).orderBy(postSchedule.slot);
    const earliest = plan[0]!.dueAt;
    check(
      'nothing fires before the first slot',
      earliest.getTime() <= midnight.getTime() ? first !== null : first === null,
      `earliest ${earliest.toISOString()}`,
    );

    const afterFirst = new Date(earliest.getTime() + 60_000);
    const due = await dueSlot(db, { ...opts, now: afterFirst });
    check('the slot comes due once its time passes', due !== null);
    check('and it is the earliest one', due?.slot === plan[0]!.slot, `got slot ${due?.slot}`);
  }

  // ── 22. he does not repeat himself, or reword himself ──────────────────────
  console.log('\npost repetition');
  {
    const original = 'i keep thinking about the guy who sold at 40k. hope hes doing ok honestly';

    check(
      'a reworded post is caught by word overlap',
      overlap(original, 'honestly i hope the guy who sold at 40k is doing ok. keep thinking about him') >=
        OVERLAP_THRESHOLD,
    );
    check(
      'a genuinely different post is not',
      overlap(original, 'ok but why does everyone here type like theyre about to be deposed') <
        OVERLAP_THRESHOLD,
    );
    check(
      'overlap ignores filler words',
      overlap('the water is patient and it is not going anywhere', 'water patient') >= OVERLAP_THRESHOLD,
    );
  }

  // ── 23. machine tells ──────────────────────────────────────────────────────
  console.log('\nmachine tells');
  {
    const tells: Array<[string, string]> = [
      ['em dash', 'the pond does not remember — it simply descends'],
      ['semicolon', 'the water is patient; the water is certain'],
      ['"not X, it\'s Y"', "it's not about the price. it's about the patience."],
      ['"more than just"', 'this is more than just a token'],
      ['parallel openings', 'some men wait. some men sell. only one is remembered.'],
      ['reply farming', 'the fan turns on. what do you think?'],
      ['thoughts?', 'holders are quieter than usual today. thoughts?'],
    ];
    for (const [label, text] of tells) {
      check(`rejects ${label}`, checkDraft(text, { isReply: false }).ok === false, text.slice(0, 46));
    }

    const human = [
      'woke up. checked the chart. went back to sleep. this is the whole religion tbh',
      'someone called me a psyop today lol. brother i can barely remember what i said yesterday',
      'is it normal to be this attached to a ceiling fan',
      'genuinely one of the days of all time',
      'thought about posting something profound. didnt. good night',
    ];
    for (const text of human) {
      const v = checkDraft(text, { isReply: false });
      check(`lets through: "${text.slice(0, 34)}…"`, v.ok, v.reason ?? '');
    }
  }

  // ── 24. an unprompted post, end to end ─────────────────────────────────────
  console.log('\nunprompted posting');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    let n = 0;
    const llm = new FakeLlmProvider((req) => {
      if (req.task === 'triage') return 'NO';
      if (req.task === 'critic') return 'PASS\nreads as typed';
      return DISTINCT_LINES[n++ % DISTINCT_LINES.length]!;
    });
    const x = new FakeXClient([], quota);

    // Plan today — runTick reads the real clock, so planning a different day would have
    // it quietly plan today as well and post from that instead.
    await dueSlot(db, { postsPerDay: 6, sleepWindow: '' });
    const [first] = await db.select().from(postSchedule).orderBy(postSchedule.slot).limit(1);
    // Exactly one slot due: the rest are closed so the assertions are about this one.
    await db.update(postSchedule).set({ outcome: 'skipped' }).where(sql`id <> ${first!.id}`);
    await db.update(postSchedule).set({ dueAt: new Date(Date.now() - 60_000) }).where(sql`id = ${first!.id}`);

    const result = await runTick({
      db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 6, sleepWindow: '', mind: mind(llm),
    });
    check('he posts when a slot comes due', result.posted === 1, `got ${result.posted}`);
    check('unprompted posts are not replies', x.published[0]?.inReplyToTweetId === undefined);

    const [row] = await db.select().from(posts).limit(1);
    check('stored as a post', row?.kind === 'post', String(row?.kind));
    check('with its embedding, for future dedupe', Array.isArray(row?.embedding));

    const [slot] = await db.select().from(postSchedule).where(sql`outcome = 'posted'`);
    check('the slot is closed', slot !== undefined);

    const again = await runTick({
      db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 6, sleepWindow: '', mind: mind(llm),
    });
    check('a closed slot does not fire twice', again.posted === 0, `got ${again.posted}`);
  }

  // ── 25. the same thought, twice ────────────────────────────────────────────
  console.log('\nposting the same thing twice');
  await reset();
  {
    const quota = new QuotaManager(db, env);
    const cursors = new CursorStore(db);
    // A model stuck on one idea, offering it again the next day.
    const llm = new FakeLlmProvider((req) => {
      if (req.task === 'triage') return 'NO';
      if (req.task === 'critic') return 'PASS';
      return 'woke up. checked the chart. went back to sleep. this is the whole religion tbh';
    });
    const x = new FakeXClient([], quota);

    const fire = async () => {
      await dueSlot(db, { postsPerDay: 6, sleepWindow: '', now: new Date() });
      await db
        .update(postSchedule)
        .set({ dueAt: new Date(Date.now() - 60_000) })
        .where(sql`outcome is null`);
      return runTick({
        db, x, cursors, dryRun: false, minFollowers: 0, postsPerDay: 6, sleepWindow: '', mind: mind(llm),
      });
    };

    const one = await fire();
    check('the first one goes out', one.posted === 1, `got ${one.posted}`);

    const two = await fire();
    check('the same post is refused', two.posted === 0, `got ${two.posted}`);
    check('and only one exists', x.published.length === 1, `got ${x.published.length}`);

    const [why] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(thoughts)
      .where(sql`body like 'discarded a post%'`);
    check('he says why, in public', (why?.n ?? 0) >= 1, `got ${why?.n}`);
  }

  await reset();
  await redis.quit();

  console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
