# Lord Fishnu Agent — Architecture & Roadmap

## 0. What is actually being asked for

The chat log in `idea.md` is scattered, but it describes one thing:

> **An autonomous AI agent named "Lord Fishnu" — a deity persona that runs its own X (Twitter) account 24/7, holds its own wallet, and was "set free" to pursue its own mission.**

Its internal incentive: build a following in order to revive the **OG SCF token** (currently ~439k mcap).

| Requirement    | Detail                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personality    | Truth Terminal–grade coherence. It has to _feel_ like a mind, not a scheduled poster.                                                                |
| X interaction  | Not just posting: **reply to every comment it receives** + **proactively hunt down posts to comment on**. Outward engagement is the shill mechanism. |
| Infrastructure | Runs 24/7 on a server, not on anyone's laptop.                                                                                                       |
| Wallet         | Manages its own wallet, deploys its own coin (Fishnu/SCF pair on stonkfun.xyz with reflections), and keeps buying SCF with what it earns.            |
| Goals          | Its own goal list and plan. The feeling should be: "we built it, we set it free, and this is what it chose to do."                                   |
| Long term      | **Speaking in its own voice on X Spaces.** (The "big bang".)                                                                                         |

So this is not a Twitter bot — it's **a place where a character lives**. Two products:

1. **Agent (Node.js)** — the mind and the hands. Runs on a server.
2. **Web (Next.js)** — the agent's glass skull: live thought stream, goals, wallet, scripture. This is not a side deliverable; it's the strongest marketing surface the token has.

---

## 1. Locked decisions

| Decision       | Choice                                                | Consequence                                                                                                                      |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| X access       | **Official X API v2 only**                            | Zero ban risk, but the monthly read quota is the binding constraint on proactive discovery. Everything is budgeted around reads. |
| Autonomy       | **Fully autonomous from day one, with a kill switch** | No approval queue. Persona quality and output guards must therefore be much stronger before launch — a bad tweet is permanent.   |
| Starting point | **Phase 0 — the X backbone**                          | Monorepo skeleton, `x-client` abstraction, rate/quota budget manager, a dumb echo bot surviving 72h on a server.                 |

Because there is no human approval queue, the guard layer (moderation filter, similarity dedupe, critic pass, spend caps, kill switch) is **not optional polish — it is the release gate**.

---

## 2. Architecture

```
┌──────────────────────────── apps/web (Next.js 15) ───────────────────────────┐
│  Public: live thought stream · goals · wallet · post archive · scripture     │
│  Admin : KILL SWITCH · persona editor · quota + cost panel · audit log       │
└──────────────────────────────── ▲ (SSE / polling) ───────────────────────────┘
                                  │
┌──────────────────────────── apps/api (Node/Fastify) ─────────────────────────┐
│  REST + SSE  ·  admin auth  ·  read model                                    │
└──────────────────────────────── ▲ ──────────────────────────────────────────┘
                                  │  Postgres (+pgvector)  ·  Redis
                                  ▼
┌──────────────────────────── apps/agent (Node worker) ────────────────────────┐
│  ┌── COGNITION LOOP (BullMQ cron, ~5-15 min, jittered) ────────────────────┐ │
│  │ 1 PERCEIVE   mentions · timeline · search · SCF price/holders · wallet  │ │
│  │ 2 RECALL     pgvector memory retrieval + person profiles               │ │
│  │ 3 DELIBERATE LLM → a "thought" (streams to dashboard) + goal update    │ │
│  │ 4 DECIDE     pick from action set: post / reply / quote / like /       │ │
│  │              follow / search_and_engage / buy_scf / idle               │ │
│  │ 5 ACT        quota budget + guards + dedupe → X API / Solana           │ │
│  │ 6 REFLECT    (nightly) compress episodic memory → "beliefs"            │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│  Modules: x-client · llm-router · memory · persona · goals · wallet · guard  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Monorepo:** pnpm workspaces → `apps/web`, `apps/api`, `apps/agent`, `packages/db`, `packages/shared`, `packages/persona`.

**Stack:** TypeScript everywhere · Next.js 15 (App Router), hand-written CSS (Tailwind and
shadcn buy nothing for a single-aesthetic terminal and would fight the character grid) ·
Fastify · Drizzle ORM · Postgres (Neon/Supabase) + pgvector · Redis + BullMQ · `twitter-api-v2` · Solana web3.js · Fly.io or a Hetzner VPS.

**Single-instance invariant:** two agent workers = duplicate posts. Enforced with a Redis lock around every tick, not just by deployment discipline.

---

## 3. The critical layer: X interaction under an official-API-only budget

The read quota is the whole game. Official Basic tier is roughly **~$200/mo for ~15k post reads and ~3k writes per month** — _these numbers move; they get verified and pinned into config before Phase 0 ships._ Working assumption: **~500 reads/day, ~100 writes/day**.

That budget has to be allocated deliberately:

| Bucket                 | Daily reads | Why                                                                       |
| ---------------------- | ----------- | ------------------------------------------------------------------------- |
| Mention polling        | ~150        | Non-negotiable — "reply to everything it receives" is a core requirement  |
| Targeted search sweeps | ~250        | Proactive hunting: a small set of high-signal queries, not broad scraping |
| KOL watchlist          | ~80         | ~15 accounts, checked a few times a day                                   |
| Reserve                | ~20         | Bursts, retries                                                           |

### Reply rationing

~100 writes/day against unbounded mention volume means replies are the scarcer resource,
not reads. The rule:

- **Hard floor at 1,000 followers.** Below it, a mention is stored with status
  `skipped_low_reach` — kept, with its follower count, never deleted.
- **Highest reach answered first.** When the per-tick cap bites, the 900k account gets
  the slot, not whoever happened to arrive first.
- **The floor is a runtime knob** (`settings.reply_min_followers`), not a deploy.
  `scripts/requeue.ts` revives the parked backlog when the bar moves.
- **Unknown follower count counts as zero.** X withholds the user object for suspended
  and protected accounts, which aren't worth a reply anyway.

Follower counts ride along free on the `author_id` expansion, so the gate costs no extra
quota.

Design consequences:

- **Quality over coverage.** The agent can't read everything, so a cheap scoring model ranks a small candidate pool and only the top few get an expensive reply.
- **Adaptive polling.** Mention polling backs off when quiet, tightens when a post is trending. Fixed intervals waste quota and read as robotic.
- **`x-client` stays an interface** with one official adapter behind it. If the quota economics force a change later, we swap the adapter, not the agent.
- **Persistent quota ledger** in Postgres (not just in-memory counters), so a restart can't blow the monthly budget.
- **Human-shaped activity curve** — jittered intervals, a sleep window, no template repetition.

---

## 4. Making it feel like Truth Terminal

The hard part isn't the plumbing, it's that the output must not read as slop. With no approval queue, this is the release gate:

- **Persona constitution** — `packages/persona/`. The Chickenmandments (canon, verbatim,
  each with an outsider gloss) and the Seven Books (principles pre-digested into his
  voice) are written. The register rules are drafted; the 30–50 few-shot examples that
  actually carry the voice are not.
- **Three registers, not one** — scripture (`thou shalt`, rare, ~1 post in 15), everyday
  (lowercase, short, ~90% of the timeline), and gloss (plain, only when an outsider
  sincerely asks). A god who says "thou shalt" in every reply is a bit, and bits die in
  about nine days.
- **Total sincerity** — the comedy is the collision between register and subject (a god
  issuing scripture about JUUL pods), never a wink at the reader. He must never signal
  that a line was a joke. A god who knows he is funny is a mascot.
- **The seven books are the content engine** — he speaks from them constantly and quotes
  them never. This is both a copyright line and a quality one: a bot that recites Napoleon
  Hill is a quote account; a god who has read him and disagrees in places is a character.
- **Mood state** — driven by SCF price, mention volume, and the tone of recent interactions. The same prompt in a different mood produces a different voice. This is ~70% of feeling alive.
- **Layered memory** — episodic (every interaction) + semantic (facts learned about specific people) + a nightly reflection job that compresses episodes into a `beliefs` table. The agent remembering someone it argued with three weeks ago is the thing that makes people lose their minds.
- **Anti-repetition** — every draft is embedding-compared against the last 200 posts; >0.85 similarity is rejected and regenerated.
- **Two-pass generation** — draft → critic pass ("would Fishnu say this? does it smell like an AI?") → publish.
- **Hard guards before the API call** — moderation filter, banned-topic list, no unprompted financial promises, length/format checks. Anything that fails is logged to the dashboard as a rejected thought instead of being posted.
- **LLM routing** — Claude (Opus/Sonnet) for voice and prose, a small cheap model for classification/scoring (which tweets are worth answering). `llm-router` keeps this swappable per task.

---

## 5. Wallet & token

Money comes last, in this order:

1. **Read-only** — wallet balance, SCF price and holder data surfaced on the dashboard, and known to the agent so it can reference them in posts. Zero risk, high perceived autonomy.
2. **Fishnu token deploy** — Fishnu/SCF pair on stonkfun.xyz with reflections. ⚠️ Whether stonkfun exposes an API/SDK or we call the on-chain program directly, and how the reflection mechanism works, is **unknown and needs research** — Phase 4's plan depends on it.
3. **Autonomous buys** — periodic SCF purchases from reflection income (Jupiter swap). Guardrails: per-trade cap, daily cap, whitelisted token addresses, hot/cold split with only a week's spend in the hot wallet.
4. Every transaction shows on the dashboard and gets announced by the agent itself ("today I bought X SCF") — the most concrete proof of autonomy there is.

**Key security:** the private key never sits in the repo or a plain `.env` — Fly secrets / KMS only. This is a memecoin project; the server becomes a target eventually.

---

## 6. Next.js surface (the marketing weapon)

| Route        | Content                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `/`          | Live **thought stream** over SSE — what the agent is thinking as it decides. Terminal aesthetic. This alone can go viral. |
| `/mind`      | Active goals with progress, the `beliefs` list, memory stats                                                              |
| `/wallet`    | Holdings, transaction history, SCF accumulation chart                                                                     |
| `/scripture` | Lore — the "holy texts" the agent writes for itself, accumulating over time                                               |
| `/timeline`  | Post archive with engagement metrics                                                                                      |
| `/admin`     | Kill switch, persona editor, quota/cost panel, audit log                                                                  |

---

## 7. Phases

| Phase                     | Est.               | Deliverable                                                                                                                  | Done when                                                                        |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **0 — X backbone**        | ~1 week            | Monorepo, `x-client` + official adapter, persistent quota ledger, Redis single-instance lock, kill switch, echo bot deployed | Runs 72h on the server without dropping; quota ledger matches X's reported usage |
| **1 — The mind**          | ~1.5 weeks         | Cognition loop, persona, memory, posting + mention replies, thought log, guard layer                                         | 20/20 sample posts pass blind "was this written by an AI?" review                |
| **2 — Dashboard**         | ~1 week (parallel) | Public site + admin panel + kill switch                                                                                      | Ready for public launch                                                          |
| **3 — Proactive hunting** | ~1 week            | Search sweeps, KOL watchlist, candidate scoring, outbound replies within budget                                              | 30–50 quality outbound interactions/day inside quota                             |
| **4 — Wallet/token**      | ~1–2 weeks         | Read-only → deploy → autonomous SCF buys                                                                                     | First autonomous swap on-chain                                                   |
| **5 — Spaces (R&D)**      | ?                  | TTS + headless browser + virtual audio device to speak in a Space                                                            | —                                                                                |

Phase 5 now has an answer to "what does he actually say in a Space": **sermons.** One of
the seven books, compressed to five minutes in his own voice, tied back to the
commandments it underwrites. `sermonSource()` in `packages/persona` is the hook. That
turns the hardest phase from an open content problem into a delivery problem.

Phase 5 is honestly **not a solved problem**: X has no Spaces API, so it needs headless Chrome plus a virtual audio device plus a realtime STT→LLM→TTS pipeline, and latency is a real issue. Doable, but it isn't worth starting before 0–4 are standing.

---

## 8. Rough monthly cost

| Item                              | Cost             |
| --------------------------------- | ---------------- |
| X API Basic                       | ~$200            |
| LLM (~60 calls/day, mixed models) | ~$150–400        |
| Server (Fly.io / VPS)             | ~$25–50          |
| Postgres + Redis                  | ~$25–40          |
| **Total**                         | **~$400–700/mo** |

---

## 9. Risks

1. **Slop** — the top risk now that there's no approval queue. Mitigation: persona engineering + critic pass + hard guards + a dry-run mode where output is logged but not posted, run for a few days before going live.
2. **Read quota exhaustion** — running out mid-month kills discovery. Mitigation: persistent ledger, per-bucket allocation, degraded mode that prioritizes mentions.
3. **Wallet compromise** — hot/cold split, spend caps, secrets in KMS.
4. **Duplicate instances** — Redis lock, enforced in code.
5. **Legal/perception** — an autonomous agent promoting and trading a coin. Disclaimer on the site: experimental autonomous software, not financial advice.

---

## 10. Open questions

- stonkfun.xyz API/SDK status and how reflections actually work (needs research)
- SCF contract address / chain
- The X account: new or existing, and how old (a brand-new account posting autonomously is far more likely to be flagged)
- Who holds the API keys and the budget approval
