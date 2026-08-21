import { eq } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { settings } from '@fishnu/db';
import type { Env } from '@fishnu/shared';

const CACHE_TTL_MS = 10_000;

/**
 * Runtime settings, DB-backed so the admin panel can flip them without a deploy.
 *
 * The kill switch is the only thing standing between a fully autonomous agent and a
 * bad night, so it is checked at the top of every tick and cached for a few seconds
 * at most.
 */
export class SettingsStore {
  private cache = new Map<string, { value: unknown; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly env: Env,
  ) {}

  async killSwitchEngaged(): Promise<boolean> {
    if (this.env.KILL_SWITCH) return true; // env wins: a boot-time hard stop
    return (await this.get<boolean>('kill_switch')) === true;
  }

  async dryRun(): Promise<boolean> {
    if (this.env.DRY_RUN) return true;
    return (await this.get<boolean>('dry_run')) === true;
  }

  /**
   * Unlike the kill switch, this is a tuning knob rather than a safety brake, so the
   * database wins over the environment: the bar can be moved from the admin panel
   * without a redeploy.
   */
  async replyMinFollowers(): Promise<number> {
    const override = await this.get<number>('reply_min_followers');
    return typeof override === 'number' && override >= 0 ? override : this.env.REPLY_MIN_FOLLOWERS;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;

    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    const value = row?.value as T | undefined;
    this.cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value: value as object, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: value as object, updatedAt: new Date() } });
    this.cache.delete(key);
  }
}
