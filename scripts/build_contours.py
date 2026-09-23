#!/usr/bin/env python3
"""Elevation contours for the 3D model, from AWS Terrain Tiles (Mapzen
"terrarium" encoding, sourced from USGS NED/3DEP for the US).

Writes map-data/gis/contours.json: 10-ft contour lines projected into the
model's local metre frame (same projection as build_system3d.py). Tiles are
cached in the scratchpad, not the repo; the contour file is what ships.

Pure Python on purpose (no numpy/PIL on this machine): a tiny PNG decoder and
a marching-squares pass over a 2x-downsampled grid (~160 m per cell), which is
plenty for 10-ft contours on ground this flat.
"""
import json, math, os, sys, zlib, struct, urllib.request

Z = 11
LAT_S, LAT_N, LNG_W, LNG_E = 41.45, 42.12, -88.20, -87.48
LEVELS_FT = list(range(580, 760, 10))
LAT0, LNG0 = 41.85, -87.75
M_PER_DEG_LAT = 111132.0
M_PER_DEG_LNG = 111320.0 * math.cos(math.radians(LAT0))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get('TILE_CACHE', os.path.join(ROOT, 'scratchpad', 'terrain'))
OUT = os.path.join(ROOT, 'map-data', 'gis', 'contours.json')

def proj(lat, lng):
    return ((lng - LNG0) * M_PER_DEG_LNG, -(lat - LAT0) * M_PER_DEG_LAT)

def tile_xy(lat, lng, z):
    n = 2 ** z
    x = (lng + 180.0) / 360.0 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y

def tile_latlng(x, y, z):
    n = 2 ** z
    lng = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lat, lng

# ------------------------------------------------------------- PNG decode
def decode_png(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat, w, h, ct, bd = 8, b'', 0, 0, 0, 0
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        pos += 12 + ln
    assert bd == 8, 'expected 8-bit'
    ch = {2: 3, 6: 4, 0: 1, 4: 2}[ct]
    raw = zlib.decompress(idat)
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for row in range(h):
        f = raw[p]; p += 1
        cur = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(ch, stride): cur[i] = (cur[i] + cur[i - ch]) & 255
        elif f == 2:
            for i in range(stride): cur[i] = (cur[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = cur[i - ch] if i >= ch else 0
                cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = cur[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cur[i] = (cur[i] + pr) & 255
        out[row * stride:(row + 1) * stride] = cur
        prev = cur
    return w, h, ch, out

def terrarium_m(w, h, ch, px):
    grid = []
    for row in range(h):
        base = row * w * ch
        grid.append([(px[base + i * ch] * 256 + px[base + i * ch + 1] + px[base + i * ch + 2] / 256.0) - 32768.0
                     for i in range(w)])
    return grid

# ------------------------------------------------------------ fetch/mosaic
def fetch_tile(x, y):
    os.makedirs(CACHE, exist_ok=True)
    fn = os.path.join(CACHE, f'{Z}_{x}_{y}.png')
    if not os.path.exists(fn):
        url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png'
        with urllib.request.urlopen(url, timeout=30) as r:
            open(fn, 'wb').write(r.read())
    return open(fn, 'rb').read()

def build_grid():
    x0, y1 = tile_xy(LAT_S, LNG_W, Z)
    x1, y0 = tile_xy(LAT_N, LNG_E, Z)
    tx0, tx1 = int(math.floor(x0)), int(math.floor(x1))
    ty0, ty1 = int(math.floor(y0)), int(math.floor(y1))
    W = (tx1 - tx0 + 1) * 256
    H = (ty1 - ty0 + 1) * 256
    grid = [[0.0] * W for _ in range(H)]
    n = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            w, h, ch, px = decode_png(fetch_tile(tx, ty))
            g = terrarium_m(w, h, ch, px)
            oy, ox = (ty - ty0) * 256, (tx - tx0) * 256
            for r in range(256):
                grid[oy + r][ox:ox + 256] = g[r]
            n += 1
    print(f'  {n} tiles, mosaic {W}x{H}', file=sys.stderr)
    return grid, tx0, ty0, W, H

def downsample(grid, k):
    H, W = len(grid), len(grid[0])
    out = []
    for r in range(0, H - k + 1, k):
        row = []
        for c in range(0, W - k + 1, k):
            s = 0.0
            for dr in range(k):
                rr = grid[r + dr]
                for dc in range(k): s += rr[c + dc]
            row.append(s / (k * k))
        out.append(row)
    return out

# --------------------------------------------------------- marching squares
def contour_level(g, level):
    """Segments of the iso-line at `level`, as (r, c) float pairs, then joined."""
    H, W = len(g), len(g[0])
    segs = {}
    def interp(a, b, va, vb):
        t = 0.5 if vb == va else (level - va) / (vb - va)
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    edges = []
    for r in range(H - 1):
        g0, g1 = g[r], g[r + 1]
        for c in range(W - 1):
            v = (g0[c], g0[c + 1], g1[c + 1], g1[c])
            idx = (v[0] >= level) | ((v[1] >= level) << 1) | ((v[2] >= level) << 2) | ((v[3] >= level) << 3)
            if idx == 0 or idx == 15:
                continue
            P = [(r, c), (r, c + 1), (r + 1, c + 1), (r + 1, c)]
            E = [interp(P[0], P[1], v[0], v[1]), interp(P[1], P[2], v[1], v[2]),
                 interp(P[2], P[3], v[2], v[3]), interp(P[3], P[0], v[3], v[0])]
            table = {1: [(3, 0)], 2: [(0, 1)], 3: [(3, 1)], 4: [(1, 2)], 5: [(3, 0), (1, 2)], 6: [(0, 2)], 7: [(3, 2)],
                     8: [(2, 3)], 9: [(0, 2)], 10: [(0, 1), (2, 3)], 11: [(1, 2)], 12: [(1, 3)], 13: [(0, 1)], 14: [(3, 0)]}
            for a, b in table[idx]:
                edges.append((E[a], E[b]))
    return chain(edges)

def chain(edges):
    key = lambda p: (round(p[0], 3), round(p[1], 3))
    remaining = {}
    for i, (a, b) in enumerate(edges):
        remaining.setdefault(key(a), set()).add(i)
        remaining.setdefault(key(b), set()).add(i)
    alive = set(range(len(edges)))
    lines = []
    while alive:
        i = alive.pop()
        a, b = edges[i]
        remaining[key(a)].discard(i); remaining[key(b)].discard(i)
        line = [a, b]
        for end in (1, 0):
            while True:
                p = line[-1] if end else line[0]
                cands = remaining.get(key(p))
                if not cands: break
                j = cands.pop()
                if j not in alive: continue
                alive.discard(j)
                ea, eb = edges[j]
                remaining[key(ea)].discard(j); remaining[key(eb)].discard(j)
                nxt = eb if key(ea) == key(p) else ea
                if end: line.append(nxt)
                else: line.insert(0, nxt)
        lines.append(line)
    return lines

def blur(g):
    H, W = len(g), len(g[0])
    out = [row[:] for row in g]
    for r in range(1, H - 1):
        for c in range(1, W - 1):
            out[r][c] = (g[r-1][c-1] + g[r-1][c] + g[r-1][c+1] + g[r][c-1] + g[r][c] * 2 + g[r][c+1]
                         + g[r+1][c-1] + g[r+1][c] + g[r+1][c+1]) / 10.0
    return out

def simplify(pts, tol):
    """Douglas-Peucker."""
    if len(pts) < 3: return pts
    ax, az = pts[0]; bx, bz = pts[-1]
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz or 1e-9
    best, bi = -1, -1
    for i in range(1, len(pts) - 1):
        px, pz = pts[i]
        t = max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / L2))
        d = math.hypot(px - (ax + t * dx), pz - (az + t * dz))
        if d > best: best, bi = d, i
    if best > tol:
        return simplify(pts[:bi + 1], tol)[:-1] + simplify(pts[bi:], tol)
    return [pts[0], pts[-1]]

def main():
    print('fetching terrain…', file=sys.stderr)
    grid, tx0, ty0, W, H = build_grid()
    K = 2
    g = downsample(grid, K)
    gft = blur([[v * 3.28084 for v in row] for row in g])
    Hs, Ws = len(gft), len(gft[0])
    print(f'  grid {Ws}x{Hs}', file=sys.stderr)
    vals = [v for row in gft for v in row if v > -100]
    print(f'  elevation range {min(vals):.0f}–{max(vals):.0f} ft', file=sys.stderr)

    def rc_to_model(r, c):
        # cell centre -> tile pixel -> lat/lng -> model metres
        px = (c + 0.5) * K; py = (r + 0.5) * K
        lat, lng = tile_latlng(tx0 + px / 256.0, ty0 + py / 256.0, Z)
        return proj(lat, lng)

    # clip to the model's own extent (the district plus a margin), and thin
    sysd = json.load(open(os.path.join(ROOT, 'map-data', 'system3d.js'))) if False else None
    bx = (-42000, 26000); bz = (-32000, 46000)
    inside = lambda p: bx[0] <= p[0] <= bx[1] and bz[0] <= p[1] <= bz[1]
    levels = []
    total = 0
    for lv in LEVELS_FT:
        lines = contour_level(gft, lv)
        out = []
        for ln in lines:
            if len(ln) < 8: continue
            pts = [rc_to_model(r, c) for r, c in ln[::2]]
            pts = [p for p in pts if inside(p)]
            if len(pts) < 4: continue
            pts = simplify(pts, 90.0)
            L = sum(math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) for i in range(1, len(pts)))
            if L < 4000: continue
            out.append([[round(x), round(z)] for x, z in pts])
        if out:
            levels.append(dict(ft=lv, lines=out))
            total += len(out)
        print(f'  {lv} ft: {len(out)} lines', file=sys.stderr)
    meta = dict(source='AWS Terrain Tiles (Mapzen terrarium), z=11, USGS NED/3DEP for the US',
                url='https://registry.opendata.aws/terrain-tiles/', interval_ft=10,
                cell_m=round((40075016.686 * math.cos(math.radians(LAT0)) / (256 * 2 ** Z)) * K),
                projection='same local east-north-up metre frame as system3d.js',
                note='Lake Michigan surface is ~579 ft; the 580 ft contour is effectively the shoreline. '
                     'The 3D model draws the ground flat; these lines show the real relief for reference only.')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(dict(meta=meta, levels=levels), open(OUT, 'w'), separators=(',', ':'))
    print(f'contours.json: {total} lines across {len(levels)} levels ({os.path.getsize(OUT) // 1024} KB)')

if __name__ == '__main__':
    main()
