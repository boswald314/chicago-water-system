#!/usr/bin/env python3
"""Hybrid (vector + BM25) query over the source-document index.
Usage: rag/.venv/bin/python rag/query.py "north branch dam river mile" [-k 8]
Prints file, page range, score, and snippet for each hit — exact sourcing for claims."""
import json, os, re, sqlite3, struct, sys
import requests
import sqlite_vec

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'rag', 'data', 'index.db')
OLLAMA = os.environ.get('OLLAMA_URL', 'http://bigmantower.local:11434')
MODEL = os.environ.get('EMBED_MODEL', 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q8_0')
QUERY_PREFIX = ('Instruct: Given a research question about Chicago water and sewer '
                'infrastructure, retrieve passages from historical documents that answer it\nQuery: ')

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    k = 8
    if '-k' in sys.argv:
        k = int(sys.argv[sys.argv.index('-k') + 1])
        args = [a for a in args if a != str(k)]
    q = ' '.join(args)
    if not q:
        print('usage: query.py "question" [-k N]'); return

    db = sqlite3.connect(DB)
    db.enable_load_extension(True); sqlite_vec.load(db); db.enable_load_extension(False)

    r = requests.post(f'{OLLAMA}/api/embed', json={'model': MODEL, 'input': [QUERY_PREFIX + q]}, timeout=120)
    r.raise_for_status()
    qv = struct.pack('2560f', *r.json()['embeddings'][0])

    vec_hits = db.execute(
        'SELECT id, distance FROM vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?', (qv, k * 3)).fetchall()
    fts_q = ' OR '.join(re.findall(r'[a-zA-Z0-9]{3,}', q))
    try:
        fts_hits = db.execute('SELECT id, rank FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?', (fts_q, k * 3)).fetchall()
    except sqlite3.OperationalError:
        fts_hits = []

    # reciprocal rank fusion
    score = {}
    for rank, (cid, _) in enumerate(vec_hits):
        score[cid] = score.get(cid, 0) + 1.0 / (60 + rank)
    for rank, (cid, _) in enumerate(fts_hits):
        score[cid] = score.get(cid, 0) + 1.0 / (60 + rank)
    top = sorted(score.items(), key=lambda x: -x[1])[:k]

    for cid, s in top:
        row = db.execute('SELECT file, page_start, page_end, text FROM chunks WHERE id=?', (cid,)).fetchone()
        if not row:
            continue
        f, p0, p1, text = row
        pages = f'p.{p0}' if p0 == p1 else f'pp.{p0}-{p1}'
        snippet = re.sub(r'\s+', ' ', text)[:400]
        print(f'\n=== {f} [{pages}] (score {s:.4f})\n{snippet}…')

if __name__ == '__main__':
    main()
