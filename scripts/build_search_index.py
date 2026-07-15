#!/usr/bin/env python3
"""Build assets/search-index.json — one searchable record per doc section (## / ###)."""
import json, os, re, glob
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def kramdown_anchor(h):
    a = h.strip().lower()
    a = re.sub(r'[^a-z0-9 _-]', '', a)     # drop punctuation, keep spaces
    a = a.strip().replace(' ', '-')        # each space -> one hyphen (kramdown: no collapse)
    return a

def clean(t):
    t = re.sub(r'\\?\[\\?\[(\d{1,3})\\?\]\\?\]\(#src-\d+\)', '', t)  # citations
    t = re.sub(r'<a id="[^"]*"></a>', '', t)
    t = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', t)                    # md links -> text
    t = re.sub(r'[#*`>|]', ' ', t)
    t = re.sub(r'\s+', ' ', t)
    return t.strip()

def doc_title(text, fallback):
    m = re.search(r'(?m)^title:\s*"?(.+?)"?\s*$', text[:300])
    if m: return m.group(1)
    m = re.search(r'(?m)^#\s+(.+)$', text)
    return m.group(1).strip() if m else fallback

records = []
files = sorted(glob.glob(os.path.join(ROOT, 'docs', '[01][0-9]-*.md'))) + \
        [os.path.join(ROOT, '00-SYSTEM-OVERVIEW.md')]
for path in files:
    if not os.path.exists(path): continue
    text = open(path).read()
    slug = os.path.basename(path).replace('.md', '')
    dtitle = doc_title(text, slug)
    # URL relative to site root
    url = ('' if slug.startswith('00') else 'docs/') + slug + '.html'
    # cut at Sources
    m = re.search(r'(?m)^## Sources\s*$', text)
    body = text[:m.start()] if m else text
    # split into sections by ## or ### headings
    parts = re.split(r'(?m)^(#{2,3})\s+(.+)$', body)
    # parts: [pre, level, heading, content, level, heading, content, ...]
    intro = clean(parts[0])
    if len(intro) > 60:
        records.append({'id': slug + '#top', 'doc': dtitle, 'section': 'Overview',
                        'url': url, 'text': intro[:2000]})
    for i in range(1, len(parts), 3):
        heading = parts[i+1].strip()
        content = clean(parts[i+2]) if i+2 < len(parts) else ''
        if len(content) < 40: continue
        anchor = kramdown_anchor(heading)
        records.append({'id': f'{slug}#{anchor}', 'doc': dtitle,
                        'section': clean(heading), 'url': f'{url}#{anchor}', 'text': content[:2500]})
out = os.path.join(ROOT, 'assets', 'search-index.json')
json.dump(records, open(out, 'w'), separators=(',', ':'))
print(f'{len(records)} searchable sections from {len(files)} docs -> {out} ({os.path.getsize(out)//1024} KB)')
