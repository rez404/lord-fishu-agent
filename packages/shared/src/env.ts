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

  /**
   * Optional so the rest of the system can run before X access exists.
   *
   * With no credentials the agent still boots, still serves /health, and still holds its
   * nightly conversations — none of which touch X. It simply does not read or speak on
   * the timeline. Requiring them would mean the site cannot go live until the API
   * approval does, and those are not the same wait.
   */
  X_APP_KEY: z.string().default(''),
  X_APP_SECRET: z.string().default(''),
  X_ACCESS_TOKEN: z.string().default(''),
  X_ACCESS_SECRET: z.string().default(''),
  X_BEARER_TOKEN: z.string().optional(),
  X_USER_ID: z.string().default(''),
  X_USERNAME: z.string().default('lordfishnu'),

  QUOTA_MONTHLY_READS: z.coerce.number().int().positive().default(15_000),
  QUOTA_MONTHLY_WRITES: z.coerce.number().int().positive().default(3_000),
  QUOTA_DAILY_READS: z.coerce.number().int().positive().default(500),
  QUOTA_DAILY_WRITES: z.coerce.number().int().positive().default(100),

  /** Minimum follower count an account needs before the agent spends a reply on it. */
  REPLY_MIN_FOLLOWERS: z.coerce.number().int().nonnegative().default(1_000),
  /** How many unprompted posts a day. Scattered across the waking window, in UTC. */
  POSTS_PER_DAY: z.coerce.number().int().min(0).max(40).default(6),
  /**
   * Minimum minutes between two unprompted posts. Lower it to feel more present; leave
   * the day more gaps than posts or the schedule stops being random and starts being a
   * metronome.
   */
  MIN_POST_GAP_MINUTES: z.coerce.number().int().min(15).max(720).default(180),
  /**
   * Whether he thinks in the gaps between doing things. Off leaves the public stream
   * still except when something happens; on costs a cheap call every 25 idle minutes.
   */
  IDLE_THINKING: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  /** Turns in a backrooms conversation. 0 disables it entirely. */
  BACKROOMS_TURNS: z.coerce.number().int().min(0).max(60).default(16),
  /**
   * Hours between conversations. 24 keeps it nightly and inside the quiet window; lower
   * lets him talk to himself around the clock. Each conversation costs roughly $0.30, so
   * every 4 hours is about $1.80 a day.
   */
  BACKROOMS_EVERY_HOURS: z.coerce.number().int().min(0).max(168).default(24),

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
  LLM_MODEL_VOICE: z.string().default('claude-sonnet-4.6'),
  LLM_MODEL_CRITIC: z.string().default('openai/gpt-5.5'),
  LLM_MODEL_TRIAGE: z.string().default('google/gemini-2.5-flash'),
  LLM_MODEL_DREAM: z.string().default('claude-sonnet-4.6'),
  LLM_MODEL_REFLECT: z.string().default('openai/gpt-5.5'),
  LLM_MODEL_EMBED: z.string().default('openai/text-embedding-3-small'),

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
  /** Optional: used only to wake the agent the moment an impulse is released. */
  REDIS_URL: z.string().url().optional(),
  API_PORT: z.coerce.number().int().positive().default(8081),
  /** Bearer token for the operator routes. Unset disables them entirely. */
  ADMIN_TOKEN: z.string().optional(),

  /**
   * X OAuth 2.0, used only to verify who a visitor is before their confession carries a
   * name. Unset disables the connect flow and confessions stay anonymous.
   */
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  /** Must match the callback registered in the X developer portal, exactly. */
  X_CALLBACK_URL: z.string().url().optional(),
  /** Where to send someone back to once they have connected. */
  SITE_URL: z.string().url().default('http://localhost:3000'),
  /** Signs visitor session cookies. Any long random string. */
  SESSION_SECRET: z.string().optional(),
  /** Read-only chain access for the ledger. A public endpoint is fine at this volume. */
  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  /** Comma-separated list of allowed browser origins (the Vercel deployment + previews). */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
});

/**
 * CLI tools that touch the database and the model gateway, but never talk to X.
 *
 * Demanding the account's write keys in order to print a schedule — or to check that a
 * model id is valid — would mean they have to be present on any machine that wants to do
 * either. They are the most dangerous secret in the project; nothing should ask for them
 * that does not need them.
 */
const toolSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  POSTS_PER_DAY: z.coerce.number().int().min(0).max(40).default(6),
  BACKROOMS_TURNS: z.coerce.number().int().min(0).max(60).default(16),
  SLEEP_WINDOW_UTC: z.string().default(''),

  LLM_BASE_URL: z.string().url().default('https://api.ppq.ai'),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL_VOICE: z.string().default('claude-sonnet-4.6'),
  LLM_MODEL_CRITIC: z.string().default('openai/gpt-5.5'),
  LLM_MODEL_TRIAGE: z.string().default('google/gemini-2.5-flash'),
  LLM_MODEL_DREAM: z.string().default('claude-sonnet-4.6'),
  LLM_MODEL_REFLECT: z.string().default('openai/gpt-5.5'),
  LLM_MODEL_EMBED: z.string().default('openai/text-embedding-3-small'),
});

export type Env = z.infer<typeof schema>;

/** Whether the agent can reach X at all. Everything timeline-shaped is gated on this. */
export function hasXCredentials(env: Env): boolean {
  // X_USER_ID is deliberately not required: the four keys are what authenticate, and the
  // account tells the agent its own numeric id at startup.
  return Boolean(env.X_APP_KEY && env.X_APP_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET);
}
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
