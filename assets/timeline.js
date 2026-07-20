/* Shared renderer for the TARP timeline family.
   Each page defines:
     window.TARPTIMELINE   — the data bundle {title, kicker?, lede, stats, eras, footer}
     window.TIMELINE_CURRENT — id of this page in the family nav ('overview'|'tunnels'|'majewski'|'thornton'|'mccook')
   Quotes may carry href (source-page link); images may carry href (full-size/plate source)
   and source_url (photo provenance page). */
(function () {
const LOCAL = location.protocol === 'file:';

const FAMILIES = {
  tarp: {
    title: 'Construction timelines',
    other: { label: 'River & habitat restoration →', href: 'restoration-timeline.html' },
    items: [
      { id: 'overview', href: 'deep-tunnel-timeline.html', label: 'The Deep Tunnel', sub: 'overview timeline' },
      { id: 'tunnels', href: 'tarp-tunnels-timeline.html', label: 'The Tunnels', sub: 'all four systems, exhaustive' },
      { id: 'majewski', href: 'majewski-timeline.html', label: 'Majewski Reservoir', sub: "the O'Hare basin" },
      { id: 'thornton', href: 'thornton-timeline.html', label: 'Thornton Reservoirs', sub: 'the quarry conversion' },
      { id: 'mccook', href: 'mccook-timeline.html', label: 'McCook Reservoir', sub: 'the hole MWRD dug itself' },
    ],
  },
  habitat: {
    title: 'Restoration timelines',
    other: { label: 'Deep Tunnel construction →', href: 'deep-tunnel-timeline.html' },
    items: [
      { id: 'overview', href: 'restoration-timeline.html', label: 'Restoring the Rivers', sub: 'overview timeline' },
      { id: 'north-branch', href: 'north-branch-restoration-timeline.html', label: 'North Branch corridor', sub: 'parks, dam removal, Wild Mile' },
      { id: 'bubbly-creek', href: 'bubbly-creek-restoration-timeline.html', label: 'Bubbly Creek', sub: 'the restoration that keeps almost happening' },
      { id: 'calumet', href: 'calumet-restoration-timeline.html', label: 'Calumet wetlands', sub: 'Superfund to sanctuary' },
      { id: 'programs', href: 'caws-programs-timeline.html', label: 'Programs & plans', sub: 'the enabling machinery' },
    ],
  },
};
const GROUP = FAMILIES[window.TIMELINE_GROUP || 'tarp'];
const FAMILY = GROUP.items;
const CUR = window.TIMELINE_CURRENT || 'overview';

document.getElementById('navlinks').innerHTML = [
  ['Flow map', LOCAL ? 'index.html' : './'],
  ['Geographic map', 'geo.html'],
  ['Deep Tunnel timeline', 'deep-tunnel-timeline.html'],
  ['Restoration timeline', 'restoration-timeline.html'],
  ['Overview', LOCAL ? '00-SYSTEM-OVERVIEW.md' : '00-SYSTEM-OVERVIEW.html'],
  ['Documents', 'docs/'], ['Galleries', LOCAL ? 'images/' : 'gallery/'],
  ['Search', LOCAL ? 'search.md' : 'search.html'],
  ['Sources', LOCAL ? 'SOURCES.md' : 'SOURCES.html'],
].map(([t, h]) => `<a href="${h}">${t}</a>`).join('');

// family nav (sidebar + mobile chips)
const famLinks = FAMILY.map(f =>
  `<a class="${f.id === CUR ? 'cur' : ''}" href="${f.href}">${f.label}` +
  (f.sub ? `<span class="sub">${f.sub}</span>` : '') + `</a>`).join('');
const other = `<a class="other" href="${GROUP.other.href}">${GROUP.other.label}</a>`;
const side = document.getElementById('famside');
if (side) side.innerHTML = `<div class="hd">${GROUP.title}</div>${famLinks}<div class="otherwrap">${other}</div>`;
const chips = document.getElementById('famchips');
if (chips) chips.innerHTML = FAMILY.map(f =>
  `<a class="${f.id === CUR ? 'cur' : ''}" href="${f.href}">${f.label}</a>`).join('') + other;

const D = window.TARPTIMELINE;
const KINDLABEL = { problem: 'Problem', decision: 'Decision', construction: 'Construction',
  milestone: 'Milestone', controversy: 'Controversy', outcome: 'Outcome' };
const SYSLABEL = { mainstream: 'Mainstream', calumet: 'Calumet', 'des-plaines': 'Des Plaines',
  ohare: "O'Hare/UDP", majewski: 'Majewski', thornton: 'Thornton', mccook: 'McCook', system: 'System-wide' };

const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const kick = document.getElementById('hero-kicker');
if (kick) kick.innerHTML = D.kicker ||
  (CUR !== 'overview' ? `<a href="${GROUP.items[0].href}">← ${GROUP.items[0].label}</a> · component timeline` : GROUP.title.replace(/s$/, ''));
document.getElementById('hero-title').textContent = D.title;
document.getElementById('hero-lede').innerHTML = D.lede;
document.getElementById('stats').innerHTML = D.stats.map(s =>
  `<div class="stat"><div class="n">${s.n}</div><div class="l">${s.l}</div></div>`).join('');
document.getElementById('legend').innerHTML = Object.entries(KINDLABEL).map(([k, l]) =>
  `<span><i style="background:var(--${k})"></i>${l}</span>`).join('');

function figureHtml(img) {
  const inner = `<img loading="lazy" src="${img.src}" alt="${esc(img.caption)}">`;
  const wrapped = img.href
    ? `<a class="imglink" href="${img.href}" target="_blank" rel="noopener" title="Open source">${inner}</a>` : inner;
  let cap = esc(img.caption);
  let credit = esc(img.credit || '');
  const links = [];
  if (img.href) links.push(`<a class="srclink" href="${img.href}" target="_blank" rel="noopener">view source ↗</a>`);
  if (img.source_url && img.source_url !== img.href)
    links.push(`<a class="srclink" href="${img.source_url}" target="_blank" rel="noopener">provenance ↗</a>`);
  if (links.length) credit += (credit ? ' · ' : '') + links.join(' · ');
  return `<figure class="evfig">${wrapped}<figcaption>${cap}<span class="credit">${credit}</span></figcaption></figure>`;
}

function quoteHtml(q, esc) {
  // NOTE: an <a> wrapping a <blockquote> gets split by the HTML parser's
  // formatting-element reconstruction — so linked quotes use a data-href +
  // click delegate instead, with the cite link as the accessible affordance.
  const src = q.href
    ? ` · <a class="srclink" href="${q.href}" target="_blank" rel="noopener">source page ↗</a>` : '';
  const href = q.href ? ` data-href="${q.href}" role="link" tabindex="0" title="Open the source page"` : '';
  return `<blockquote class="pull${q.href ? ' linked' : ''}"${href}>` +
    `<p>“${esc(q.text)}”</p><cite>— ${esc(q.attribution)}${src}</cite></blockquote>`;
}

const main = document.getElementById('timeline');
for (const era of D.eras) {
  const sec = document.createElement('section');
  sec.className = 'era';
  sec.innerHTML = `<div class="erahead"><div class="range">${era.range}</div><h2>${esc(era.title)}</h2></div>
    <p class="eralede">${era.lede}</p><div class="events"></div>`;
  const wrap = sec.querySelector('.events');
  for (const ev of era.events) {
    const a = document.createElement('article');
    a.className = `ev ${ev.weight || 'standard'}`;
    a.style.setProperty('--kc', `var(--${ev.kind})`);
    a.dataset.year = ev.year;
    let h = `<span class="dot"></span>
      <div class="meta"><span class="yr">${ev.year}</span>${ev.date ? `<span class="date">${esc(ev.date)}</span>` : ''}
        <span class="chip">${KINDLABEL[ev.kind] || ev.kind}</span></div>
      <h3>${esc(ev.title)}</h3>
      <div class="body"><p>${ev.body}</p></div>`;
    if (ev.image) h += figureHtml(ev.image);
    if (ev.quote) h += quoteHtml(ev.quote, esc);
    if (ev.system && ev.system.length && !(ev.system.length === 1 && ev.system[0] === 'system')) {
      h += `<div class="syschips">${ev.system.map(s => `<span>${SYSLABEL[s] || s}</span>`).join('')}</div>`;
    }
    if (ev.doc) {
      h += `<a class="doclink" href="${LOCAL ? 'docs/' + ev.doc + '.md' : 'docs/' + ev.doc + '.html'}">Read the full research →</a>`;
    }
    if (ev.srclinks && ev.srclinks.length) {
      h += `<div class="evsrc"><span class="lbl">Sources</span>` + ev.srclinks.map(s =>
        s.href
          ? `<a href="${s.href}"${/^https?:|\.jpg$/.test(s.href) ? ' target="_blank" rel="noopener"' : ''}>${esc(s.label)}</a>`
          : `<span class="noh">${esc(s.label)}</span>`
      ).join('') + `</div>`;
    }
    a.innerHTML = h;
    wrap.appendChild(a);
  }
  main.appendChild(sec);
}

document.getElementById('tail').innerHTML = D.footer;

// clickable quote blocks (whole-block affordance; cite link handles middle-click/a11y)
document.addEventListener('click', e => {
  const b = e.target.closest('blockquote.pull.linked');
  if (b && !e.target.closest('a')) window.open(b.dataset.href, '_blank', 'noopener');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('blockquote.pull.linked'))
    window.open(e.target.dataset.href, '_blank', 'noopener');
});

const pill = document.getElementById('yearpill');
const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      pill.textContent = e.target.dataset.year;
      pill.classList.add('on');
    }
  }
}, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
document.querySelectorAll('article.ev').forEach(el => io.observe(el));

addEventListener('scroll', () => {
  const h = document.documentElement;
  const p = h.scrollTop / (h.scrollHeight - h.clientHeight);
  document.getElementById('progress').style.width = (p * 100).toFixed(2) + '%';
  if (h.scrollTop < 250) pill.classList.remove('on');
}, { passive: true });
})();
