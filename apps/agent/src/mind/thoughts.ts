import type { Db } from '@fishnu/db';
import { thoughts } from '@fishnu/db';
import { logger } from '@fishnu/shared';

export type ThoughtKind = 'observation' | 'deliberation' | 'decision' | 'reflection' | 'utterance';

/**
 * The inner monologue is a product surface, not a log. It is what the public terminal
 * streams, so every meaningful step writes one — including the rejections, which are the
 * most interesting thing in the stream: a god visibly refusing his own draft is better
 * content than the draft.
 */
export async function think(
  db: Db,
  kind: ThoughtKind,
  body: string,
  opts: { mood?: string; meta?: unknown } = {},
): Promise<void> {
  try {
    await db.insert(thoughts).values({
      kind,
      body,
      mood: opts.mood ?? null,
      meta: (opts.meta ?? null) as object,
    });
  } catch (err) {
    logger.warn({ err }, 'failed to record thought');
  }
}
