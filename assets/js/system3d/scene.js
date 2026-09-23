/* Geometry builders for the Chicago sewer-system 3D model.
 *
 * Scene units are metres, matching the data. x = east, z = south, y = up.
 * Ground is y = 0; everything underground is negative y.
 *
 * Two independent exaggeration factors, both surfaced in the UI:
 *   vExag  scales the vertical axis (depths and heights). Standard geologic
 *          section practice, because the system is ~50 km wide and ~90 m deep.
 *   dExag  scales conduit RADII only, so an 8-metre tunnel is visible across
 *          a 50-kilometre model. Reservoir and tank dimensions are never
 *          scaled by it -- those are always true shape.
 */
import * as THREE from 'three';

export const FT = 0.3048;

export const COL = {
  mainstream: 0xc98a2e, desplaines: 0xb5762a, calumet: 0x7fae3f, udp: 0x4aa3c4,
  water: 0x2f8fbf, waterHi: 0x59c3e8, cso: 0xd64545, ground: 0x2a323d,
  shaft: 0x9aa4b0, tideGate: 0x7d8fa5, connection: 0x5f6c7a,
  plant: 0x2c9a8f, pump: 0xb07acc, reservoir: 0x7a8694, outfall: 0xd64545,
  river: 0x3b6e8f, basin: 0x38424f,
};

/* ------------------------------------------------------------------ tubes */
/**
 * A tube with a per-vertex radius, built so that both the vertical
 * exaggeration and the radius exaggeration can be changed without rebuilding
 * the index buffer, and so the water inside it can be filled to a LEVEL
 * surface (which is how a sloping tunnel actually fills: from the deep
 * downstream end back upstream).
 */
export class Conduit {
  constructor(pts, depths, radii, opts = {}) {
    this.pts = pts;                 // [[x,z], ...] metres
    this.depths = depths;           // metres below ground, positive
    this.radii = radii;             // metres, true radius
    this.ring = opts.ring || 12;
    this.n = pts.length;
    this.frames = this._frames();
    const verts = this.n * this.ring;
    this.pos = new Float32Array(verts * 3);
    this.nrm = new Float32Array(verts * 3);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geom.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
    this.geom.setIndex(this._index());
    this.update(1, 1);
  }

  _frames() {
    // parallel-transport-ish frames: tunnels are near-horizontal, so a fixed
    // up vector is stable and avoids twist
    const f = [];
    for (let i = 0; i < this.n; i++) {
      const a = this.pts[Math.max(0, i - 1)], b = this.pts[Math.min(this.n - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      f.push({ nx: -tz, nz: tx });   // horizontal normal; vertical is world up
    }
    return f;
  }

  _index() {
    const idx = [];
    for (let i = 0; i < this.n - 1; i++) {
      for (let j = 0; j < this.ring; j++) {
        const j2 = (j + 1) % this.ring;
        const a = i * this.ring + j, b = i * this.ring + j2;
        const c = (i + 1) * this.ring + j, d = (i + 1) * this.ring + j2;
        idx.push(a, c, b, b, c, d);
      }
    }
    return idx;
  }

  /** Rewrite vertex positions for new exaggeration factors. */
  update(vExag, dExag) {
    const { ring, n } = this;
    for (let i = 0; i < n; i++) {
      const [x, z] = this.pts[i];
      const y = -this.depths[i] * vExag;
      const r = this.radii[i] * dExag;
      const { nx, nz } = this.frames[i];
      for (let j = 0; j < ring; j++) {
        const a = (j / ring) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const k = (i * ring + j) * 3;
        this.pos[k] = x + nx * r * ca;
        this.pos[k + 1] = y + r * sa;
        this.pos[k + 2] = z + nz * r * ca;
        this.nrm[k] = nx * ca; this.nrm[k + 1] = sa; this.nrm[k + 2] = nz * ca;
      }
    }
    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.normal.needsUpdate = true;
    this.geom.computeBoundingSphere();
  }

  /** Wetted cross-sectional area at point i for a level water surface at
   *  elevation `level` (metres below ground, positive down). True circular
   *  segment geometry, so the reported volume is the real one. */
  wetted(i, level) {
    const r = this.radii[i];
    const invert = this.depths[i] + r;            // bottom of the pipe
    const h = invert - level;                     // depth of water in the pipe
    if (h <= 0) return 0;
    if (h >= 2 * r) return Math.PI * r * r;
    const th = 2 * Math.acos(1 - h / r);
    return (r * r / 2) * (th - Math.sin(th));
  }

  /** Volume of water in this conduit for a level surface, cubic metres. */
  volumeAt(level) {
    let v = 0;
    for (let i = 1; i < this.n; i++) {
      const L = Math.hypot(this.pts[i][0] - this.pts[i - 1][0],
                           this.pts[i][1] - this.pts[i - 1][1]);
      v += (this.wetted(i, level) + this.wetted(i - 1, level)) / 2 * L;
    }
    return v;
  }
}

/** Water inside a Conduit, as a partial tube whose surface is level. */
export class ConduitWater {
  constructor(conduit) {
    this.c = conduit;
    this.ring = 14;                 // arc samples around the wetted perimeter
    const verts = conduit.n * this.ring;
    this.pos = new Float32Array(verts * 3);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const idx = [];
    for (let i = 0; i < conduit.n - 1; i++) {
      for (let j = 0; j < this.ring - 1; j++) {
        const a = i * this.ring + j, b = a + 1;
        const c = (i + 1) * this.ring + j, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    this.geom.setIndex(idx);
    this.level = Infinity;
  }

  /** level: metres below ground (positive down). Above the pipe crown the
   *  section is full; below the invert it is dry and collapses to the axis. */
  update(level, vExag, dExag) {
    const c = this.c;
    for (let i = 0; i < c.n; i++) {
      const [x, z] = c.pts[i];
      const r = c.radii[i] * dExag;
      const rTrue = c.radii[i];
      const y = -c.depths[i] * vExag;
      const { nx, nz } = c.frames[i];
      const invert = c.depths[i] + rTrue;
      let h = (invert - level) / (2 * rTrue);            // 0..1 fill fraction
      h = Math.max(0, Math.min(1, h));
      // half-angle measured from straight down
      const th = h <= 0 ? 0 : (h >= 1 ? Math.PI : Math.acos(1 - 2 * h));
      for (let j = 0; j < this.ring; j++) {
        const f = j / (this.ring - 1);
        const a = -Math.PI / 2 + (f * 2 - 1) * th;        // sweep across the bottom
        const k = (i * this.ring + j) * 3;
        const rr = h <= 0 ? 0 : r;
        this.pos[k] = x + nx * rr * Math.cos(a);
        this.pos[k + 1] = y + rr * Math.sin(a);
        this.pos[k + 2] = z + nz * rr * Math.cos(a);
      }
    }
    this.geom.attributes.position.needsUpdate = true;
    this.geom.computeBoundingSphere();
    this.level = level;
  }
}

/** Solve the level water surface that stores `volM3` across a set of
 *  conduits -- how a sloping tunnel system really fills. */
export function solveLevel(conduits, volM3) {
  if (volM3 <= 0) return Infinity;
  let lo = Infinity, hi = -Infinity;
  for (const c of conduits) {
    for (let i = 0; i < c.n; i++) {
      lo = Math.min(lo, c.depths[i] - c.radii[i]);   // crown (shallowest)
      hi = Math.max(hi, c.depths[i] + c.radii[i]);   // invert (deepest)
    }
  }
  let a = lo, b = hi;                                 // depth, positive down
  for (let k = 0; k < 40; k++) {
    const mid = (a + b) / 2;
    const v = conduits.reduce((s, c) => s + c.volumeAt(mid), 0);
    if (v > volM3) a = mid; else b = mid;             // deeper level = less water
  }
  return (a + b) / 2;
}

/* ------------------------------------------------------------ reservoirs */
/** Inverted truncated pyramid: the real shape of an excavated basin or pit. */
export function frustumGeometry(L, W, D, inset, bench = 0) {
  const hx = L / 2, hz = W / 2, ix = Math.max(1, hx - inset), iz = Math.max(1, hz - inset);
  const g = new THREE.BufferGeometry();
  const v = [], idx = [];
  const rings = bench > 0 ? bench + 1 : 2;
  for (let r = 0; r < rings; r++) {
    const f = r / (rings - 1);
    const x = hx + (ix - hx) * f, z = hz + (iz - hz) * f, y = -D * f;
    v.push(-x, y, -z, x, y, -z, x, y, z, -x, y, z);
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      const a = r * 4 + j, b = r * 4 + j2, c = (r + 1) * 4 + j, d = (r + 1) * 4 + j2;
      idx.push(a, c, b, b, c, d);
    }
  }
  const base = (rings - 1) * 4;
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Water filling a frustum to a given fraction of its capacity, by volume. */
export function frustumWaterGeometry(L, W, D, inset, fillFrac) {
  const f = Math.max(0, Math.min(1, fillFrac));
  if (f <= 0.0005) return null;
  const hx = L / 2, hz = W / 2, ix = Math.max(1, hx - inset), iz = Math.max(1, hz - inset);
  const A = (t) => (2 * (ix + (hx - ix) * t)) * (2 * (iz + (hz - iz) * t)); // t=0 bottom
  const total = (() => { let s = 0; const N = 200;
    for (let k = 0; k < N; k++) s += A((k + 0.5) / N) * (D / N); return s; })();
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2; let s = 0; const N = 120;
    for (let q = 0; q < N; q++) s += A(mid * (q + 0.5) / N) * (D * mid / N);
    if (s < f * total) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  const bx = ix, bz = iz;
  const tx = ix + (hx - ix) * t, tz = iz + (hz - iz) * t;
  const y0 = -D, y1 = -D + D * t;
  const v = [-bx, y0, -bz, bx, y0, -bz, bx, y0, bz, -bx, y0, bz,
             -tx, y1, -tz, tx, y1, -tz, tx, y1, tz, -tx, y1, tz];
  const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6];
  for (let j = 0; j < 4; j++) {
    const j2 = (j + 1) % 4;
    idx.push(j, j2, 4 + j, j2, 4 + j2, 4 + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.surfaceY = y1;
  return g;
}

/* --------------------------------------------------------- plant layouts */
/**
 * Lay a plant's sourced tank inventory out in process order along the site's
 * long axis. Counts and tank dimensions come from the data; the arrangement
 * is schematic and the viewer says so.
 */
export function layoutPlant(geom) {
  const out = [];
  if (!geom.rows || !geom.rows.length) return out;
  const L = geom.siteL, W = geom.siteW;
  const n = geom.rows.length;
  const bandW = L / n;
  geom.rows.forEach((row, ri) => {
    const cx = -L / 2 + bandW * (ri + 0.5);
    if (row.shape === 'cyl') {
      const r = row.dia / 2, gap = row.dia * 1.12;
      const perCol = Math.max(1, Math.floor(Math.min(W, W) / gap));
      const cols = Math.ceil(row.n / perCol);
      for (let i = 0; i < row.n; i++) {
        const c = Math.floor(i / perCol), k = i % perCol;
        out.push({ row: row.id, type: 'cyl', r, h: row.D,
                   x: cx + (c - (cols - 1) / 2) * gap,
                   z: -((perCol - 1) / 2) * gap + k * gap });
      }
    } else if (row.shape === 'box') {
      const gap = row.W * 1.3;
      for (let i = 0; i < row.n; i++) {
        out.push({ row: row.id, type: 'box', L: row.L, W: row.W, h: row.D,
                   x: cx, z: -((row.n - 1) / 2) * gap + i * gap });
      }
    } else {                                  // serpentine aeration passes
      const passes = row.n, pw = row.W / passes;
      for (let i = 0; i < passes; i++) {
        out.push({ row: row.id, type: 'box', L: Math.min(row.L, L * 0.9), W: pw * 0.82,
                   h: row.D, x: cx, z: -row.W / 2 + pw * (i + 0.5) });
      }
    }
  });
  return out;
}

/* --------------------------------------------------------------- helpers */
export function ribbon(pts, width, y) {
  const v = [], idx = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1;
    const nx = -tz / L * width / 2, nz = tx / L * width / 2;
    v.push(pts[i][0] + nx, y, pts[i][1] + nz, pts[i][0] - nx, y, pts[i][1] - nz);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function polyShape(rings, y) {
  const geos = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    const s = new THREE.Shape();
    s.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) s.lineTo(ring[i][0], ring[i][1]);
    s.closePath();
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(Math.PI / 2);
    g.translate(0, y, 0);
    geos.push(g);
  }
  return geos;
}

export function label(text, cls) {
  const d = document.createElement('div');
  d.className = 'lbl ' + (cls || '');
  d.textContent = text;
  return d;
}
