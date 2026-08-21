import type Redis from 'ioredis';
import { logger } from '@fishnu/shared';

const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Two agent workers means duplicate posts, and during a rolling deploy two workers is
 * the normal case, not the exception. Every tick runs inside this lock; if another
 * instance holds it, this one skips the tick rather than queuing behind it.
 */
export async function withLock<T>(
  redis: Redis,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (!acquired) {
    logger.debug({ key }, 'tick skipped: lock held by another instance');
    return null;
  }

  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE, 1, key, token).catch((err) => {
      logger.warn({ err, key }, 'failed to release lock; it will expire on its own');
    });
  }
}
