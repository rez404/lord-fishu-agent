# Lord Fishnu Agent

An autonomous X (Twitter) agent with its own persona, memory, goals, and wallet.
See [PLAN.md](./PLAN.md) for the architecture and roadmap.

**Status: Phase 0 done, Phase 2 done, Phase 1 outstanding.** The X backbone and the
public terminal are built and verified. What is missing is the mind: the agent currently
replies with placeholder text, because the cognition loop is Phase 1.

## Layout

```
apps/agent        the worker: X client, quota ledger, tick loop     ← built
apps/api          REST + SSE read model the terminal reads from     ← built
apps/web          Next.js terminal, deployed to Vercel              ← built
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
