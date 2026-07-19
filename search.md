---
title: Search
---

# Search the documents

<input type="search" id="q" placeholder="Search all 17 research documents… (e.g. drop shaft, Racine Avenue, 1900 reversal, phosphorus)" autofocus
  style="width:100%;padding:12px 14px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);box-sizing:border-box;">
<p id="status" style="color:var(--ink2);font-size:13.5px;margin:10px 2px;"></p>
<div id="results"></div>

<p style="color:var(--ink2);font-size:13px;margin-top:24px;border-top:1px solid var(--line);padding-top:12px;">
This is a keyword search over the 16 detail documents and the overview, running entirely in your browser — no server, nothing sent anywhere. It matches words in the text and links you to the exact section. (Semantic/AI search against the full 2,000-source corpus runs on the archive's private mirror — see <a href="rag-search.html">archive search</a> — where the RAG index and local embedder live; it isn't part of the public site.)
</p>

<style>
  .sr { display:block; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 15px; margin-bottom:12px; text-decoration:none; }
  .sr:hover { border-color:var(--accent); }
  .sr .sd { font-size:12px; color:var(--ink2); text-transform:uppercase; letter-spacing:.5px; }
  .sr .st { font-weight:650; color:var(--ink); margin:2px 0 5px; font-size:15.5px; }
  .sr .sx { color:var(--ink2); font-size:13.5px; line-height:1.5; }
  .sr mark { background:color-mix(in srgb, var(--accent) 35%, transparent); color:var(--ink); padding:0 1px; border-radius:2px; }
</style>

<script src="{{ '/assets/js/lunr.min.js' | relative_url }}"></script>
<script>
(async function () {
  const base = "{{ '/' | relative_url }}".replace(/\/$/, '');
  const docs = await (await fetch(base + '/assets/search-index.json')).json();
  const byId = Object.fromEntries(docs.map(d => [d.id, d]));
  const idx = lunr(function () {
    this.ref('id'); this.field('doc', { boost: 3 }); this.field('section', { boost: 5 }); this.field('text');
    docs.forEach(d => this.add(d), this);
  });
  const q = document.getElementById('q'), status = document.getElementById('status'), out = document.getElementById('results');
  function esc(s){ return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function snippet(text, terms) {
    const low = text.toLowerCase();
    let at = -1;
    for (const t of terms) { const i = low.indexOf(t.toLowerCase()); if (i >= 0) { at = i; break; } }
    let s = at < 0 ? text.slice(0, 260) : text.slice(Math.max(0, at - 90), at + 200);
    s = esc(s);
    for (const t of terms) s = s.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'ig'), '<mark>$1</mark>');
    return (at > 90 ? '… ' : '') + s + ' …';
  }
  function run() {
    const query = q.value.trim();
    out.innerHTML = '';
    if (!query) { status.textContent = docs.length + ' sections indexed. Type to search.'; return; }
    let hits = [];
    try { hits = idx.search(query); } catch (e) {
      try { hits = idx.search(query.split(/\s+/).map(w => w + '*').join(' ')); } catch (e2) {}
    }
    if (!hits.length && !/[~*:+]/.test(query)) {
      try { hits = idx.search(query.split(/\s+/).map(w => w.replace(/[^\w]/g,'') + '*').filter(Boolean).join(' ')); } catch (e) {}
    }
    const terms = query.split(/\s+/).map(w => w.replace(/[^\w]/g,'')).filter(w => w.length > 1);
    status.textContent = hits.length + ' result' + (hits.length === 1 ? '' : 's');
    out.innerHTML = hits.slice(0, 40).map(h => {
      const d = byId[h.ref];
      return `<a class="sr" href="${base + '/' + d.url}"><div class="sd">${esc(d.doc)}</div>`
        + `<div class="st">${esc(d.section)}</div><div class="sx">${snippet(d.text, terms)}</div></a>`;
    }).join('');
  }
  q.addEventListener('input', run);
  // deep-link: /search.html?q=...
  const pre = new URLSearchParams(location.search).get('q');
  if (pre) { q.value = pre; }
  run();
})();
</script>
