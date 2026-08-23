import type { Db } from '@fishnu/db';
import { logger } from '@fishnu/shared';
import type { LlmProvider } from '../llm/types.js';
import { OVERLAP_THRESHOLD, cosine, overlap } from './guards.js';

/**
 * Has he said this already?
 *
 * Two independent checks, because they fail differently: the embedding catches the same
 * *idea* said differently, and word overlap catches the same *sentence* reworded or
 * reordered — a clause swap can score below the cosine threshold while being obviously
 * the same line to a reader.
 *
 * Overlap needs no network. That is deliberate: the gateway's embeddings endpoint is the
 * one part of the model API this project cannot verify without a key, so if it is
 * missing or misconfigured the repetition check degrades to overlap-only rather than
 * taking the whole pipeline down with it. Degraded is worse; broken is worse still.
 */

export interface Said {
  text: string;
  embedding: number[] | null;
}

export interface EchoHit {
  text: string;
  why: string;
}

let embeddingsWarned = false;

/** Never throws. Returns null when the provider cannot embed. */
export async function safeEmbed(llm: LlmProvider, text: string): Promise<number[] | null> {
  try {
    return await llm.embed(text);
  } catch (err) {
    if (!embeddingsWarned) {
      embeddingsWarned = true;
      logger.warn(
        { err },
        'embeddings unavailable — repetition checking falls back to word overlap. ' +
          'Check LLM_MODEL_EMBED against the gateway catalogue (pnpm doctor).',
      );
    }
    return null;
  }
}

export function findEcho(
  text: string,
  embedding: number[] | null,
  history: Said[],
  cosineThreshold: number,
): EchoHit | null {
  for (const said of history) {
    if (overlap(text, said.text) >= OVERLAP_THRESHOLD) {
      return { text: said.text, why: 'this is a rewording of' };
    }
    if (embedding && said.embedding && cosine(embedding, said.embedding) >= cosineThreshold) {
      return { text: said.text, why: 'i have already said this' };
    }
  }
  return null;
}
