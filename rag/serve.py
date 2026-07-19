#!/usr/bin/env python3
"""Private mirror server: static site + true RAG search over the archive index.

Serves (default port 8080):
  /                    -> the Jekyll-built static site (SITE_DIR)
  /sources/...         -> the archived source documents (PDFs open at #page=N from search)
  /api/search?q=...    -> hybrid semantic+keyword search over the 154k-chunk index
  /api/health          -> {ok, chunks, model}

Search: query embedded via local Ollama (Qwen3-Embedding-4B), sqlite-vec ANN +
FTS5 BM25, reciprocal-rank fusion — the same retrieval the archive's verification
pipeline uses. Runs on bigmantower next to Ollama; also runs on the Mac for testing
(set OLLAMA_URL). Requires: pip install sqlite-vec requests.

Env: SITE_DIR (default ./_site), SRC_DIR (default ./sources), DB (default
rag/data/index.db relative to repo root), OLLAMA_URL (default http://127.0.0.1:11434),
PORT (default 8080), BIND (default 0.0.0.0)."""
import json, os, re, sqlite3, struct, sys, threading, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import requests
import sqlite_vec

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SITE_DIR = os.path.abspath(os.environ.get('SITE_DIR', os.path.join(ROOT, '_site')))
SRC_DIR = os.path.abspath(os.environ.get('SRC_DIR', os.path.join(ROOT, 'sources')))
DB_PATH = os.path.abspath(os.environ.get('DB', os.path.join(ROOT, 'rag', 'data', 'index.db')))
OLLAMA = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434')
MODEL = os.environ.get('EMBED_MODEL', 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q8_0')
PORT = int(os.environ.get('PORT', '8080'))
BIND = os.environ.get('BIND', '0.0.0.0')
DIM = 2560
QUERY_PREFIX = ('Instruct: Given a research question about Chicago water and sewer '
                'infrastructure, retrieve passages from historical documents that answer it\nQuery: ')

_local = threading.local()
def db():
    if not hasattr(_local, 'db'):
        d = sqlite3.connect(DB_PATH)
        d.enable_load_extension(True); sqlite_vec.load(d); d.enable_load_extension(False)
        _local.db = d
    return _local.db

def search(q, k=12):
    r = requests.post(f'{OLLAMA}/api/embed', json={'model': MODEL, 'input': [QUERY_PREFIX + q]}, timeout=120)
    r.raise_for_status()
    qv = struct.pack(f'{DIM}f', *r.json()['embeddings'][0])
    d = db()
    vec_hits = d.execute('SELECT id, distance FROM vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
                         (qv, k * 3)).fetchall()
    fts_q = ' OR '.join(re.findall(r'[a-zA-Z0-9]{3,}', q)[:24])
    try:
        fts_hits = d.execute('SELECT id, rank FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?',
                             (fts_q, k * 3)).fetchall()
    except sqlite3.OperationalError:
        fts_hits = []
    score = {}
    for rank, (cid, _) in enumerate(vec_hits):
        score[cid] = score.get(cid, 0) + 1.0 / (60 + rank)
    for rank, (cid, _) in enumerate(fts_hits):
        score[cid] = score.get(cid, 0) + 1.0 / (60 + rank)
    out = []
    for cid, s in sorted(score.items(), key=lambda x: -x[1])[:k]:
        row = d.execute('SELECT file, page_start, page_end, text FROM chunks WHERE id=?', (cid,)).fetchone()
        if not row:
            continue
        f, p1, p2, text = row
        hit = {'file': f, 'page_start': p1, 'page_end': p2, 'score': round(s, 5),
               'snippet': re.sub(r'\s+', ' ', text)[:400],
               'is_figure': cid.startswith('fig:')}
        # links: docs -> served page; sources pdfs -> pdf at page
        if f.startswith('docs/') and f.endswith('.md'):
            hit['link'] = '/' + f.replace('.md', '.html')
        elif f.lower().endswith('.pdf'):
            hit['link'] = f'/{f}#page={p1}'
        out.append(hit)
    return out

class H(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def translate_path(self, path):
        # route /sources/** to SRC_DIR, everything else into SITE_DIR
        p = urllib.parse.urlparse(path).path
        p = urllib.parse.unquote(p)
        p = os.path.normpath(p).lstrip('/')
        if p == 'sources' or p.startswith('sources' + os.sep) or p.startswith('sources/'):
            return os.path.join(os.path.dirname(SRC_DIR), p)
        return os.path.join(SITE_DIR, p)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/api/health':
            try:
                n = db().execute('SELECT count(*) FROM chunks').fetchone()[0]
                self._json({'ok': True, 'chunks': n, 'model': MODEL, 'ollama': OLLAMA})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)}, 500)
            return
        if u.path == '/api/search':
            qs = urllib.parse.parse_qs(u.query)
            q = (qs.get('q') or [''])[0].strip()
            k = min(int((qs.get('k') or ['12'])[0]), 50)
            if not q:
                self._json({'error': 'missing q'}, 400); return
            try:
                self._json({'query': q, 'results': search(q, k)})
            except requests.RequestException as e:
                self._json({'error': f'embedder unreachable: {e}'}, 502)
            except Exception as e:
                self._json({'error': str(e)}, 500)
            return
        super().do_GET()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

if __name__ == '__main__':
    print(f'site={SITE_DIR}\nsources={SRC_DIR}\ndb={DB_PATH}\nollama={OLLAMA}')
    print(f'serving on http://{BIND}:{PORT}')
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
