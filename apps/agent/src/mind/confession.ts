import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { confessions } from '@fishnu/db';

export interface Confession {
  id: number;
  body: string;
  handle: string | null;
}

/**
 * The oldest thing a visitor has left that he has not looked at.
 *
 * Confessions fill a scheduled slot rather than creating one. That is the whole design:
 * however many people write in, the posting rate is unchanged. Letting them jump the queue
 * would mean a busy day turns into a wall of posts, which is exactly what an automated
 * account looks like.
 */
export async function pendingConfession(db: Db): Promise<Confession | null> {
  const [row] = await db
    .select({ id: confessions.id, body: confessions.body, handle: confessions.handle })
    .from(confessions)
    .where(eq(confessions.status, 'pending'))
    .orderBy(asc(confessions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function closeConfession(
  db: Db,
  id: number,
  status: 'answered' | 'ignored',
  postId?: number,
): Promise<void> {
  await db
    .update(confessions)
    .set({ status, answeredPostId: postId ?? null })
    .where(and(eq(confessions.id, id), eq(confessions.status, 'pending')));
}
