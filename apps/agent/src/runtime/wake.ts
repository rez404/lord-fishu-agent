import Redis from 'ioredis';
import { logger } from '@fishnu/shared';

export const WAKE_CHANNEL = 'fishnu:wake';

/**
 * Lets something outside the agent cut a tick short.
 *
 * The loop normally sleeps for minutes between ticks, which is right for everything it
 * does on its own initiative — but an operator who has just told him a token went live
 * should not watch a spinner for five minutes. Publishing to the wake channel ends the
 * current sleep and the next tick starts immediately.
 *
 * A dedicated connection: a Redis client in subscriber mode cannot issue ordinary
 * commands, so this must not share the one the tick lock uses.
 */
export class Waker {
  private readonly sub: Redis;
  private waiters: Array<() => void> = [];

  constructor(redisUrl: string) {
    this.sub = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    void this.sub.subscribe(WAKE_CHANNEL).catch((err) => {
      // Losing the wake channel costs latency, never correctness — the loop still ticks.
      logger.warn({ err }, 'could not subscribe to the wake channel; impulses will wait for the next tick');
    });
    this.sub.on('message', (channel) => {
      if (channel !== WAKE_CHANNEL) return;
      const waiting = this.waiters;
      this.waiters = [];
      for (const resolve of waiting) resolve();
    });
  }

  /** Resolves after `ms`, or as soon as someone publishes to the channel. */
  async sleep(ms: number): Promise<'timeout' | 'woken'> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (how: 'timeout' | 'woken') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(how);
      };
      const timer = setTimeout(() => finish('timeout'), ms);
      this.waiters.push(() => finish('woken'));
    });
  }

  async close(): Promise<void> {
    await this.sub.quit().catch(() => {});
  }
}
