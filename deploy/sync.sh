#!/usr/bin/env bash
#
# Ships the committed tree straight to the box over SSH and redeploys.
#
#   deploy/sync.sh root@<host>
#
# The normal path is deploy/bootstrap.sh, which pulls from GitHub. This one exists for
# when the box should not or cannot reach the repo — a private repo with no deploy key, a
# push you have not made yet, or a machine with no outbound git access. It sends exactly
# what `git archive HEAD` contains, so uncommitted work is deliberately not deployed.

set -euo pipefail

TARGET="${1:?usage: deploy/sync.sh root@host}"
DIR="${DIR:-/opt/fishnu}"

dirty="$(git status --porcelain | wc -l | tr -d ' ')"
[ "$dirty" != "0" ] && echo "note: $dirty uncommitted change(s) will NOT be deployed" >&2

echo "==> shipping $(git rev-parse --short HEAD) to $TARGET:$DIR"
git archive --format=tar HEAD | ssh "$TARGET" "mkdir -p '$DIR' && tar -x -C '$DIR'"

echo "==> building"
# --force-recreate because compose does not always notice that the contents of an env_file
# changed: it compares its own config hash, so a container can keep running with the values
# it started with while deploy/.env says something else entirely.
ssh "$TARGET" "cd '$DIR' && docker compose -f deploy/docker-compose.yml up -d --build --force-recreate"

echo "==> status"
ssh "$TARGET" "cd '$DIR' && docker compose -f deploy/docker-compose.yml ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'"
