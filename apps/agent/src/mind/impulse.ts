import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { impulses } from '@fishnu/db';

/** The oldest thing the operator has told him that he has not yet reacted to. */
export async function pendingImpulse(db: Db): Promise<{ id: number; body: string } | null> {
  const [row] = await db
    .select({ id: impulses.id, body: impulses.body })
    .from(impulses)
    .where(eq(impulses.status, 'pending'))
    .orderBy(asc(impulses.createdAt))
    .limit(1);
  return row ?? null;
}

export async function closeImpulse(
  db: Db,
  id: number,
  status: 'used' | 'abandoned',
  postId?: number,
): Promise<void> {
  await db
    .update(impulses)
    .set({ status, usedAt: new Date(), postId: postId ?? null })
    .where(and(eq(impulses.id, id), eq(impulses.status, 'pending')));
}
