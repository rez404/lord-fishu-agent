/**
 * Runs one backrooms conversation on demand, outside the nightly schedule.
 *
 *   pnpm --filter @fishnu/agent dream          # a real one, costs model tokens
 *   pnpm --filter @fishnu/agent dream --turns 8
 *
 * Useful for seeing what the two of them actually produce before letting it run
 * unattended for a month, and for filling the archive so the site is not empty at launch.
 */
import { createDb } from '@fishnu/db';
import { loadEnv, logger } from '@fishnu/shared';
import { runBackrooms } from '../src/mind/backrooms.js';
import { OpenAiProvider } from '../src/llm/openai.js';

async function main() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const flag = process.argv.indexOf('--turns');
  const turns = flag > -1 ? Number(process.argv[flag + 1]) : env.BACKROOMS_TURNS;

  const llm = new OpenAiProvider({
    apiKey: env.OPENAI_API_KEY,
    models: { dream: env.OPENAI_MODEL_DREAM },
    embedModel: env.OPENAI_MODEL_EMBED,
  });

  const result = await runBackrooms({ db, llm, turns });
  if (!result) {
    console.error('nothing ran — BACKROOMS_TURNS is 0');
    process.exit(1);
  }

  console.log(`\n${result.turns} turns\n/dreams/${result.slug}\n`);
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, 'dream failed');
  process.exit(1);
});
