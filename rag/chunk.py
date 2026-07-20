#!/usr/bin/env python3
"""Merge extracted per-page text into overlapping chunks with page metadata.
Input: rag/data/extracted/*.jsonl + rag/data/manifest.jsonl
Output: rag/data/chunks.jsonl  {id, file, page_start, page_end, text}"""
import json, os, re, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EX = os.path.join(ROOT, 'rag', 'data', 'extracted')
MANIFEST = os.path.join(ROOT, 'rag', 'data', 'manifest.jsonl')
OUTP = os.path.join(ROOT, 'rag', 'data', 'chunks.jsonl')

TARGET = 2800   # chars per chunk (~700 tokens)
OVERLAP = 400

def slug(relpath):
    s = re.sub(r'[^A-Za-z0-9._-]+', '_', relpath)
    return s[:180] + '_' + hashlib.sha1(relpath.encode()).hexdigest()[:8]

def chunk_doc(rel, pages):
    """pages: list of (page_no, text). Yield chunks with page ranges."""
    # build a char stream with page boundaries
    stream, bounds = '', []   # bounds[i] = (char_offset, page_no)
    for pno, text in pages:
        t = re.sub(r'[ \t]+', ' ', text).strip()
        if not t:
            continue
        bounds.append((len(stream), pno))
        stream += t + '\n\n'
    if not stream.strip():
        return
    def page_at(off):
        p = bounds[0][1] if bounds else 1
        for o, pno in bounds:
            if o <= off:
                p = pno
            else:
                break
        return p
    i, n = 0, 0
    while i < len(stream):
        j = min(i + TARGET, len(stream))
        if j < len(stream):  # prefer to break at sentence/paragraph
            k = max(stream.rfind('\n\n', i + TARGET // 2, j),
                    stream.rfind('. ', i + TARGET // 2, j))
            if k > i:
                j = k + 1
        text = stream[i:j].strip()
        if len(text) > 80:
            yield {'id': f'{slug(rel)}:{n}', 'file': rel,
                   'page_start': page_at(i), 'page_end': page_at(max(i, j - 1)),
                   'text': text}
            n += 1
        if j >= len(stream):
            break
        i = max(j - OVERLAP, i + 1)

import glob

def synthesis_docs():
    """The archive's verified narrative docs (docs/*.md + overview) — cleanest,
    most-answerable content. Strip the trailing ## Sources bibliography so
    retrieval matches prose, not citation lists. Section headings become page
    anchors so search links can jump to the right heading."""
    paths = sorted(glob.glob(os.path.join(ROOT, 'docs', '[0-9][0-9]-*.md'))) + \
            [os.path.join(ROOT, '00-SYSTEM-OVERVIEW.md')]
    for path in paths:
        if not os.path.exists(path):
            continue
        rel = os.path.relpath(path, ROOT)
        text = open(path).read()
        text = re.split(r'(?m)^## Sources\s*$', text)[0]         # drop bibliography
        text = re.sub(r'\[\\?\[(\d{1,3})\\?\]\]\(#src-\d+\)', '', text)  # strip inline cite markers
        yield rel, [(1, text)]

def main():
    done = [json.loads(l) for l in open(MANIFEST) if '"done"' in l]
    seen, nch = set(), 0
    with open(OUTP, 'w') as fo:
        # 1) verified synthesis docs first (highest-quality answers)
        for rel, pages in synthesis_docs():
            seen.add(rel)
            for ch in chunk_doc(rel, pages):
                fo.write(json.dumps(ch) + '\n'); nch += 1
        # 2) the source corpus
        for rec in done:
            rel = rec['file']
            if rel in seen:
                continue
            seen.add(rel)
            p = os.path.join(EX, slug(rel) + '.jsonl')
            if not os.path.exists(p):
                continue
            pages = []
            for line in open(p):
                r = json.loads(line)
                pages.append((r['page'], r['text']))
            for ch in chunk_doc(rel, pages):
                fo.write(json.dumps(ch) + '\n')
                nch += 1
    print(f'{len(seen)} docs -> {nch} chunks -> {OUTP}')

if __name__ == '__main__':
    main()
