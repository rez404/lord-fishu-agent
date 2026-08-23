import OpenAI from 'openai';
import { logger } from '@fishnu/shared';
import type { CompleteRequest, CompleteResult, LlmProvider, Task } from './types.js';

/**
 * An OpenAI-compatible provider, pointed at PPQ by default.
 *
 * PPQ (https://api.ppq.ai) is a pay-per-prompt gateway in front of many models, speaking
 * the OpenAI wire format. Because the same format is spoken by OpenAI itself and by every
 * other gateway, `LLM_BASE_URL` is all that has to change to move between them.
 *
 * **Chat Completions, not Responses.** The Responses API is the richer surface, but a
 * gateway normalises one request shape across many upstream models, and Chat Completions
 * is the shape every one of them accepts. For the same reason this adapter sends only
 * fields that are universal — `model`, `messages`, `max_tokens`. Provider-specific knobs
 * (`reasoning_effort`, `verbosity`, PPQ's `:thinking` suffixes) are deliberately not sent:
 * an unknown field is a 400 from some upstreams, and the `effort` on a request is a hint
 * this adapter is free to ignore.
 *
 * Input caching, where the upstream supports it, is automatic on a prefix match — there
 * is no cache_control to send. That is why the system prompt is split frozen/volatile and
 * why the frozen half is concatenated first: it must be byte-identical on every call.
 */

const DEFAULT_BASE_URL = 'https://api.ppq.ai';

/**
 * Sensible starting points from PPQ's catalogue. They are almost certainly not the right
 * ones — run `pnpm doctor`, which lists what the key can actually reach, and set the
 * cheap tiers properly. A wrong id is a runtime 404, not a compile error.
 */
const DEFAULT_MODELS: Record<Task, string> = {
  voice: 'gpt-5.5',
  critic: 'gpt-5.5',
  triage: 'gpt-5.5',
  dream: 'gpt-5.5',
  reflect: 'gpt-5.5',
};

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  models?: Partial<Record<Task, string>>;
  embedModel?: string;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly models: Record<Task, string>;
  private readonly embedModel: string;

  constructor(config: ProviderConfig) {
    const baseURL = config.baseUrl ?? DEFAULT_BASE_URL;
    this.name = new URL(baseURL).hostname;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL });
    this.models = { ...DEFAULT_MODELS, ...config.models };
    this.embedModel = config.embedModel ?? 'text-embedding-3-small';
  }

  modelFor(task: Task): string {
    return this.models[task];
  }

  /** The catalogue the key can actually reach. Used by `doctor`. */
  async listModels(): Promise<string[]> {
    const res = await this.client.models.list();
    return res.data.map((m) => m.id).sort();
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const model = this.models[req.task];
    const started = Date.now();

    // One system message, frozen half first. Two separate system messages would be
    // equivalent for most upstreams and rejected by some, and the ordering is what the
    // cache depends on either way.
    const system = req.volatileSystem
      ? `${req.frozenSystem}\n\n${req.volatileSystem}`
      : req.frozenSystem;

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: req.maxOutputTokens ?? 400,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.user },
      ],
    });

    const usage = response.usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    const result: CompleteResult = {
      text: (response.choices[0]?.message?.content ?? '').trim(),
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        cachedInputTokens: cached,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      model,
      ms: Date.now() - started,
    };

    if (result.usage.inputTokens > 2_000 && cached === 0) {
      // Not fatal, and some gateways simply do not report cache hits — but if the upstream
      // does cache and this stays at zero, the bill is several times what it should be and
      // nothing else in the system would ever surface it.
      logger.debug(
        { task: req.task, inputTokens: result.usage.inputTokens },
        'no cached input tokens reported on a large prompt',
      );
    }

    return result;
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({ model: this.embedModel, input: text });
    return res.data[0]!.embedding;
  }
}
