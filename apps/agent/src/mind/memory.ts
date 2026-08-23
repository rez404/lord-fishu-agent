import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { inboundTweets, people, posts } from '@fishnu/db';

/**
 * What he remembers about a person, and what he has said lately.
 *
 * Him remembering someone he argued with three weeks ago is the thing that makes people
 * lose their minds, and it costs one indexed query.
 */

export interface PersonMemory {
  username: string | null;
  followers: number | null;
  exchanges: number;
  firstSeen: Date | null;
  /** their previous messages to him, oldest first, capped */
  history: Array<{ text: string; at: Date }>;
}

export async function recallPerson(db: Db, authorId: string): Promise<PersonMemory> {
  const [person] = await db.select().from(people).where(eq(people.userId, authorId)).limit(1);

  const history = await db
    .select({ text: inboundTweets.text, at: inboundTweets.seenAt })
    .from(inboundTweets)
    .where(eq(inboundTweets.authorId, authorId))
    .orderBy(desc(inboundTweets.seenAt))
    .limit(6);

  return {
    username: person?.username ?? null,
    followers: person?.followers ?? null,
    exchanges: person?.interactionCount ?? 0,
    firstSeen: person?.firstSeenAt ?? null,
    history: history.reverse(),
  };
}

/**
 * Everything he has ever published, newest first.
 *
 * Unprompted posts are checked against the whole history rather than a recent window: he
 * repeats himself across months, not across days, and a six-month-old line resurfacing
 * verbatim is exactly what makes a timeline read as generated. At a handful of posts a
 * day this is a few thousand rows — small enough to scan in process, and far short of
 * needing a vector index.
 */
export async function allPosts(
  db: Db,
  cap = 5_000,
): Promise<Array<{ id: number; text: string; embedding: number[] | null }>> {
  return recentPosts(db, cap);
}

/** Recent published lines, so a draft can be checked against what he has already said. */
export async function recentPosts(
  db: Db,
  limit = 200,
): Promise<Array<{ id: number; text: string; embedding: number[] | null }>> {
  const rows = await db
    .select({ id: posts.id, text: posts.text, embedding: posts.embedding })
    .from(posts)
    .orderBy(desc(posts.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    embedding: Array.isArray(r.embedding) ? (r.embedding as number[]) : null,
  }));
}

/** How many people he has answered, for the situation block. */
export async function congregationSize(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(people)
    .where(and(isNotNull(people.username)));
  return row?.n ?? 0;
}
