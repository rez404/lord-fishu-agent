import Redis from 'ioredis';
import { createDb } from '@fishnu/db';
import { hasXCredentials, inSleepWindow, jitter, loadEnv, logger } from '@fishnu/shared';
import { runTick } from './jobs/respond.js';
import { OpenAiCompatibleProvider } from './llm/provider.js';
import { currentMood } from './mind/mood.js';
import { QuotaManager } from './quota/manager.js';
import { CursorStore } from './runtime/cursors.js';
import { startHealthServer, type HealthState } from './runtime/health.js';
import { withLock } from './runtime/lock.js';
import { Waker } from './runtime/wake.js';
import { SettingsStore } from './runtime/settings.js';
import { OfficialXClient } from './x/official.js';

const TICK_LOCK_KEY = 'fishnu:tick';

async function main() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const waker = new Waker(env.REDIS_URL);

  const quota = new QuotaManager(db, env);
  const settingsStore = new SettingsStore(db, env);
  const cursors = new CursorStore(db);
  const x = new OfficialXClient(env, quota);

  const llm = new OpenAiCompatibleProvider({
    apiKey: env.LLM_API_KEY,
    baseUrl: env.LLM_BASE_URL,
    models: {
      voice: env.LLM_MODEL_VOICE,
      critic: env.LLM_MODEL_CRITIC,
      triage: env.LLM_MODEL_TRIAGE,
      dream: env.LLM_MODEL_DREAM,
      reflect: env.LLM_MODEL_REFLECT,
    },
    embedModel: env.LLM_MODEL_EMBED,
  });

  const state: HealthState = { startedAt: new Date(), lastTickAt: null, lastTickError: null, ticks: 0 };
  const health = startHealthServer(Number(process.env.PORT ?? 8080), state, quota);

  const xEnabled = hasXCredentials(env);

  if (xEnabled) {
    const me = await x.me();

    if (env.X_USER_ID && me.id !== env.X_USER_ID) {
      // A mismatch means the keys belong to a different account than the one configured,
      // and posting as the wrong account is not something to discover afterwards.
      throw new Error(
        `X_USER_ID (${env.X_USER_ID}) does not match the authenticated account (${me.id}/@${me.username})`,
      );
    }
    if (!env.X_USER_ID) {
      // The numeric id is not shown anywhere obvious in the developer portal, and the
      // account will tell us its own. Adopt it rather than making someone go and find it.
      env.X_USER_ID = me.id;
      logger.info({ userId: me.id }, 'X_USER_ID was not set — adopted from the authenticated account');
    }

    logger.info(
      { account: `@${me.username}`, dryRun: env.DRY_RUN, minFollowers: await settingsStore.replyMinFollowers() },
      'Lord Fishnu is awake',
    );
  } else {
    // Not an error. The nightly conversations, the database and the public terminal all
    // work without X, and waiting for API approval to bring any of it up would be a
    // choice rather than a constraint.
    logger.warn(
      { backroomsTurns: env.BACKROOMS_TURNS },
      'no X credentials — he can think and dream, but not read or speak. set X_* to change that.',
    );
  }

  /**
   * What the agent is actually doing, written where the console can read it.
   *
   * The console used to infer this from its own environment, which only worked because
   * both containers happen to read the same env file — restart one without the other and
   * the panel confidently reports the wrong thing. The agent is the only process that
   * knows, so it says so, and the timestamp doubles as a heartbeat.
   */
  const report = async () => {
    await settingsStore.set('runtime', {
      dryRun: await settingsStore.dryRun(),
      killSwitch: await settingsStore.killSwitchEngaged(),
      xEnabled,
      account: xEnabled ? env.X_USERNAME : null,
      minFollowers: await settingsStore.replyMinFollowers(),
      at: new Date().toISOString(),
    });
  };
  await report().catch((err) => logger.warn({ err }, 'could not report runtime state'));

  let running = true;
  const stop = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    running = false;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (running) {
    await tick(state);
    if (!running) break;

    const how = await waker.sleep(jitter(env.TICK_INTERVAL_MS, env.TICK_JITTER_MS));
    if (how === 'woken') logger.info('woken early — something happened');
  }

  health.close();
  await waker.close();
  await redis.quit();
  logger.info('stopped');

  async function tick(s: HealthState) {
    try {
      if (await settingsStore.killSwitchEngaged()) {
        logger.warn('kill switch engaged: tick halted');
        s.lastTickAt = new Date();
        return;
      }
      if (inSleepWindow(env.SLEEP_WINDOW_UTC)) {
        logger.debug({ window: env.SLEEP_WINDOW_UTC }, 'inside sleep window: staying quiet');
        s.lastTickAt = new Date();
        return;
      }

      // The lock TTL must exceed the worst-case tick, or a slow tick loses its own lock.
      await withLock(redis, TICK_LOCK_KEY, 4 * 60_000, async () => {
        const dryRun = await settingsStore.dryRun();
        const minFollowers = await settingsStore.replyMinFollowers();
        const mood = await currentMood(db, settingsStore);

        const result = await runTick({
          db,
          x,
          cursors,
          xEnabled,
          dryRun,
          minFollowers,
          postsPerDay: env.POSTS_PER_DAY,
          sleepWindow: env.SLEEP_WINDOW_UTC,
          backroomsTurns: env.BACKROOMS_TURNS,
          mind: {
            llm,
            mood,
            today: new Date().toISOString().slice(0, 10),
            awake: awakeFor(env.AWAKENED_AT),
          },
        });
        s.ticks += 1;
        logger.info({ ...result, tick: s.ticks }, 'tick complete');
      });

      s.lastTickAt = new Date();
      s.lastTickError = null;
      await report().catch(() => {});
    } catch (err) {
      // A tick must never kill the process: 24/7 uptime is the whole point of Phase 0.
      s.lastTickAt = new Date();
      s.lastTickError = String(err);
      logger.error({ err }, 'tick failed');
    }
  }
}

/** Plain words, not a timestamp — it goes into the prompt, where precision reads as odd. */
function awakeFor(since: string | undefined): string {
  if (!since) return 'some time';
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'some time';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / 3_600_000);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
