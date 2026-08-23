#!/usr/bin/env bash
#
# Brings a fresh Ubuntu box up as the Lord Fishnu backend.
#
#   ssh root@<host> 'bash -s' < deploy/bootstrap.sh
#
# Idempotent: safe to run again after a change. It never overwrites an existing
# deploy/.env, and it stops rather than starting the agent with a half-filled one.

set -euo pipefail

REPO="${REPO:-https://github.com/rez404/lord-fishu-agent.git}"
DIR="${DIR:-/opt/fishnu}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ── docker ──────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "installing docker"
  curl -fsSL https://get.docker.com | sh
else
  say "docker already present"
fi

# ── firewall ────────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  say "firewall"
  # SSH is allowed before anything is enabled. Enabling ufw without this on a remote
  # box locks you out of it permanently, and there is no undo over the connection you
  # just cut.
  ufw allow OpenSSH >/dev/null
  ufw allow 80,443/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status | head -6
fi

# ── code ────────────────────────────────────────────────────────────────────
if [ -d "$DIR/.git" ]; then
  say "updating $DIR"
  git -C "$DIR" fetch --quiet origin
  git -C "$DIR" reset --hard origin/main --quiet
else
  say "cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet "$REPO" "$DIR"
fi
cd "$DIR"
echo "at $(git rev-parse --short HEAD)"

# ── secrets ─────────────────────────────────────────────────────────────────
if [ ! -f deploy/.env ]; then
  cp deploy/.env.example deploy/.env
  chmod 600 deploy/.env
  say "deploy/.env created — fill it in, then run this again"
  cat <<'MSG'

  Required before the stack will start:

    API_DOMAIN            an A record pointing at this box, e.g. api.lordfishnu.xyz
    POSTGRES_PASSWORD     something long
    CORS_ORIGINS          the Vercel domain, e.g. https://lordfishnu.xyz
    LLM_API_KEY           a PPQ key (https://ppq.ai), or any OpenAI-compatible key
    X_APP_KEY / X_APP_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET / X_USER_ID

  Leave DRY_RUN=true until the voice is calibrated. Nothing is posted while it is on.

    nano /opt/fishnu/deploy/.env

MSG
  exit 0
fi
chmod 600 deploy/.env

unset_key() {
  value="$(grep -E "^$1=" deploy/.env | head -1 | cut -d= -f2-)"
  case "$value" in ''|change-me*|sk-not-set*|ppq_your*) return 0 ;; *) return 1 ;; esac
}

# Hard requirements: without these nothing starts at all.
missing=""
for key in API_DOMAIN POSTGRES_PASSWORD LLM_API_KEY; do
  unset_key "$key" && missing="$missing $key"
done
if [ -n "$missing" ]; then
  say "deploy/.env is incomplete:$missing"
  echo "fill those in and run this again."
  exit 1
fi

# X is not a hard requirement. The database, the read API, the public terminal and the
# nightly conversations all work without it, and waiting for API approval to bring any of
# them up would be a choice rather than a constraint.
x_missing=""
for key in X_APP_KEY X_APP_SECRET X_ACCESS_TOKEN X_ACCESS_SECRET X_USER_ID; do
  unset_key "$key" && x_missing="$x_missing $key"
done
if [ -n "$x_missing" ]; then
  say "no X credentials:$x_missing"
  echo "  he will think and dream, but not read or speak. everything else comes up."
fi

# ── up ──────────────────────────────────────────────────────────────────────
say "building and starting"
docker compose -f deploy/docker-compose.yml up -d --build

say "status"
docker compose -f deploy/docker-compose.yml ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'

domain="$(grep -E '^API_DOMAIN=' deploy/.env | cut -d= -f2-)"
cat <<MSG

  next:
    curl https://${domain}/health
    docker compose -f deploy/docker-compose.yml logs -f agent

  verify the models can be reached (costs a few cents, publishes nothing):
    docker compose -f deploy/docker-compose.yml run --rm agent pnpm --filter @fishnu/agent doctor

MSG
