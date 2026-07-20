#!/usr/bin/env bash
# Consolidated index-finish: run AFTER the figure-captioning describe phase ends.
# Order matters — chunk.py rebuilds chunks.jsonl (would wipe appended figure chunks),
# so it must run BEFORE figures.py chunks. One embed pass covers everything new:
# synthesis docs (docs/*.md, newly indexed), Wild Mile, the 9 river-sweep docs,
# and the [FIGURE] caption chunks. Then push the fresh index to the mirror.
set -euo pipefail
cd "$(dirname "$0")/.."
export OLLAMA_URL=${OLLAMA_URL:-http://bigmantower:11434}
PY=rag/.venv/bin/python

echo "[finish] waiting for captioning describe phase to end…"
while pgrep -f 'figures.py describe' >/dev/null; do sleep 120; done
echo "[finish] captioning done $(date)"

echo "[finish] 1/5 chunk.py (rebuild: synthesis docs + full source corpus incl. new river docs)"
$PY rag/chunk.py

echo "[finish] 2/5 figures.py chunks (append [FIGURE] caption chunks)"
$PY rag/figures.py chunks

echo "[finish] 3/5 embed.py (embed everything new)"
$PY rag/embed.py 2>&1 | tail -5

echo "[finish] 4/5 rsync index + new source files -> mirror"
rsync -az rag/data/index.db bigmantower:~/chicago-water-mirror/rag/data/index.db
rsync -az --exclude _hunt --exclude _new sources/ bigmantower:~/chicago-water-mirror/sources/

echo "[finish] 5/5 restart mirror server"
ssh bigmantower bash -s <<'REMOTE'
cd ~/chicago-water-mirror
pkill -f 'rag/serve\.py' 2>/dev/null || true
sleep 1
PORT=8077 nohup ./.venv/bin/python rag/serve.py > serve.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:8077/api/health
REMOTE
echo
echo "[finish] DONE — index now includes docs + Wild Mile + river sweep + figure captions"
