#!/usr/bin/env python3
"""Assemble all map-data/*.json into map-data/bundle.js (window.MAPDATA).
Run from repo root or map-data/. Idempotent; skips missing optional files."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
def load(name, default=None):
    p = os.path.join(HERE, name)
    if not os.path.exists(p):
        return default
    d = json.load(open(p))
    return d

# natural waterways / lakes predate their "modern form" year — they existed in 1850
FROM_OVERRIDE = {
    'chicago-river-main-stem': 1850, 'south-branch-chicago-river': 1850,
    'north-branch-chicago-river': 1850, 'calumet-river': 1850, 'little-calumet-river': 1850,
    'grand-calumet-river-il': 1850, 'des-plaines-river-lyons-lockport': 1850,
    'bubbly-creek-south-fork': 1850, 'lake-calumet': 1980, 'wolf-lake': 1958,
    'salt-creek': 1850, 'addison-creek': 1850, 'higgins-creek': 1850,
    'weller-creek': 1850, 'wb-dupage-river': 1850, 'skokie-river': 1850, 'willow-creek': 1850,
}

fac = load('facilities.json', [])
mod = load('waterways-modern.json', [])
for w in mod:
    if w['id'] in FROM_OVERRIDE:
        w['from'] = FROM_OVERRIDE[w['id']]

histraw = load('waterways-historic.json', {'features': []})
hist = histraw['features'] if isinstance(histraw, dict) else histraw
for h in hist:
    if h.get('from', 1850) < 1850:
        h['from'] = 1850

tunraw = load('tunnels.json', [])
tun = tunraw['features'] if isinstance(tunraw, dict) else tunraw

# connections: merge suburban + water-supply feeders + boundary connections
conn = []
sub = load('suburban-connections.json', {'connections': []})
conn += sub.get('connections', []) if isinstance(sub, dict) else sub
for extra in ('water-supply-feeders.json', 'boundary-wilmette.json', 'boundary-north.json', 'boundary-south.json'):
    d = load(extra)
    if d:
        conn += d.get('connections', [])

# boundary/external facilities merge into facilities
for extra in ('boundary-wilmette.json', 'boundary-north.json', 'boundary-south.json'):
    d = load(extra)
    if d:
        fac += d.get('facilities', [])

# shafts + vents
ref = load('tarp-refined.json', {'dropshafts': [], 'alignments': []})
news = load('tarp-points-news.json', {'dropshafts': [], 'vents': []})
shafts, seen = [], set()
for d in ref.get('dropshafts', []):
    shafts.append({'id': d['id'], 'name': d['name'], 'lat': d['lat'], 'lng': d['lng'],
                   'type': 'drop-shaft', 'from': d.get('from', 1985), 'approx': d.get('approx', False),
                   'note': d.get('source', '')[:160]})
    seen.add((round(d['lat'], 3), round(d['lng'], 3)))
for d in news.get('dropshafts', []):
    k = (round(d['lat'], 3), round(d['lng'], 3))
    if k in seen:
        continue
    shafts.append({'id': 'news-' + d['name'][:24].replace(' ', '-').lower(), 'name': d['name'],
                   'lat': d['lat'], 'lng': d['lng'], 'type': 'drop-shaft', 'from': 1985,
                   'approx': True, 'note': d.get('source', '')[:160]})
for v in news.get('vents', []):
    shafts.append({'id': 'vent-' + v['name'][:24].replace(' ', '-').lower(), 'name': v['name'],
                   'lat': v['lat'], 'lng': v['lng'], 'type': 'air-vent', 'from': 1985,
                   'approx': True, 'note': v.get('source', '')[:160]})

# CSO outfalls (toggle overlay)
g = load('gis/cso-outfall-points.geojson', {'features': []})
outfalls = [[round(f['geometry']['coordinates'][1], 5), round(f['geometry']['coordinates'][0], 5),
             f['properties'].get('LOCATION') or '', f['properties'].get('TARP_CONNECTION') or '',
             f['properties'].get('OWNER') or '', f['properties'].get('WATERWAY_REACH') or '']
            for f in g.get('features', [])]

bundle = {'facilities': fac, 'waterways': mod, 'historic': hist, 'tunnels': tun,
          'connections': conn, 'shafts': shafts, 'outfalls': outfalls}
out = os.path.join(HERE, 'bundle.js')
with open(out, 'w') as f:
    f.write('window.MAPDATA = ')
    json.dump(bundle, f, separators=(',', ':'))
    f.write(';\n')
print(f'bundle.js: {len(fac)} facilities, {len(mod)} waterways, {len(hist)} historic, '
      f'{len(tun)} tunnels, {len(conn)} connections, {len(shafts)} shafts, {len(outfalls)} outfalls '
      f'({round(os.path.getsize(out)/1024)} KB)')
