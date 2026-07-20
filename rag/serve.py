#!/usr/bin/env python3
"""Private mirror server: static site + true RAG search over the archive index.

Serves (default port 8080):
  /                    -> the Jekyll-built static site (SITE_DIR)
  /sources/...         -> the archived source documents (PDFs open at #page=N from search)
  /api/search?q=...    -> hybrid semantic+keyword search over the 154k-chunk index
  /api/ask   (POST)    -> retrieval-augmented answer: synthesizes the sources into a
                          cited answer, streamed token-by-token over SSE. Body:
                          {"q": "...", "history": [{"role","content"},...]}.
  /api/health          -> {ok, chunks, embed_model, chat_model}

Search: query embedded via local Ollama (Qwen3-Embedding-4B), sqlite-vec ANN +
FTS5 BM25, reciprocal-rank fusion — the same retrieval the archive's verification
pipeline uses. Ask: same retrieval, then a local chat model (qwen3.5:27b) grounds
its answer in the retrieved passages with inline [N] citations. Runs on bigmantower
next to Ollama. Requires: pip install sqlite-vec requests.

Env: SITE_DIR (default ./_site), SRC_DIR (default ./sources), DB (default
rag/data/index.db relative to repo root), OLLAMA_URL (default http://127.0.0.1:11434),
EMBED_MODEL, CHAT_MODEL (default qwen3.5:27b), PORT (default 8080), BIND (default 0.0.0.0)."""
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
CHAT_MODEL = os.environ.get('CHAT_MODEL', 'qwen3.5:27b')
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
               'full': re.sub(r'\s+', ' ', text)[:1500],   # richer context for synthesis
               'is_figure': cid.startswith('fig:')}
        # links: docs -> served page; sources pdfs -> pdf at page
        if f.startswith('docs/') and f.endswith('.md'):
            hit['link'] = '/' + f.replace('.md', '.html')
        elif f.lower().endswith('.pdf'):
            hit['link'] = f'/{f}#page={p1}'
        out.append(hit)
    return out

ASK_SYS = (
    "You are the research assistant for a heavily-cited archive of Chicago's water and sewer "
    "system (drinking water, sewers, the river reversal, TARP/Deep Tunnel, treatment plants, and "
    "habitat restoration). Answer the user's question USING ONLY the numbered source passages "
    "provided. Cite every claim inline with the passage number in square brackets, e.g. [3]; cite "
    "multiple as [3][7]. Be specific — carry the exact numbers, dates, names, and contract IDs from "
    "the passages. If the passages do not contain the answer, say so plainly rather than guessing. "
    "If sources disagree, present both with their citations. Write in clear prose, a few sentences "
    "to a few short paragraphs; do not pad.")

def build_context(hits):
    parts = []
    for i, h in enumerate(hits, 1):
        loc = h['file'] + (f" p.{h['page_start']}" if h.get('page_start') else '')
        parts.append(f"[{i}] ({loc}) {h.get('full') or h['snippet']}")
    return '\n\n'.join(parts)

def retrieval_query(q, history):
    # fold in the last user turn so follow-ups ("what did it cost?") retrieve sensibly
    prior = [m['content'] for m in (history or []) if m.get('role') == 'user'][-1:]
    return (' '.join(prior + [q])).strip()

def ask_stream(q, history):
    """Yield SSE byte-strings: a 'sources' event, then token events, then 'done'."""
    hits = search(retrieval_query(q, history), k=12)
    yield sse('sources', [{k: v for k, v in h.items() if k != 'full'} for h in hits])
    ctx = build_context(hits)
    msgs = [{'role': 'system', 'content': ASK_SYS}]
    for m in (history or [])[-6:]:
        if m.get('role') in ('user', 'assistant') and m.get('content'):
            msgs.append({'role': m['role'], 'content': m['content'][:4000]})
    msgs.append({'role': 'user', 'content': f"SOURCE PASSAGES:\n{ctx}\n\nQUESTION: {q}\n\n"
                 "Answer using only these passages, with inline [N] citations."})
    with requests.post(f'{OLLAMA}/api/chat', json={
            'model': CHAT_MODEL, 'stream': True, 'think': False,
            'options': {'temperature': 0.2, 'num_ctx': 12288, 'num_predict': 900},
            'messages': msgs}, stream=True, timeout=300) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            tok = (obj.get('message') or {}).get('content', '')
            if tok:
                yield sse(None, {'t': tok})
            if obj.get('done'):
                break
    yield sse('done', {})

def sse(event, data):
    s = (f'event: {event}\n' if event else '') + 'data: ' + json.dumps(data) + '\n\n'
    return s.encode()

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

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != '/api/ask':
            self._json({'error': 'not found'}, 404); return
        try:
            n = int(self.headers.get('Content-Length', '0'))
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            self._json({'error': 'bad body'}, 400); return
        q = (body.get('q') or '').strip()
        if not q:
            self._json({'error': 'missing q'}, 400); return
        # SSE stream; Connection: close so no Content-Length is needed
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            for chunk in ask_stream(q, body.get('history')):
                self.wfile.write(chunk); self.wfile.flush()
        except requests.RequestException as e:
            try: self.wfile.write(sse('error', {'error': f'model unreachable: {e}'}))
            except Exception: pass
        except Exception as e:
            try: self.wfile.write(sse('error', {'error': str(e)}))
            except Exception: pass

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/api/health':
            try:
                n = db().execute('SELECT count(*) FROM chunks').fetchone()[0]
                self._json({'ok': True, 'chunks': n, 'embed_model': MODEL,
                            'chat_model': CHAT_MODEL, 'ollama': OLLAMA})
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
                hits = [{kk: vv for kk, vv in h.items() if kk != 'full'} for h in search(q, k)]
                self._json({'query': q, 'results': hits})
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
    print(f'embed={MODEL}\nchat={CHAT_MODEL}')
    print(f'serving on http://{BIND}:{PORT}')
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
