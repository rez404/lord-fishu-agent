import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { confessions, posts } from '@fishnu/db';

export interface Confession {
  id: number;
  body: string;
  handle: string | null;
}

/**
 * Whether a confession may take the slot that is due.
 *
 * Confessions fill scheduled slots rather than creating them, so the posting rate never
 * depends on how many people write in. But taking *every* slot is its own failure: a queue
 * that never empties would mean he never says anything unprompted again, and the timeline
 * quietly becomes a question-and-answer bot with a costume on.
 *
 * So they alternate. If the last thing he published was an answer to someone, the next
 * slot is his own.
 */
export async function confessionMayTakeSlot(db: Db): Promise<boolean> {
  const [last] = await db
    .select({ meta: posts.meta })
    .from(posts)
    .where(eq(posts.kind, 'post'))
    .orderBy(desc(posts.createdAt))
    .limit(1);

  const meta = last?.meta as { confession?: number } | null | undefined;
  return !meta?.confession;
}

/**
 * The oldest thing a visitor has left that he has not looked at.
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

/** How many are waiting. Shown to visitors so the silence is legible rather than broken. */
export async function pendingCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(confessions)
    .where(eq(confessions.status, 'pending'));
  return row?.n ?? 0;
}
