/**
 * The agent talks to a model only through this interface.
 *
 * We are on OpenAI (decision: 2026-08-22), but the provider has not been finally chosen,
 * so nothing above this file knows which one is behind it. Swapping to Claude means
 * writing one more adapter — the prompts, the pipeline, the guards and the tests are all
 * provider-agnostic.
 */

/** What the call is for. Each task routes to a different model tier. */
export type Task =
  | 'voice' // drafting anything that will be published — the expensive one
  | 'critic' // judging whether a draft is in voice
  | 'triage' // cheap classification: is this mention worth a reply
  | 'reflect'; // nightly summarisation

export interface CompleteRequest {
  task: Task;
  /**
   * Byte-stable across requests. Everything cacheable goes here, and nothing that
   * changes between calls — see packages/persona/src/prompt.ts.
   */
  frozenSystem: string;
  /** Appended after the cache breakpoint; may vary freely. */
  volatileSystem?: string;
  user: string;
  maxOutputTokens?: number;
  /** Lower for mechanical work, higher when the answer has to be good. */
  effort?: 'none' | 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
}

export interface CompleteResult {
  text: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  model: string;
  /** wall-clock, for the cost panel */
  ms: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: CompleteRequest): Promise<CompleteResult>;
  /** Used for the anti-repetition check, not for retrieval. */
  embed(text: string): Promise<number[]>;
}
