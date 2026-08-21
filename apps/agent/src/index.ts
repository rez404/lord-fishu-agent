import Redis from 'ioredis';
import { createDb } from '@fishnu/db';
import { inSleepWindow, jitter, loadEnv, logger, sleep } from '@fishnu/shared';
import { runTick } from './jobs/respond.js';
import { OpenAiProvider } from './llm/openai.js';
import { currentMood } from './mind/mood.js';
import { QuotaManager } from './quota/manager.js';
import { CursorStore } from './runtime/cursors.js';
import { startHealthServer, type HealthState } from './runtime/health.js';
import { withLock } from './runtime/lock.js';
import { SettingsStore } from './runtime/settings.js';
import { OfficialXClient } from './x/official.js';

const TICK_LOCK_KEY = 'fishnu:tick';

async function main() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const quota = new QuotaManager(db, env);
  const settingsStore = new SettingsStore(db, env);
  const cursors = new CursorStore(db);
  const x = new OfficialXClient(env, quota);

  const llm = new OpenAiProvider({
    apiKey: env.OPENAI_API_KEY,
    models: {
      voice: env.OPENAI_MODEL_VOICE,
      critic: env.OPENAI_MODEL_CRITIC,
      triage: env.OPENAI_MODEL_TRIAGE,
      reflect: env.OPENAI_MODEL_REFLECT,
    },
    embedModel: env.OPENAI_MODEL_EMBED,
  });

  const state: HealthState = { startedAt: new Date(), lastTickAt: null, lastTickError: null, ticks: 0 };
  const health = startHealthServer(Number(process.env.PORT ?? 8080), state, quota);

  const me = await x.me();
  if (me.id !== env.X_USER_ID) {
    throw new Error(`X_USER_ID (${env.X_USER_ID}) does not match the authenticated account (${me.id}/@${me.username})`);
  }
  logger.info(
    { account: `@${me.username}`, dryRun: env.DRY_RUN, minFollowers: await settingsStore.replyMinFollowers() },
    'Lord Fishnu is awake',
  );

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
    await sleep(jitter(env.TICK_INTERVAL_MS, env.TICK_JITTER_MS));
  }

  health.close();
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
          dryRun,
          minFollowers,
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
