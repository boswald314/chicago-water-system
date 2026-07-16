#!/usr/bin/env python3
"""Verify every claim-citation pair in the detail docs against the RAG corpus.
For each sentence carrying a [N] citation: retrieve passages (prioritizing the
cited source), then ask a local LLM on the 3090 (qwen3.5:27b via Ollama) whether
the evidence supports the claim — with special attention to numbers, dates, and
directional/spatial relations (the failure class that produced earlier errors).

Resumable: skips claims already judged. Output: rag/data/verification.jsonl.
Run from repo root inside rag/.venv."""
import json, os, re, sqlite3, struct, sys, time, hashlib, glob
import requests
import sqlite_vec

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'rag', 'data', 'index.db')
OUT = os.path.join(ROOT, 'rag', 'data', 'verification.jsonl')
OLLAMA = os.environ.get('OLLAMA_URL', 'http://bigmantower.local:11434')
EMBED_MODEL = os.environ.get('EMBED_MODEL', 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q8_0')
JUDGE_MODEL = os.environ.get('JUDGE_MODEL', 'qwen3.5:27b')
DIM = 2560
QPREFIX = ('Instruct: Given a factual claim about Chicago water/sewer infrastructure, '
           'retrieve passages that confirm or refute it\nQuery: ')

SENT_SPLIT = re.compile(r'(?<=[.;:])\s+(?=[A-Z0-9"\(])')
CITE = re.compile(r'\\?\[\\?\[(\d{1,3})\\?\]\\?\]\(#src-(\d+)\)')  # [\[N\]](#src-N)
FILEHINT = re.compile(r'`sources/([^`]+)`')

def db_connect():
    db = sqlite3.connect(DB)
    db.enable_load_extension(True); sqlite_vec.load(db); db.enable_load_extension(False)
    return db

def embed_query(text):
    r = requests.post(f'{OLLAMA}/api/embed', json={'model': EMBED_MODEL, 'input': [QPREFIX + text]}, timeout=120)
    r.raise_for_status()
    return struct.pack(f'{DIM}f', *r.json()['embeddings'][0])

def parse_doc_sources(text):
    """Return {srcnum: {'file': relpath or None, 'desc': text}} from the ## Sources list."""
    src = {}
    m = re.search(r'(?m)^## Sources\s*$', text)
    if not m:
        return src
    for line in text[m.start():].splitlines():
        mm = re.match(r'^(\d{1,3})\. <a id="src-\d+"></a>(.*)$', line)
        if mm:
            n = int(mm.group(1)); body = mm.group(2)
            fh = FILEHINT.search(body)
            src[n] = {'file': ('sources/' + fh.group(1)) if fh else None, 'desc': body[:300]}
    return src

def extract_claims(path):
    text = open(path).read()
    srcs = parse_doc_sources(text)
    body = text[:re.search(r'(?m)^## Sources\s*$', text).start()] if '## Sources' in text else text
    claims = []
    for para in body.split('\n'):
        if not para.strip() or para.startswith(('|', '#', '---')):
            # tables: treat each cited row as a claim too
            if para.startswith('|') and CITE.search(para):
                cites = [int(m.group(2)) for m in CITE.finditer(para)]
                clean = re.sub(CITE, '', para).strip('| ').replace('|', ' / ')
                if len(clean) > 25:
                    claims.append((clean[:600], cites))
            continue
        for sent in SENT_SPLIT.split(para):
            cites = [int(m.group(2)) for m in CITE.finditer(sent)]
            if not cites:
                continue
            clean = re.sub(CITE, '', sent).strip()
            clean = re.sub(r'\s+', ' ', clean)
            if len(clean) > 25:
                claims.append((clean[:700], sorted(set(cites))))
    return claims, srcs

def retrieve(db, claim, cited_files):
    qv = embed_query(claim)
    hits = db.execute('SELECT id, distance FROM vec WHERE embedding MATCH ? ORDER BY distance LIMIT 12', (qv,)).fetchall()
    fts_q = ' OR '.join(re.findall(r'[a-zA-Z0-9]{4,}', claim)[:20])
    try:
        fts = db.execute('SELECT id FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT 12', (fts_q,)).fetchall()
    except sqlite3.OperationalError:
        fts = []
    ids = list(dict.fromkeys([h[0] for h in hits] + [f[0] for f in fts]))
    rows = []
    for cid in ids:
        r = db.execute('SELECT file, page_start, page_end, text FROM chunks WHERE id=?', (cid,)).fetchone()
        if r:
            rows.append(r)
    # prioritize passages from the cited source files
    def score(r):
        return 0 if any(cf and cf in r[0] for cf in cited_files) else 1
    rows.sort(key=score)
    return rows[:8]

JUDGE_SYS = ("You verify factual claims against retrieved source passages about Chicago water/sewer "
             "infrastructure. Be strict. Pay special attention to NUMBERS (capacities, dates, costs, "
             "counts, dimensions) and DIRECTIONAL/SPATIAL relations (upstream/downstream, north/south, "
             "east/west bank, larger/smaller, before/after, feeds/fed-by) — a claim with a correct number "
             "but an inverted relation is CONTRADICTED. Respond with a JSON object only: "
             '{"verdict":"SUPPORTED|CONTRADICTED|NOT_FOUND|PARTIAL","confidence":0-1,'
             '"evidence":"<short quote from a passage, or empty>","issue":"<one line if not SUPPORTED>"}')

def judge(claim, passages):
    ctx = '\n\n'.join(f'[{i+1}] ({r[0]} p.{r[1]}) {re.sub(chr(92)+"s+"," ",r[3])[:700]}' for i, r in enumerate(passages))
    prompt = f'CLAIM:\n{claim}\n\nRETRIEVED PASSAGES:\n{ctx}\n\nVerdict JSON:'
    for attempt in range(4):
        try:
            r = requests.post(f'{OLLAMA}/api/chat', json={
                'model': JUDGE_MODEL, 'stream': False, 'format': 'json',
                'options': {'temperature': 0, 'num_ctx': 8192},
                'messages': [{'role': 'system', 'content': JUDGE_SYS}, {'role': 'user', 'content': prompt}],
            }, timeout=180)
            r.raise_for_status()
            content = r.json()['message']['content']
            v = json.loads(content)
            return v
        except Exception as e:
            time.sleep(5 * (attempt + 1))
    return {'verdict': 'ERROR', 'confidence': 0, 'evidence': '', 'issue': 'judge failed'}

RETR = os.path.join(ROOT, 'rag', 'data', 'verify-retrieved.jsonl')

def all_claims():
    docs = sorted(glob.glob(os.path.join(ROOT, 'docs', '[01][0-9]-*.md'))) + \
           [os.path.join(ROOT, '00-SYSTEM-OVERVIEW.md')]
    for path in docs:
        if not os.path.exists(path):
            continue
        slug = os.path.basename(path)
        claims, srcs = extract_claims(path)
        for i, (claim, cites) in enumerate(claims):
            cid = hashlib.sha1(f'{slug}:{i}:{claim[:80]}'.encode()).hexdigest()[:16]
            cited_files = [f for f in (srcs.get(n, {}).get('file') for n in cites) if f]
            yield cid, slug, claim, cites, cited_files

def phase_retrieve():
    """Pass 1: retrieve passages for every claim. Only the embedding model is used."""
    db = db_connect()
    done = set()
    if os.path.exists(RETR):
        for line in open(RETR):
            try: done.add(json.loads(line)['cid'])
            except Exception: pass
    fo = open(RETR, 'a')
    n = 0
    for cid, slug, claim, cites, cited_files in all_claims():
        if cid in done:
            continue
        passages = retrieve(db, claim, cited_files)
        fo.write(json.dumps({'cid': cid, 'doc': slug, 'claim': claim, 'cites': cites,
                             'cited_files': cited_files,
                             'passages': [{'file': r[0], 'p': r[1], 'text': r[3][:900]} for r in passages]}) + '\n')
        fo.flush(); n += 1
        if n % 100 == 0:
            print(f'retrieve: {n} claims', flush=True)
    print(f'RETRIEVE DONE: {n} new (total file rows ~{len(done)+n})', flush=True)

def phase_judge():
    """Pass 2: judge every retrieved claim. Only qwen is used."""
    done = set()
    if os.path.exists(OUT):
        for line in open(OUT):
            try: done.add(json.loads(line)['cid'])
            except Exception: pass
    rows = [json.loads(l) for l in open(RETR)]
    fo = open(OUT, 'a')
    n = 0
    for r in rows:
        if r['cid'] in done:
            continue
        passages = [(p['file'], p['p'], p['p'], p['text']) for p in r['passages'][:5]]
        v = judge(r['claim'], passages)
        fo.write(json.dumps({'cid': r['cid'], 'doc': r['doc'], 'claim': r['claim'],
                             'cites': r['cites'], 'cited_files': r['cited_files'],
                             'verdict': v.get('verdict'), 'confidence': v.get('confidence'),
                             'evidence': (v.get('evidence') or '')[:400],
                             'issue': (v.get('issue') or '')[:300]}) + '\n')
        fo.flush(); n += 1
        if n % 20 == 0:
            print(f'judge: {n}/{len(rows)-len(done)}', flush=True)
    print(f'JUDGE DONE: {n} judged this run', flush=True)

def main():
    ph = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if ph in ('retrieve', 'all'):
        phase_retrieve()
    if ph in ('judge', 'all'):
        phase_judge()

if __name__ == '__main__':
    main()
