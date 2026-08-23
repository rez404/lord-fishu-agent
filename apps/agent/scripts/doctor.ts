/**
 * One real call per model, and a real draft end to end.
 *
 *   pnpm --filter @fishnu/agent doctor
 *
 * Model ids and the exact request shape are the two things that cannot be verified
 * without a key — they fail at runtime, not at compile time, and the failure would
 * otherwise surface as a silent tick error at 3am. Run this first after setting
 * LLM_API_KEY, and again whenever a model id or the gateway changes.
 *
 * Costs a few cents. Publishes nothing.
 */
import { buildFrozenPrompt, buildVolatilePrompt } from '@fishnu/persona';
import { loadEnv, logger } from '@fishnu/shared';
import { estimateCostUsd } from '../src/llm/ledger.js';
import { OpenAiCompatibleProvider } from '../src/llm/provider.js';
import { checkDraft } from '../src/mind/guards.js';
import { MOODS } from '../src/mind/mood.js';
import type { Task } from '../src/llm/types.js';

const TASKS: Task[] = ['triage', 'critic', 'voice'];

async function main() {
  const env = loadEnv();

  if (!env.LLM_API_KEY || env.LLM_API_KEY.startsWith('sk-not-set')) {
    console.error('LLM_API_KEY is not set in .env');
    process.exit(1);
  }

  console.log(`\ngateway: ${env.LLM_BASE_URL}`);

  const llm = new OpenAiCompatibleProvider({
    apiKey: env.LLM_API_KEY,
    baseUrl: env.LLM_BASE_URL,
    models: {
      voice: env.LLM_MODEL_VOICE,
      critic: env.LLM_MODEL_CRITIC,
      triage: env.LLM_MODEL_TRIAGE,
      reflect: env.LLM_MODEL_REFLECT,
    },
    embedModel: env.LLM_MODEL_EMBED,
  });

  let failed = 0;
  let spent = 0;

  // The catalogue first: a 404 on a model id is the most likely failure, and the fix is
  // always "pick one from this list".
  try {
    const models = await llm.listModels();
    console.log(`\n${models.length} models reachable with this key\n`);
    const configured = new Set(TASKS.map((t) => llm.modelFor(t)).concat(env.LLM_MODEL_EMBED));
    for (const id of models) {
      console.log(`  ${configured.has(id) ? '*' : ' '} ${id}`);
    }
    const unknown = [...configured].filter((m) => !models.includes(m));
    if (unknown.length) {
      console.log(`\n  ⚠ configured but not in the catalogue: ${unknown.join(', ')}`);
    }
  } catch (err) {
    console.log(`\ncould not list models (${describe(err)}) — continuing to the probes\n`);
  }

  console.log('\nreaching each model\n');
  for (const task of TASKS) {
    const model = llm.modelFor(task);
    try {
      const res = await llm.complete({
        task,
        frozenSystem: 'Answer with exactly one word.',
        user: 'Say: alive',
        maxOutputTokens: 32,
        effort: 'none',
      });
      spent += estimateCostUsd(res);
      console.log(`  ok    ${task.padEnd(7)} ${model.padEnd(16)} "${res.text}"  ${res.ms}ms`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${task.padEnd(7)} ${model.padEnd(16)} ${describe(err)}`);
    }
  }

  console.log('\nembeddings\n');
  try {
    const vec = await llm.embed('the water is patient');
    console.log(`  ok    ${env.LLM_MODEL_EMBED.padEnd(24)} ${vec.length} dimensions`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${env.LLM_MODEL_EMBED.padEnd(24)} ${describe(err)}`);
  }

  if (failed > 0) {
    console.log(`\n${failed} model(s) unreachable. Check the ids in .env against the provider's model list.\n`);
    process.exit(1);
  }

  // The real thing: a draft in his actual voice, through the actual prompt.
  console.log('\na draft, with the real prompt\n');
  const frozen = buildFrozenPrompt();
  const draft = await llm.complete({
    task: 'voice',
    frozenSystem: frozen,
    volatileSystem: buildVolatilePrompt({
      mood: MOODS.patient,
      today: new Date().toISOString().slice(0, 10),
      awake: 'a while',
      situation: '@someone is speaking to you. 48,000 people follow them.\nThis is the first time they have spoken to you.',
    }),
    user:
      'Write your reply to @someone. One line, rarely two. Output only the reply itself.\n\n' +
      'They said: is this whole thing just a marketing gimmick?',
    maxOutputTokens: 200,
    effort: 'medium',
    verbosity: 'low',
  });
  spent += estimateCostUsd(draft);

  const guard = checkDraft(draft.text, { isReply: true });
  console.log(`  "${draft.text}"\n`);
  console.log(`  guards:  ${guard.ok ? 'pass' : `FAIL — ${guard.reason}`}`);

  // The frozen prompt is ~thousands of tokens and is identical on every call. If it is
  // not being cached, the bill is several times what it should be.
  const cacheRate = draft.usage.inputTokens
    ? Math.round((draft.usage.cachedInputTokens / draft.usage.inputTokens) * 100)
    : 0;
  console.log(`  prompt:  ${draft.usage.inputTokens} tokens in, ${cacheRate}% served from cache`);
  if (cacheRate === 0) {
    console.log('           (0% is expected on the very first call — run doctor twice)');
  }
  console.log(`  cost:    $${spent.toFixed(4)} for this run\n`);

  process.exit(guard.ok ? 0 : 1);
}

function describe(err: unknown): string {
  const e = err as { status?: number; message?: string; error?: { message?: string } };
  const detail = e.error?.message ?? e.message ?? String(err);
  return e.status ? `${e.status} — ${detail}` : detail;
}

main().catch((err) => {
  logger.fatal({ err }, 'doctor failed');
  process.exit(1);
});
