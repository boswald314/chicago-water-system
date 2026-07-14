#!/usr/bin/env python3
"""Extract per-page text from every document in sources/ (pdftotext; tesseract OCR
for image-only pages). Stdlib only. Resumable. Output: rag/data/extracted/*.jsonl
(one JSON record per page) + rag/data/manifest.jsonl."""
import json, os, re, subprocess, sys, tempfile, hashlib, html as htmllib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'sources')
OUT = os.path.join(ROOT, 'rag', 'data', 'extracted')
MANIFEST = os.path.join(ROOT, 'rag', 'data', 'manifest.jsonl')
os.makedirs(OUT, exist_ok=True)

SKIP_DIRS = {'_new'}
SKIP_FILES = {'MANUAL-RETRIEVAL.md', '.DS_Store'}
MIN_TEXT_CHARS = 60          # below this, a PDF page is considered image-only -> OCR
OCR_DPI = '200'

def slug(relpath):
    s = re.sub(r'[^A-Za-z0-9._-]+', '_', relpath)
    return s[:180] + '_' + hashlib.sha1(relpath.encode()).hexdigest()[:8]

def run(cmd, timeout=300):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return r.returncode, r.stdout
    except subprocess.TimeoutExpired:
        return -1, b''

def pdf_pages(path):
    rc, out = run(['pdfinfo', path], 60)
    m = re.search(rb'Pages:\s+(\d+)', out)
    return int(m.group(1)) if m else 0

def extract_pdf_page(path, i):
    rc, out = run(['pdftotext', '-f', str(i), '-l', str(i), '-layout', '-enc', 'UTF-8', path, '-'])
    text = out.decode('utf-8', 'replace').strip()
    if len(text) >= MIN_TEXT_CHARS:
        return text, 'text'
    # OCR fallback
    with tempfile.TemporaryDirectory() as td:
        pre = os.path.join(td, 'p')
        rc, _ = run(['pdftoppm', '-f', str(i), '-l', str(i), '-r', OCR_DPI, '-gray', '-png', path, pre], 240)
        pngs = [f for f in os.listdir(td) if f.endswith('.png')]
        if not pngs:
            return text, 'text'
        rc, out = run(['tesseract', os.path.join(td, pngs[0]), 'stdout'], 240)
        ocr = out.decode('utf-8', 'replace').strip()
    return (ocr, 'ocr') if len(ocr) > len(text) else (text, 'text')

def extract_plain(path):
    raw = open(path, 'rb').read().decode('utf-8', 'replace')
    if path.lower().endswith(('.html', '.htm')):
        raw = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', raw)
        raw = re.sub(r'(?s)<[^>]+>', ' ', raw)
        raw = htmllib.unescape(raw)
    raw = re.sub(r'\n{3,}', '\n\n', re.sub(r'[ \t]+', ' ', raw))
    return raw.strip()

def already_done(s):
    if not os.path.exists(MANIFEST):
        return set()
    done = set()
    for line in open(MANIFEST):
        try:
            r = json.loads(line)
            if r.get('status') == 'done':
                done.add(r['file'])
        except Exception:
            pass
    return done

def main():
    files = []
    for root, dirs, fs in os.walk(SRC):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in sorted(fs):
            if f in SKIP_FILES or f.startswith('.'):
                continue
            if f.lower().endswith(('.pdf', '.txt', '.html', '.htm', '.md')):
                files.append(os.path.join(root, f))
    done = already_done(files)
    mf = open(MANIFEST, 'a')
    total_pages = total_ocr = 0
    for n, path in enumerate(files, 1):
        rel = os.path.relpath(path, ROOT)
        if rel in done:
            continue
        outp = os.path.join(OUT, slug(rel) + '.jsonl')
        rec = {'file': rel, 'status': 'error', 'pages': 0, 'ocr_pages': 0, 'chars': 0}
        try:
            with open(outp, 'w') as fo:
                if path.lower().endswith('.pdf'):
                    np = pdf_pages(path)
                    for i in range(1, np + 1):
                        text, method = extract_pdf_page(path, i)
                        if method == 'ocr':
                            rec['ocr_pages'] += 1
                        rec['pages'] += 1
                        rec['chars'] += len(text)
                        fo.write(json.dumps({'page': i, 'method': method, 'text': text}) + '\n')
                else:
                    text = extract_plain(path)
                    rec.update(pages=1, chars=len(text))
                    fo.write(json.dumps({'page': 1, 'method': 'plain', 'text': text}) + '\n')
            rec['status'] = 'done'
        except Exception as e:
            rec['error'] = str(e)[:200]
        total_pages += rec['pages']; total_ocr += rec['ocr_pages']
        mf.write(json.dumps(rec) + '\n'); mf.flush()
        print(f"[{n}/{len(files)}] {rel}: {rec['pages']}p ({rec['ocr_pages']} ocr) {rec['status']}", flush=True)
    print(f"DONE: {total_pages} pages, {total_ocr} OCR'd", flush=True)

if __name__ == '__main__':
    main()
