import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

// Each app runs with its own cwd, so a bare config() only finds a .env when the process
// happens to start at the repo root. Load the cwd file first (it wins, since dotenv does
// not overwrite), then fall back to the single .env at the workspace root. In Docker the
// file is absent and the real environment is used, which dotenv leaves alone.
config();
config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DRY_RUN: bool,
  KILL_SWITCH: bool,

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  X_APP_KEY: z.string().min(1),
  X_APP_SECRET: z.string().min(1),
  X_ACCESS_TOKEN: z.string().min(1),
  X_ACCESS_SECRET: z.string().min(1),
  X_BEARER_TOKEN: z.string().optional(),
  X_USER_ID: z.string().min(1),
  X_USERNAME: z.string().min(1),

  QUOTA_MONTHLY_READS: z.coerce.number().int().positive().default(15_000),
  QUOTA_MONTHLY_WRITES: z.coerce.number().int().positive().default(3_000),
  QUOTA_DAILY_READS: z.coerce.number().int().positive().default(500),
  QUOTA_DAILY_WRITES: z.coerce.number().int().positive().default(100),

  /** Minimum follower count an account needs before the agent spends a reply on it. */
  REPLY_MIN_FOLLOWERS: z.coerce.number().int().nonnegative().default(1_000),
  /** How many unprompted posts a day. Scattered across the waking window, in UTC. */
  POSTS_PER_DAY: z.coerce.number().int().min(0).max(40).default(6),
  /** Turns in the nightly backrooms conversation. 0 disables it. */
  BACKROOMS_TURNS: z.coerce.number().int().min(0).max(60).default(16),

  /**
   * Any OpenAI-compatible gateway. PPQ by default; point it at api.openai.com or another
   * gateway and nothing above the adapter changes.
   */
  LLM_BASE_URL: z.string().url().default('https://api.ppq.ai'),
  LLM_API_KEY: z.string().min(1),
  /**
   * Model ids are configurable because they move faster than this repo will, and a wrong
   * id fails at runtime rather than at compile time. `pnpm doctor` lists what the key can
   * actually reach.
   */
  LLM_MODEL_VOICE: z.string().default('gpt-5.5'),
  LLM_MODEL_CRITIC: z.string().default('gpt-5.5'),
  LLM_MODEL_TRIAGE: z.string().default('gpt-5.5'),
  LLM_MODEL_DREAM: z.string().default('gpt-5.5'),
  LLM_MODEL_REFLECT: z.string().default('gpt-5.5'),
  LLM_MODEL_EMBED: z.string().default('text-embedding-3-small'),

  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  TICK_JITTER_MS: z.coerce.number().int().nonnegative().default(90_000),
  /** UTC window during which the agent stays quiet, e.g. "03:00-09:00". Empty disables it. */
  SLEEP_WINDOW_UTC: z.string().default(''),
  /** When he was first switched on. Surfaced in the prompt and on the terminal. */
  AWAKENED_AT: z.string().optional(),
});

/**
 * The API process needs the database but not the X credentials, and demanding them would
 * mean putting the account's write keys on a public-facing box for no reason.
 */
const apiSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(8081),
  /** Comma-separated list of allowed browser origins (the Vercel deployment + previews). */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
});

/**
 * CLI tools that touch the database but never talk to X. Demanding the account's write
 * keys to print a schedule would mean they have to be present on any machine that wants
 * to look at one.
 */
const toolSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  POSTS_PER_DAY: z.coerce.number().int().min(0).max(40).default(6),
  SLEEP_WINDOW_UTC: z.string().default(''),
});

export type Env = z.infer<typeof schema>;
export type ApiEnv = z.infer<typeof apiSchema>;
export type ToolEnv = z.infer<typeof toolSchema>;

function parse<S extends z.ZodTypeAny>(s: S): z.infer<S> {
  const parsed = s.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }
  return parsed.data;
}

let cached: Env | null = null;
let cachedApi: ApiEnv | null = null;
let cachedTool: ToolEnv | null = null;

export function loadEnv(): Env {
  if (!cached) cached = parse(schema);
  return cached;
}

export function loadApiEnv(): ApiEnv {
  if (!cachedApi) cachedApi = parse(apiSchema);
  return cachedApi;
}

export function loadToolEnv(): ToolEnv {
  if (!cachedTool) cachedTool = parse(toolSchema);
  return cachedTool;
}
