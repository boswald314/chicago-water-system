#!/usr/bin/env bash
# Deploy the private mirror to bigmantower: static site + sources + RAG index + search server.
#
# Usage: scripts/deploy-bigmantower.sh [user@host]      (default: bigmantower)
# Requires: passwordless SSH to the target, ruby/jekyll locally (bundle exec jekyll build),
#           python3 + venv on the target. Ollama must already run on the target (:11434).
#
# Idempotent: rsync only moves deltas; the index copy is skipped when unchanged.
set -euo pipefail
HOST="${1:-bigmantower}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="~/chicago-water-mirror"
PORT="${PORT:-8077}"

echo "== 1/5 building static site (jekyll) =="
cd "$REPO"
PATH=/opt/homebrew/opt/ruby/bin:$PATH bundle exec jekyll build --quiet
# the private mirror gets the RAG search page linked in place of nothing:
cp rag-search.html _site/rag-search.html

echo "== 2/5 rsync site + server =="
ssh "$HOST" "mkdir -p $DEST/rag/data $DEST/scripts"
rsync -az --delete _site/ "$HOST:$DEST/_site/"
rsync -az rag/serve.py "$HOST:$DEST/rag/serve.py"

echo "== 3/5 rsync sources (first run moves ~7GB; later runs, deltas) =="
rsync -az --exclude '_hunt' --exclude '_new' sources/ "$HOST:$DEST/sources/"

echo "== 4/5 rsync RAG index (skips if unchanged) =="
rsync -az rag/data/index.db "$HOST:$DEST/rag/data/index.db"

echo "== 5/5 remote venv + (re)start service =="
ssh "$HOST" bash -s <<REMOTE
set -e
cd $DEST
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip install -q sqlite-vec requests
pkill -f 'rag/serve[.]py' 2>/dev/null || true
sleep 1
nohup ./.venv/bin/python rag/serve.py > serve.log 2>&1 &
sleep 2
curl -sf "http://127.0.0.1:$PORT/api/health" && echo && echo "mirror live on http://\$(hostname):$PORT"
REMOTE
