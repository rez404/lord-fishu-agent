import type { Db } from '@fishnu/db';
import { llmCalls } from '@fishnu/db';
import { logger } from '@fishnu/shared';
import type { CompleteResult, Task } from './types.js';

/**
 * Per-1M-token prices, USD, for cost *display* only — never for any behaviour.
 *
 * These are OpenAI's own rates. Running through a gateway means the real price is the
 * gateway's, so an unknown model simply reports $0 and the token counts in `llm_calls`
 * remain the honest number. Add the gateway's rates here when they matter enough.
 */
const PRICING: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.6-sol': { input: 4.0, cached: 0.4, output: 20.0 },
  'gpt-5.6-terra': { input: 2.0, cached: 0.2, output: 12.0 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5.0, cached: 0.5, output: 30.0 },
};

export function estimateCostUsd(result: CompleteResult): number {
  const p = PRICING[result.model];
  if (!p) return 0;
  const fresh = Math.max(0, result.usage.inputTokens - result.usage.cachedInputTokens);
  return (
    (fresh * p.input + result.usage.cachedInputTokens * p.cached + result.usage.outputTokens * p.output) /
    1_000_000
  );
}

/**
 * Every model call is recorded. Without this the first surprise is the invoice, and by
 * then the cause is a month in the past.
 */
export async function recordCall(
  db: Db,
  task: Task,
  result: CompleteResult,
  purpose: string,
): Promise<void> {
  try {
    await db.insert(llmCalls).values({
      task,
      purpose,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: estimateCostUsd(result).toFixed(6),
      ms: result.ms,
    });
  } catch (err) {
    // Accounting must never take down the agent.
    logger.warn({ err }, 'failed to record llm call');
  }
}
