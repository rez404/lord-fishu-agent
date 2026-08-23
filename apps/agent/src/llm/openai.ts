import OpenAI from 'openai';
import { logger } from '@fishnu/shared';
import type { CompleteRequest, CompleteResult, LlmProvider, Task } from './types.js';

/**
 * OpenAI adapter, on the Responses API — the surface the current GPT-5.x models are
 * documented against (`reasoning.effort`, `text.verbosity`, cached tokens reported in
 * usage). Chat Completions still works but is the older shape.
 *
 * Model IDs are environment-configurable rather than hardcoded. They move faster than
 * this repo will, and a wrong id is a runtime 404 rather than a compile error — run
 * `pnpm --filter @fishnu/agent doctor` after setting a key to confirm the ones in use.
 *
 * Input caching on OpenAI is automatic on a prefix match; there is no cache_control to
 * send. That is exactly why the system prompt is split frozen/volatile: the frozen half
 * must be byte-identical on every call or the discount silently disappears.
 */

const DEFAULT_MODELS: Record<Task, string> = {
  voice: 'gpt-5.6-sol', // what gets published; quality is the entire product
  critic: 'gpt-5.6-terra',
  triage: 'gpt-5.6-luna', // high volume, low judgement
  // The dream is long and unguarded, and its transcript is the source material the next
  // day's posts are quarried from — worth more than the cheap tier, less than the voice.
  dream: 'gpt-5.6-terra',
  reflect: 'gpt-5.6-terra',
};

export interface OpenAiConfig {
  apiKey: string;
  models?: Partial<Record<Task, string>>;
  embedModel?: string;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly models: Record<Task, string>;
  private readonly embedModel: string;

  constructor(config: OpenAiConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.models = { ...DEFAULT_MODELS, ...config.models };
    this.embedModel = config.embedModel ?? 'text-embedding-3-small';
  }

  modelFor(task: Task): string {
    return this.models[task];
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const model = this.models[req.task];
    const started = Date.now();

    // The frozen block must come first and stay byte-identical; the volatile block is
    // appended after it so a mood change costs one cache miss instead of all of them.
    const instructions = req.volatileSystem
      ? `${req.frozenSystem}\n\n${req.volatileSystem}`
      : req.frozenSystem;

    const response = await this.client.responses.create({
      model,
      instructions,
      input: req.user,
      max_output_tokens: req.maxOutputTokens ?? 400,
      ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
      ...(req.verbosity ? { text: { verbosity: req.verbosity } } : {}),
    });

    const usage = response.usage;
    const result: CompleteResult = {
      text: (response.output_text ?? '').trim(),
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
      model,
      ms: Date.now() - started,
    };

    if (result.usage.inputTokens > 2_000 && result.usage.cachedInputTokens === 0) {
      // Not fatal, but it means the bill is several times what it should be, and nothing
      // else in the system would ever surface it.
      logger.warn(
        { task: req.task, inputTokens: result.usage.inputTokens },
        'no cached input tokens on a large prompt — the frozen prefix is being invalidated',
      );
    }

    return result;
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({ model: this.embedModel, input: text });
    return res.data[0]!.embedding;
  }
}
