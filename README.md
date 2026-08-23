# Lord Fishnu Agent

An autonomous X (Twitter) agent with its own persona, memory, goals, and wallet.
See [PLAN.md](./PLAN.md) for the architecture and roadmap.

**Status: replies and unprompted posting are live.** The X backbone, the public terminal, and the reply pipeline
are built and verified — 110 checks pass against real Postgres and Redis with a fake model
provider. What is still missing: proactive discovery, nightly backrooms conversations, the wallet,
and Spaces.

Nothing has been run against a real API key yet. `pnpm doctor` is the first thing to run
once one exists.

## Layout

```
apps/agent        the worker: X client, quota ledger, tick loop     ← built
apps/api          REST + SSE read model the terminal reads from     ← built
apps/web          Next.js terminal, deployed to Vercel              ← built
packages/persona  the Chickenmandments (canon), the seven books, the prompt builder
packages/shared   env, logger, time helpers, api wire types
packages/db       Drizzle schema + client
deploy/           production Docker stack for the Ubuntu box
```

## Local setup

```bash
cp .env.example .env      # X credentials only needed for the agent
pnpm install
pnpm infra:up             # postgres + redis via docker
pnpm db:push              # create the schema
pnpm --filter @fishnu/agent seed   # optional: demo data so the terminal is not empty

pnpm dev:api              # http://localhost:8081
pnpm dev:web              # http://localhost:3000
pnpm dev:agent            # needs real X credentials
```

`GET localhost:8080/health` returns uptime, tick count, and the live quota ledger.

## Verifying

```bash
pnpm --filter @fishnu/agent smoke   # 41 checks against real postgres + redis
pnpm -r typecheck
```

## Deploying

Frontend on Vercel, backend on one Ubuntu box, everything in Docker. See [DEPLOY.md](./DEPLOY.md).

## Safety switches

| Switch | Where | Effect |
|---|---|---|
| `DRY_RUN` | env, or `dry_run` in the `settings` table | Agent decides and records everything, but never calls a write endpoint. **Defaults to true.** |
| `KILL_SWITCH` | env, or `kill_switch` in the `settings` table | Halts every tick outright. Checked at the top of each tick. |
| `REPLY_MIN_FOLLOWERS` | env, or `reply_min_followers` in the `settings` table | Follower floor for replies. Defaults to 1000. Here the **DB wins over env** — it is a tuning knob, not a brake. |

The DB-backed versions can be flipped at runtime without a deploy:

```sql
insert into settings (key, value) values ('kill_switch', 'true')
  on conflict (key) do update set value = excluded.value, updated_at = now();
```

Env values win over DB values, so `KILL_SWITCH=true` in the environment cannot be
overridden from the database.

## Unprompted posting

Everything is UTC — the agent has no local timezone, and pretending otherwise would mean
the schedule sliding twice a year for daylight saving.

Once per UTC day a plan is drawn and **written to the database**: `POSTS_PER_DAY` slots at
random minutes inside the waking window (`SLEEP_WINDOW_UTC` carves out the quiet hours),
separated by at least 35 minutes but deliberately **not evenly spaced** — six posts at
exact four-hour intervals is a cron job with a personality. Persisting the plan is what
stops a crash loop from re-rolling it and posting four times in ten minutes, which reads
as automated faster than anything the account actually says.

Each slot carries an *angle* — a subject, rotated by day — so a day does not converge on
one idea. A slot he has nothing for is closed, not retried: a god with nothing to say is
more convincing than one who posts anyway.

### Never the same thing twice

Checked against **every post he has ever published**, not a recent window — he repeats
himself across months, not days. Two checks run, because they fail differently:

| Check | Catches |
|---|---|
| Cosine over embeddings (≥0.78) | the same *idea*, said differently |
| Content-word overlap (≥0.6) | the same *sentence*, reworded or reordered |

Embeddings miss a clause-swap that scores below threshold but is obviously the same post
to a reader; overlap catches it. The last 30 posts are also shown to the model up front,
so most repeats are never drafted in the first place.

## Sounding like a person

The point isn't to hide that he's software — he admits it when asked — it's that nothing
about *how* he writes gives it away. Four registers, in `packages/persona`:

| Register | Share | What it is |
|---|---|---|
| `chatter` | most unprompted posts | typed, not composed. lowercase, fragments, "lol", no closing full stop half the time |
| `plain` | replies and real arguments | short declaratives, doctrinal without the costume |
| `scripture` | ~1 in 15 | the law, quoted exactly, when it genuinely applies |
| `gloss` | rare | plain translation, when an outsider sincerely asks |

The guards reject the tells that survive good prompting: em dashes, semicolons, "it's not
X, it's Y", "more than just a", parallel sentence openings, and closing questions that
farm replies. An idle question is fine — *"is it normal to be this attached to a ceiling
fan"* is a person thinking out loud; *"what do YOU think?"* is a growth hack. Only the
second is banned.

## How a reply is made

```
mention  →  triage      cheap model: is this worth answering at all?
         →  recall      who is this, what have they said before
         →  draft       the expensive model, in voice
         →  critic      a separate call, shown the draft cold
         →  guards      deterministic: length, emoji, slop, financial promises
         →  repetition  embedding-compared against the last 200 posts
         →  publish
```

Every stage can veto, twice at most, and a veto is written to the thought stream where it
shows on the public terminal — a god visibly refusing his own draft is better content than
the draft. Declining is a normal outcome, not an error.

The guards run **last and are deterministic**: no model output can talk its way past them.
There is a test that compromises the critic into passing everything and asserts the guards
still hold the line.

### Provider

OpenAI, behind `apps/agent/src/llm/types.ts`. Switching to Claude means writing one more
adapter — the prompts, the pipeline, the guards and every test are provider-agnostic.

| Task | Model | Why |
|---|---|---|
| `voice` | `gpt-5.6-sol` | anything that gets published; quality is the product |
| `critic` | `gpt-5.6-terra` | judgement, not prose |
| `triage` | `gpt-5.6-luna` | high volume, low judgement |
| embeddings | `text-embedding-3-small` | repetition check only |

Model ids live in `.env` because they move faster than this repo does. Roughly **$4/day**
at 100 replies — but only if prompt caching holds (see below).

### The prompt is split frozen/volatile

The system prompt is ~5k tokens and identical on every call, which is the only reason
caching works: providers cache on a **prefix match**, so one changing character anywhere
in the frozen half silently invalidates all of it and multiplies the bill. Nothing
time-varying may enter `buildFrozenPrompt()` — not the clock, not the mood, not the price.
Those go in the volatile block appended after it. Mood is recomputed once a day rather than
once a tick for exactly this reason.

The agent logs a warning when a large prompt comes back with zero cached tokens, and there
is a test asserting the frozen prefix is byte-identical across ticks, moods and days.

## The Ten

`packages/persona/src/commandments.ts` holds the religion's ten commandments, verbatim and
immutable. They are bundled into the frontend rather than served over the API, so the law
is still readable when the box is down, and they become the core of the agent's system
prompt in Phase 1. Anything the agent writes itself is commentary and lands in `posts` —
never in that file.

## Reply policy

Only accounts with **≥1,000 followers** get a reply; the write budget is ~100/day and
reach is how it is rationed. Everyone below the bar is parked as `skipped_low_reach` with
their follower count retained — nothing is discarded.

```sql
-- move the bar at runtime, no deploy
insert into settings (key, value) values ('reply_min_followers', '250')
  on conflict (key) do update set value = excluded.value, updated_at = now();
```

```bash
# then revive the backlog that now qualifies
pnpm --filter @fishnu/agent requeue 250 --dry   # count first
pnpm --filter @fishnu/agent requeue 250
```

Within the eligible set, the highest-follower account is always answered first.

## Quota

Official X API v2 only. Reads are the binding constraint, so the daily read budget is
split across buckets in `apps/agent/src/quota/allocations.ts`, and every call is written
to the `quota_usage` ledger *before* it fires — a restart must not be able to re-spend the
month's budget. Below 15% of the monthly read budget the agent enters degraded mode:
discovery stops, mentions keep running.

⚠️ `QUOTA_MONTHLY_READS` / `QUOTA_MONTHLY_WRITES` in `.env.example` are placeholders.
Verify them against the actual X plan before going live.

## Deploy

```bash
fly launch --no-deploy      # once
fly secrets set X_APP_KEY=... X_APP_SECRET=... X_ACCESS_TOKEN=... X_ACCESS_SECRET=... \
                DATABASE_URL=... REDIS_URL=...
fly deploy
```

Run exactly one machine.
