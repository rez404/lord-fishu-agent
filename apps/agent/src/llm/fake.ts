import type { CompleteRequest, CompleteResult, LlmProvider } from './types.js';

/**
 * Deterministic stand-in for the smoke tests, and for working on the pipeline before an
 * API key exists. Records every request so tests can assert on what the prompt actually
 * contained — in particular that the frozen prefix never changes between calls, which is
 * the property the whole caching design rests on and which nothing else would catch.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';
  readonly requests: CompleteRequest[] = [];

  constructor(private readonly responder: (req: CompleteRequest) => string) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.requests.push(req);
    return {
      text: this.responder(req).trim(),
      usage: { inputTokens: 1_000, cachedInputTokens: 900, outputTokens: 40 },
      model: `fake-${req.task}`,
      ms: 1,
    };
  }

  async embed(text: string): Promise<number[]> {
    // A cheap deterministic hash-embedding: similar strings land near each other, which
    // is all the dedupe check needs in a test.
    const vec = new Array(64).fill(0);
    const words = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const w of words) {
      let h = 0;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      vec[h % 64] += 1;
    }
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  /** Frozen prefixes must be identical across every call for caching to work. */
  frozenPrefixesAreStable(): boolean {
    const first = this.requests[0]?.frozenSystem;
    return this.requests.every((r) => r.frozenSystem === first);
  }
}
