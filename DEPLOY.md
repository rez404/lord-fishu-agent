# Deploying Lord Fishnu

Two halves, deployed independently:

| Half | Where | What runs |
|---|---|---|
| Backend | One Ubuntu box | Postgres, Redis, the agent worker, the read API, Caddy for TLS — all in Docker |
| Frontend | Vercel | The Next.js terminal, talking to the box over HTTPS |

The frontend must survive the box being down: every API call fails soft and the terminal
reports a severed uplink in character. Rebooting the server does not take the site down.

---

## 1. The Ubuntu box

Anything with 2 vCPU / 4 GB will do. Hetzner CX22 or equivalent is plenty.

### Prerequisites

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in

# Firewall: only ssh and the web ports. Postgres and Redis are never published —
# they are reachable only inside the compose network, by service name.
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Point an A record at the box for the API hostname (e.g. `api.lordfishnu.xyz`) **before**
starting, or Caddy cannot obtain a certificate.

### Deploy

```bash
sudo mkdir -p /opt/fishnu && sudo chown $USER /opt/fishnu
git clone <repo> /opt/fishnu && cd /opt/fishnu

cp deploy/.env.example deploy/.env
chmod 600 deploy/.env      # this file holds the X write keys
$EDITOR deploy/.env        # API_DOMAIN, POSTGRES_PASSWORD, CORS_ORIGINS, X_* keys

docker compose -f deploy/docker-compose.yml up -d --build
```

That is the whole install. The stack starts in order: Postgres → schema migration →
agent + API → Caddy, which takes a Let's Encrypt certificate on first request.

```bash
curl https://api.lordfishnu.xyz/health          # {"ok":true}
docker compose -f deploy/docker-compose.yml logs -f agent
```

### Updating

```bash
cd /opt/fishnu && git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

Migrations run automatically before the agent starts. **The agent must never run as more
than one replica** — two workers reply to the same mention twice. The Redis tick lock
catches this, but do not rely on it: keep `replicas: 1`.

### Day-to-day

```bash
# stop him immediately
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U fishnu -d fishnu -c "insert into settings (key,value) values ('kill_switch','true') \
    on conflict (key) do update set value = excluded.value, updated_at = now();"

# move the follower bar and answer the parked backlog
... -c "insert into settings (key,value) values ('reply_min_followers','250') on conflict ..."
docker compose -f deploy/docker-compose.yml exec agent pnpm --filter @fishnu/agent requeue 250

# quota ledger, live
curl -s https://api.lordfishnu.xyz/health | jq .quota
```

### Backups

The database holds the agent's entire memory — lose it and he is a stranger to everyone
he has ever spoken to.

```bash
docker compose -f deploy/docker-compose.yml exec -T postgres \
  pg_dump -U fishnu fishnu | gzip > "/opt/fishnu/backups/$(date +%F).sql.gz"
```

Put that in a daily cron and copy it off the box.

---

## 2. Vercel

Import the repo, then in **Project Settings → General**:

| Setting | Value |
|---|---|
| Root Directory | `apps/web` |
| Framework Preset | Next.js |
| Install Command | `pnpm install` (run from the repo root — leave "Include files outside root directory" on) |
| Build Command | `pnpm build` |

**Environment Variables:**

| Name | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.lordfishnu.xyz` |

It must be `https`. A page served over HTTPS cannot open an `EventSource` to an `http`
origin, so the live thought stream silently dies if the API is served in the clear — this
is the single most likely thing to go wrong in this setup.

Then add the frontend's domain to `CORS_ORIGINS` in `deploy/.env` on the box and restart
the API:

```bash
docker compose -f deploy/docker-compose.yml up -d api
```

For preview deploys to work as well, add `*.vercel.app` to `CORS_ORIGINS` — the API
matches wildcard entries by hostname suffix.

---

## 3. Checklist before he is allowed to speak

- [ ] `DRY_RUN=true` in `deploy/.env` — he decides and logs, but posts nothing
- [ ] Watch `action_log` and the `posts` table for a few days; read what he *would* have said
- [ ] `QUOTA_MONTHLY_READS` / `QUOTA_MONTHLY_WRITES` verified against the real X plan
- [ ] `REPLY_MIN_FOLLOWERS` set deliberately (1000 by default)
- [ ] `SLEEP_WINDOW_UTC` set, so he is not visibly awake 24 hours a day
- [ ] Database backup cron running
- [ ] Kill switch tested end to end, from the panel or psql
- [ ] Only then: `DRY_RUN=false`
