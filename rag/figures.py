#!/usr/bin/env python3
"""Make figures/maps/photos in the corpus retrievable: find graphic-heavy pages,
describe each with the local VLM (qwen3.5:27b on bigmantower — same model as the
judge, so no VRAM thrash), and append the descriptions to chunks.jsonl as
[FIGURE] chunks. embed.py (idempotent) then indexes them for vector+FTS search.

Why: text extraction (pdftotext/tesseract) reduces a map plate like "TARP System
Layout and Routes" to OCR noise — invisible to RAG queries. A prose description
of what the figure shows IS retrievable.

Phases (resumable, like verify.py):
  scan      -> rag/data/figure-candidates.jsonl   (heuristic page list, no GPU)
  describe  -> rag/data/figures.jsonl             (VLM descriptions; skips done)
  chunks    -> appends fig: records to rag/data/chunks.jsonl (dedup by id)
  all       -> scan + describe + chunks
Env: OLLAMA_URL, VISION_MODEL, MAXPAGES (cap describe batch), FILTER (regex on
source path, e.g. FILTER=tarp to run a targeted subset first).
Run from repo root inside rag/.venv."""
import base64, glob, hashlib, json, os, re, subprocess, sys, tempfile, time
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTRACTED = os.path.join(ROOT, 'rag', 'data', 'extracted')
CAND = os.path.join(ROOT, 'rag', 'data', 'figure-candidates.jsonl')
FIGS = os.path.join(ROOT, 'rag', 'data', 'figures.jsonl')
CHUNKS = os.path.join(ROOT, 'rag', 'data', 'chunks.jsonl')
OLLAMA = os.environ.get('OLLAMA_URL', 'http://bigmantower.local:11434')
MODEL = os.environ.get('VISION_MODEL', 'qwen3.5:27b')
MAXPAGES = int(os.environ.get('MAXPAGES', '0'))          # 0 = no cap
FILTER = os.environ.get('FILTER', '')

# a page is a figure candidate if its extracted text names a figure (captioned
# plate) or is too sparse to be a text page (full-page graphic, OCR noise)
FIGWORDS = re.compile(r'\b(figure|fig\.|plate|exhibit|map|diagram|profile|schematic|'
                      r'cross[- ]section|aerial|photograph)\b', re.I)

def fid(file, page):
    return 'fig:' + hashlib.sha1(f'{file}:{page}'.encode()).hexdigest()[:16]

def slug(relpath):
    """Must match extract.py's slug() — maps source relpath -> extracted jsonl name."""
    s = re.sub(r'[^A-Za-z0-9._-]+', '_', relpath)
    return s[:180] + '_' + hashlib.sha1(relpath.encode()).hexdigest()[:8]

MANIFEST = os.path.join(ROOT, 'rag', 'data', 'manifest.jsonl')

def phase_scan():
    n_cand = n_pages = 0
    files = []
    for line in open(MANIFEST):
        try:
            m = json.loads(line)
        except Exception:
            continue
        if m.get('status') != 'done' or not m['file'].lower().endswith('.pdf'):
            continue
        files.append(m['file'])
    files = sorted(set(files))
    with open(CAND, 'w') as fo:
        for rel in files:
            src = os.path.join(ROOT, rel)
            ex = os.path.join(EXTRACTED, slug(rel) + '.jsonl')
            if not (os.path.exists(src) and os.path.exists(ex)):
                continue
            for line in open(ex):
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                n_pages += 1
                text = (r.get('text') or '').strip()
                captioned = bool(FIGWORDS.search(text)) and len(text) < 1200
                sparse = len(text) < 300
                if not (captioned or sparse):
                    continue
                fo.write(json.dumps({'id': fid(rel, r['page']), 'file': rel,
                                     'page': r['page'], 'why': 'caption' if captioned else 'sparse',
                                     'ocr_snippet': ' '.join(text.split())[:160]}) + '\n')
                n_cand += 1
    print(f'SCAN: {n_cand} candidate pages of {n_pages} PDF pages in {len(files)} docs', flush=True)

PROMPT = ('This is a scanned page from a document about Chicago-area water/sewer '
          'infrastructure ("{title}"). If the page is primarily a FIGURE — a map, '
          'diagram, chart, engineering drawing, profile, or photograph — describe it '
          'in detail for a search index: the figure number/title if visible, what it '
          'shows, the geographic area, and every labeled feature you can read (tunnels, '
          'reservoirs, waterways, streets, facilities, alignments, dates, capacities). '
          'Be specific and factual; do not speculate beyond what is visible. '
          'If the page is a plain text page, a blank page, or a title/TOC page, reply '
          'with exactly: SKIP')

def render(src, page):
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, 'p')
        rc = subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-r', '150',
                             '-png', src, out], capture_output=True, timeout=120).returncode
        pngs = glob.glob(out + '*.png')
        if rc != 0 or not pngs:
            return None
        return base64.b64encode(open(pngs[0], 'rb').read()).decode()

def describe(b64, title):
    for attempt in range(3):
        try:
            r = requests.post(f'{OLLAMA}/api/chat', json={
                'model': MODEL, 'stream': False, 'think': False,
                'options': {'temperature': 0, 'num_predict': 450},
                'messages': [{'role': 'user', 'content': PROMPT.format(title=title), 'images': [b64]}],
            }, timeout=300)
            r.raise_for_status()
            return re.sub(r'(?s)<think>.*?</think>', '', r.json()['message']['content']).strip()
        except requests.RequestException:
            time.sleep(10 * (attempt + 1))
    return None

def phase_describe():
    done = set()
    if os.path.exists(FIGS):
        for line in open(FIGS):
            try: done.add(json.loads(line)['id'])
            except Exception: pass
    cands = [json.loads(l) for l in open(CAND)]
    if FILTER:
        cands = [c for c in cands if re.search(FILTER, c['file'])]
    # captioned plates first — highest hit rate
    cands = [c for c in cands if c['id'] not in done]
    cands.sort(key=lambda c: 0 if c['why'] == 'caption' else 1)
    if MAXPAGES:
        cands = cands[:MAXPAGES]
    print(f'DESCRIBE: {len(cands)} to do (skipping {len(done)} done)', flush=True)
    fo = open(FIGS, 'a')
    t0, n, kept = time.time(), 0, 0
    for c in cands:
        src = os.path.join(ROOT, c['file'])
        b64 = render(src, c['page'])
        desc = describe(b64, os.path.basename(c['file'])) if b64 else None
        n += 1
        rec = {'id': c['id'], 'file': c['file'], 'page': c['page'], 'why': c['why']}
        if desc is None:
            rec['status'] = 'error'
        elif desc.strip().upper().startswith('SKIP') or len(desc) < 40:
            rec['status'] = 'skip'
        else:
            rec['status'] = 'figure'; rec['description'] = desc; kept += 1
        fo.write(json.dumps(rec) + '\n'); fo.flush()
        if n % 25 == 0:
            rate = n / max(time.time() - t0, 1)
            print(f'{n}/{len(cands)} ({kept} figures, {rate*3600:.0f} pages/hr, '
                  f'eta {int((len(cands)-n)/max(rate,0.01)/3600)}h{int(((len(cands)-n)/max(rate,0.01)%3600)/60):02d}m)', flush=True)
    print(f'DESCRIBE DONE: {n} pages, {kept} figures kept', flush=True)

def phase_chunks():
    have = set()
    for line in open(CHUNKS):
        try: have.add(json.loads(line)['id'])
        except Exception: pass
    n = 0
    with open(CHUNKS, 'a') as fo:
        for line in open(FIGS):
            r = json.loads(line)
            if r.get('status') != 'figure' or r['id'] in have:
                continue
            fo.write(json.dumps({'id': r['id'], 'file': r['file'],
                                 'page_start': r['page'], 'page_end': r['page'],
                                 'text': f"[FIGURE — {r['file']} p.{r['page']}] {r['description']}"}) + '\n')
            n += 1
    print(f'CHUNKS: {n} figure chunks appended — now run embed.py', flush=True)

def main():
    ph = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if ph in ('scan', 'all'): phase_scan()
    if ph in ('describe', 'all'): phase_describe()
    if ph in ('chunks', 'all'): phase_chunks()

if __name__ == '__main__':
    main()
