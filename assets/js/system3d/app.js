/* Chicago sewer system — 3D model viewer.
 *
 * Data:      window.SYS3D, built by scripts/build_system3d.py
 * Hydrology: ./sim.js   (mass balance over sourced capacities)
 * Geometry:  ./scene.js (conduits, reservoirs, plant layout, flow shader)
 *
 *   1. state and bootstrap
 *   2. camera, input, picking, selection
 *   3. materials
 *   4. building the world (ground, geography, tunnels, shafts, reservoirs,
 *      plants, pumps, and the links that join them)
 *   5. the live view: interpolated, eased simulation state -> geometry
 *   6. panels, readouts, charts, HUD
 *   7. wiring and the render loop
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { SewerModel, CONFIGS } from './sim.js?v=8';
import * as SC from './scene.js?v=8';

const D = window.SYS3D;
const FT = SC.FT;
const $ = s => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const num = n => n == null ? '—' :
  (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() :
   Math.abs(n) >= 10 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(1) : n.toFixed(2));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lerp = (a, b, k) => a + (b - a) * k;
const clamp01 = x => Math.max(0, Math.min(1, x));
const fmtDur = sec => !isFinite(sec) || sec <= 0 ? '—' :
  sec < 90 ? `${sec.toFixed(0)} s` : sec < 5400 ? `${(sec / 60).toFixed(0)} min` : `${(sec / 3600).toFixed(1)} h`;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/* Metres of on-screen travel per second for water moving at 1 m/s. Every
 * animated flow runs off this one constant through SC.displaySpeed
 * (square-root compression), so all speeds stay in true proportion. */
const FLOW_BASE = 900;
/* Drop-shaft plunge, drawn at an energy-dissipated design value rather than
 * free fall, which over 250 ft would reach ~40 m/s. Assumed. */
const PLUNGE_MS = 8.0;
/* Playback: simulated time per real second. Fine steps at the bottom so a
 * single storm can be watched, coarse at the top for the ten-day drawdown. */
const SPEEDS = [[5 / 60, '5 min / s'], [15 / 60, '15 min / s'], [0.5, '30 min / s'], [1, '1 h / s'],
                [2, '2 h / s'], [4, '4 h / s'], [8, '8 h / s'], [24, '1 day / s']];
const speedHrs = () => SPEEDS[ST.speedIx][0];

/* ============================================================ 1. state */
const ST = {
  vExag: 18, dExag: 34, route: 'corridor',
  playing: false, speedIx: 3, pos: 0, run: null,
  storm: { inches: 2.0, hours: 24, shape: 'peaked', runoffC: 0.32, config: 'today', pumpLimit: 'plant' },
  layers: { geo: 1, contours: 1, tunnels: 1, water: 1, shafts: 1, connections: 0, links: 1, reservoirs: 1, plants: 1,
            pumps: 1, outfalls: 0, basins: 1, labels: 1, flow: 1 },
  selected: null, rainK: 0,
};
/* The eased live view of the simulation. Everything drawn reads from here,
 * never from a raw frame, so scrubbing, playing and switching scenarios all
 * move the water continuously. */
const V = { systems: {}, reservoirs: {}, plants: {}, basins: {}, csoRate: 0, csoCum: 0,
            inHr: 0, pumpedRate: 0, t: 0, ready: false };

const host = $('#view');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(host.clientWidth, host.clientHeight);
host.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(host.clientWidth, host.clientHeight);
labelRenderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
host.appendChild(labelRenderer.domElement);

const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const scene = new THREE.Scene();
scene.background = new THREE.Color(dark ? 0x11161d : 0xdde4ec);
scene.fog = new THREE.Fog(scene.background.getHex(), 60000, 240000);
const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 20, 500000);
scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x28303a, dark ? 1.6 : 2.1));
const sun = new THREE.DirectionalLight(0xffffff, dark ? 1.15 : 1.5); sun.position.set(-30000, 70000, -25000); scene.add(sun);
const fillLight = new THREE.DirectionalLight(0x8fb4d6, 0.5); fillLight.position.set(28000, 24000, 32000); scene.add(fillLight);
const world = new THREE.Group(); scene.add(world);
const layerG = {};
for (const k of Object.keys(ST.layers)) { const g = new THREE.Group(); g.name = k; world.add(g); layerG[k] = g; }

/* registries */
const pickables = [];
const info = new Map();
const conduits = [];        // { sid, feat, c, w, mesh, wm, level }
const sysConduits = {};     // sid -> [Conduit]
const sysGeomVol = {};      // sid -> m^3 the drawn tunnels hold
const shaftSets = [];
const resObjects = {};
const plantObjects = {};
const pumpObjects = {};
const links = [];           // flowing connections between facilities
const labelObjs = [];
const flowMats = new Set();
let ground, grid, rain;
function reg(mesh, rec) { info.set(mesh.uuid, rec); pickables.push(mesh); }
const facById = id => D.facilities.find(f => f.id === id);

/* ============================================ 2. camera, input, picking */
const controls = new OrbitControls(camera, renderer.domElement);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.11, maxPolarAngle: Math.PI * 0.497,
  zoomToCursor: true, zoomSpeed: 0.85, rotateSpeed: 0.75, panSpeed: 0.9, minDistance: 30, maxDistance: 400000 });
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

const KEYS = new Set();
let shiftHeld = false;
const keyVel = { az: 0, pol: 0, panX: 0, panY: 0, dolly: 0 };
const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Home', 'Escape', '?'];
const inField = e => e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
addEventListener('keydown', e => {
  shiftHeld = e.shiftKey;
  if (inField(e)) return;
  if (NAV_KEYS.includes(e.key)) {
    KEYS.add(e.key);
    if (e.key === 'Home') frameAll();
    if (e.key === 'Escape') { inspect(null); clearHi(); }
    if (e.key === '?') $('#keyhelp').classList.toggle('on');
    e.preventDefault();
  } else if (e.key === 'l' || e.key === 'L') $('#legend').classList.toggle('hidden');
  else if (e.key === ' ') { togglePlay(); e.preventDefault(); }
});
addEventListener('keyup', e => { KEYS.delete(e.key); shiftHeld = e.shiftKey; });
addEventListener('blur', () => { KEYS.clear(); shiftHeld = false; });

const _sph = new THREE.Spherical(), _off = new THREE.Vector3();
function applyKeys(dt) {
  const az = (KEYS.has('ArrowLeft') ? 1 : 0) - (KEYS.has('ArrowRight') ? 1 : 0);
  const pol = (KEYS.has('ArrowUp') ? 1 : 0) - (KEYS.has('ArrowDown') ? 1 : 0);
  const dolly = (KEYS.has('-') || KEYS.has('_') ? 1 : 0) - (KEYS.has('+') || KEYS.has('=') ? 1 : 0);
  const ease = 1 - Math.pow(0.001, dt);
  keyVel.az = lerp(keyVel.az, shiftHeld ? 0 : az, ease);
  keyVel.pol = lerp(keyVel.pol, shiftHeld ? 0 : pol, ease);
  keyVel.panX = lerp(keyVel.panX, shiftHeld ? az : 0, ease);
  keyVel.panY = lerp(keyVel.panY, shiftHeld ? pol : 0, ease);
  keyVel.dolly = lerp(keyVel.dolly, dolly, ease);
  if (Math.abs(keyVel.az) + Math.abs(keyVel.pol) + Math.abs(keyVel.dolly) + Math.abs(keyVel.panX) + Math.abs(keyVel.panY) < 1e-3) return;
  _off.copy(camera.position).sub(controls.target);
  _sph.setFromVector3(_off);
  _sph.theta += keyVel.az * 1.4 * dt;
  _sph.phi = Math.max(0.02, Math.min(controls.maxPolarAngle, _sph.phi - keyVel.pol * dt));
  _sph.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, _sph.radius * Math.pow(2.2, keyVel.dolly * dt)));
  _off.setFromSpherical(_sph);
  if (keyVel.panX || keyVel.panY) {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const fwd = new THREE.Vector3().crossVectors(camera.up, right).normalize();
    const k = _sph.radius * 0.9 * dt;
    controls.target.addScaledVector(right, -keyVel.panX * k).addScaledVector(fwd, keyVel.panY * k);
  }
  camera.position.copy(controls.target).add(_off);
  camera.lookAt(controls.target);
}

let camAnim = null;
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
function repivot(pt) { camAnim = { kind: 'slide', t0: performance.now(), dur: 520, from: controls.target.clone(), to: pt.clone() }; }
function flyTo(facId) {
  const f = facById(facId); if (!f) return;
  const span = f.kind === 'reservoir' ? Math.max(f.geom.L, f.geom.W) : f.kind === 'wrp' ? Math.max(f.geom.siteL, f.geom.siteW) : 500;
  setScale(1, 1);
  camAnim = { kind: 'fly', t0: performance.now(), dur: 900, from: camera.position.clone(), tgt0: controls.target.clone(),
    tgt1: V3(f.x, -span * 0.08, f.z), to: V3(f.x + span * 1.25, span * 1.0, f.z + span * 1.6) };
}
function stepCamAnim(now) {
  if (!camAnim) return;
  const k = Math.min(1, (now - camAnim.t0) / camAnim.dur);
  if (camAnim.kind === 'slide') {
    const d = new THREE.Vector3().lerpVectors(camAnim.from, camAnim.to, easeOut(k)).sub(controls.target);
    controls.target.add(d); camera.position.add(d);
  } else {
    const e = easeInOut(k);
    camera.position.lerpVectors(camAnim.from, camAnim.to, e);
    controls.target.lerpVectors(camAnim.tgt0, camAnim.tgt1, e);
  }
  if (k >= 1) camAnim = null;
}
function frameAll() {
  const box = new THREE.Box3();
  for (const t of D.tunnels) for (const p of t.corridor) box.expandByPoint(V3(p[0], 0, p[1]));
  for (const f of D.facilities) if (f.kind === 'reservoir' || f.kind === 'tarp-ps' || (f.spec.dmf && f.spec.dmf.v >= 400)) box.expandByPoint(V3(f.x, 0, f.z));
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const vFov = camera.fov * Math.PI / 180;
  const aspect = (isFinite(camera.aspect) && camera.aspect > 0.05) ? camera.aspect : 1.6;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const dist = Math.max(s.x / 2 / Math.tan(hFov / 2), (s.z * 0.62) / 2 / Math.tan(vFov / 2)) * 0.98;
  controls.target.set(c.x, -900, c.z);
  const az = -0.42, elv = 0.42;
  camera.position.set(c.x + dist * Math.sin(az) * Math.cos(elv), dist * Math.sin(elv), c.z + dist * Math.cos(az) * Math.cos(elv));
  camAnim = null; controls.update();
}

const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const pickRank = k => (k === 'basin' ? 3 : k === 'outfalls' ? 2 : k === 'geo' ? 4 : 0);
function pickAt(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const visible = pickables.filter(m => { let p = m; while (p) { if (p.name && ST.layers[p.name] === 0) return false; p = p.parent; } return true; });
  let hit = null, best = 99;
  for (const x of ray.intersectObjects(visible, false)) {
    const rec = info.get(x.object.uuid); if (!rec) continue;
    const q = pickRank(rec.kind);
    if (q < best) { best = q; hit = x; }
    if (q === 0) break;
  }
  return hit;
}
function recordFor(hit) {
  const rec = info.get(hit.object.uuid);
  if (!rec || rec.kind !== 'shaftset') return rec;
  const s = rec.items[hit.instanceId];
  const sys = s.system ? D.systems[s.system] : null;
  return { kind: 'shaft', title: s.name || s.tc,
    sub: s.system ? `${sys.name} — ${s.kind === 'tide-gate' ? 'tide gate' : 'drop shaft'}` : 'intercepting-sewer connecting structure',
    rows: [['MWRD structure ID', s.tc, 'gis'], ['Location', s.loc || '—', 'gis'], ['Owner', s.owner || '—', 'gis'],
      ['Receiving water', s.reach || '—', 'gis'], ['Outfalls served', String(s.outfalls), 'gis'],
      s.system ? ['Drops to', `${s.depth} ft below grade, into ${num(s.dia)} ft of tunnel`, 'derived'] : null,
      s.system ? ['Shaft diameter', 'drawn at a representative 10 ft', 'assumed'] : null,
      s.dist != null ? ['Offset from the as-traced tunnel corridor', `${s.dist} m`, 'derived'] : null].filter(Boolean),
    note: s.system ? 'A "Chicago style" plunge drop shaft: a split air/water shaft with a vent chamber at the top, engineered from 1975 physical hydraulic-model testing at the St. Anthony Falls Hydraulic Laboratory. MWRD does not publish individual shaft diameters; the sourced range is 4–25 ft.'
                   : 'A connecting structure on the intercepting sewers, not a TARP drop shaft.',
    doc: s.system ? 'doc09' : 'doc07' };
}
renderer.domElement.addEventListener('pointerdown', e => { mouse.sx = e.clientX; mouse.sy = e.clientY; });
renderer.domElement.addEventListener('pointerup', e => {
  if (Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) > 5) return;
  const hit = pickAt(e.clientX, e.clientY);
  if (!hit) { inspect(null); clearHi(); return; }
  const rec = recordFor(hit);
  inspect(rec);
  rec.kind === 'shaft' ? highlightInstance(hit.object, hit.instanceId, rec.title) : highlight(hit.object, rec.title);
});
renderer.domElement.addEventListener('dblclick', e => {
  const hit = pickAt(e.clientX, e.clientY);
  let pt = hit ? hit.point.clone() : null;
  if (!pt) { const p = new THREE.Vector3(); if (ray.ray.intersectPlane(new THREE.Plane(V3(0, 1, 0), 0), p)) pt = p; }
  if (pt) repivot(pt);
});
let hoverAt = 0;
renderer.domElement.addEventListener('pointermove', e => {
  const now = performance.now(); if (now - hoverAt < 60) return; hoverAt = now;
  const tip = $('#tip');
  const hit = pickAt(e.clientX, e.clientY);
  if (!hit) { tip.style.display = 'none'; renderer.domElement.style.cursor = ''; return; }
  const rec = recordFor(hit), r = renderer.domElement.getBoundingClientRect();
  tip.innerHTML = `<b>${esc(rec.title)}</b>${rec.sub ? `<span>${esc(rec.sub)}</span>` : ''}<i>click for dimensions · double-click to orbit here</i>`;
  tip.style.display = 'block'; tip.style.left = (e.clientX - r.left + 14) + 'px'; tip.style.top = (e.clientY - r.top + 14) + 'px';
  renderer.domElement.style.cursor = 'pointer';
});
renderer.domElement.addEventListener('pointerleave', () => { $('#tip').style.display = 'none'; });

let hiMesh = null, hiChip = null, hiDim = null;
function clearHi() {
  if (hiMesh) { world.remove(hiMesh); hiMesh = null; }
  if (hiChip) { layerG.labels.remove(hiChip); hiChip = null; }
  if (hiDim) { world.remove(hiDim); hiDim = null; }
}
function depthDim(x, z, yTop, yBottom, title) {
  const top = Math.max(yTop, 0), g = new THREE.Group();
  const dash = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V3(x, top, z), V3(x, yBottom, z)]),
    new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 90, gapSize: 60 }));
  dash.computeLineDistances();
  const tick = y => new THREE.Line(new THREE.BufferGeometry().setFromPoints([V3(x - 120, y, z), V3(x + 120, y, z)]), new THREE.LineBasicMaterial({ color: 0xffd166 }));
  g.add(dash, tick(top), tick(yBottom)); world.add(g); hiDim = g;
  const d = el('div', 'lbl sel'), ft = -yBottom / ST.vExag / FT;
  d.innerHTML = `<b>${esc(title)}</b>` + (ft > 3 ? `<i>${ft.toFixed(0)} ft below grade</i>` : '');
  hiChip = new CSS2DObject(d); hiChip.position.set(x, top + 40, z); layerG.labels.add(hiChip);
}
function highlight(m, title) {
  clearHi();
  const b = new THREE.Box3().setFromObject(m), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  hiMesh = new THREE.Mesh(new THREE.BoxGeometry(s.x * 1.04 + 40, s.y * 1.04 + 40, s.z * 1.04 + 40), M.hi);
  hiMesh.position.copy(c); world.add(hiMesh);
  depthDim(c.x, c.z, b.max.y, b.min.y, title);
}
function highlightInstance(im, id, title) {
  clearHi();
  const m4 = new THREE.Matrix4(); im.getMatrixAt(id, m4);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m4.decompose(p, q, s);
  hiMesh = new THREE.Mesh(new THREE.BoxGeometry(s.x * 4 + 200, s.y * 1.1, s.z * 4 + 200), M.hi);
  hiMesh.position.copy(p); world.add(hiMesh);
  depthDim(p.x, p.z, p.y + s.y / 2, p.y - s.y / 2, title);
}

/* ======================================================== 3. materials */
const std = o => new THREE.MeshStandardMaterial(o);
const flow = (o, fo) => { const m = SC.makeFlowMaterial(std(o), fo); flowMats.add(m); return m; };
/** A private copy of a flow material (own uniforms, shared clock). */
function flowClone(base, over) {
  const m = base.clone();
  const u = {};
  for (const [k, v] of Object.entries(base.userData.flow))
    u[k] = k === 'uTime' ? v : { value: v.value instanceof THREE.Color ? v.value.clone() : v.value };
  Object.assign(u, Object.fromEntries(Object.entries(over || {}).map(([k, v]) => [k, { value: v }])));
  m.onBeforeCompile = sh => { Object.assign(sh.uniforms, u); base.onBeforeCompile(sh); Object.assign(sh.uniforms, u); };
  m.customProgramCacheKey = () => 'flow';
  m.userData.flow = u;
  flowMats.add(m);
  return m;
}
const M = {
  // pressurised mains between facilities: full-bore tubes
  pipeSewage: flow({ color: 0x8a6a3a, roughness: 0.5, emissive: 0x3a2a12, emissiveIntensity: 0.5, transparent: true, opacity: 0.9 }, { wave: 240, strength: 1.0, hi: 0xffd9a0, fresnel: 0.5 }),
  pipeReturn: flow({ color: 0xd9a24a, roughness: 0.45, emissive: 0x4a3410, emissiveIntensity: 0.6, transparent: true, opacity: 0.92 }, { wave: 240, strength: 1.1, hi: 0xffe7a0, fresnel: 0.5 }),
  pipeEffluent: flow({ color: 0x2c9a8f, roughness: 0.3, emissive: 0x0e3d38, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }, { wave: 220, strength: 1.0, hi: 0xa8fff0, fresnel: 0.5 }),
  pipeTunnel: flow({ color: 0x2f8fbf, roughness: 0.22, metalness: 0.12, emissive: 0x0d3a52, emissiveIntensity: 0.55, transparent: true, opacity: 0.9 }, { wave: 240, strength: 0.9, fresnel: 0.5 }),
  pipeCso: flow({ color: 0xd64545, roughness: 0.5, emissive: 0x4a1010, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }, { wave: 220, strength: 1.2, hi: 0xffb39a, fresnel: 0.5 }),
  shaft: std({ color: SC.COL.shaft, roughness: 0.75, metalness: 0.15 }),
  conn: std({ color: SC.COL.connection, roughness: 0.85 }),
  rock: std({ color: dark ? 0x4d5761 : 0x8f99a5, roughness: 0.96, side: THREE.DoubleSide, flatShading: true }),
  resWater: flow({ color: 0x2d93cc, roughness: 0.12, metalness: 0.25, emissive: 0x11557a, emissiveIntensity: 0.75, transparent: true, opacity: 0.97, side: THREE.DoubleSide },
    { useUV: true, len: 900, speed: 6, wave: 140, strength: 0.35 }),
  pad: std({ color: dark ? 0x333c47 : 0xbac3ce, roughness: 1 }),
  bldg: std({ color: SC.COL.pump, roughness: 0.7 }),
  river: new THREE.MeshBasicMaterial({ color: SC.COL.river, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
  basin: new THREE.MeshBasicMaterial({ color: SC.COL.basin, transparent: true, opacity: 0.17, side: THREE.DoubleSide, depthWrite: false }),
  outfall: std({ color: SC.COL.outfall, roughness: 0.6, emissive: 0x3d0e0e }),
  hi: new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true, transparent: true, opacity: 0.55 }),
  riser: flow({ color: 0xc9a227, roughness: 0.4, metalness: 0.5, emissive: 0x3a2a05, emissiveIntensity: 0.6 }, { useUV: true, len: 100, speed: 0, wave: 18, strength: 1.1, hi: 0xffe7a0 }),
  train: flow({ color: 0x3f8fb0, roughness: 0.3, emissive: 0x0d3a52, emissiveIntensity: 0.6, transparent: true, opacity: 0.9, side: THREE.DoubleSide }, { wave: 60, strength: 1.0 }),
  // links between facilities: sewage (interceptors, return mains), treated effluent, reservoir connections
  tankWall: std({ color: 0xb4bec9, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide }),
  solidsWall: std({ color: 0x8a7f6a, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide }),
  lake: new THREE.MeshBasicMaterial({ color: dark ? 0x1d3a52 : 0x9ec4de, transparent: true, opacity: dark ? 0.35 : 0.45, side: THREE.DoubleSide, depthWrite: false }),
  geoLine: new THREE.LineBasicMaterial({ color: dark ? 0x4a6a86 : 0x6f95b3, transparent: true, opacity: 0.55 }),
  geoFaint: new THREE.LineBasicMaterial({ color: dark ? 0x35506a : 0x8fb0cc, transparent: true, opacity: 0.35 }),
  district: new THREE.LineBasicMaterial({ color: dark ? 0x6e7d8d : 0x5a6676, transparent: true, opacity: 0.6 }),
};
const tunnelMat = {};
for (const [sid, s] of Object.entries(D.systems))
  tunnelMat[sid] = flow({ color: new THREE.Color(s.color), roughness: 0.55, metalness: 0.1, transparent: true, opacity: 0.34,
    side: THREE.DoubleSide, depthWrite: false, emissive: new THREE.Color(s.color).multiplyScalar(0.12) },
    { strength: 0, streak: 0, fresnel: 0.9, rings: 520 });
M.waterBody = flow({ color: 0x1f6f9a, roughness: 0.35, metalness: 0.1, emissive: 0x0a2d40, emissiveIntensity: 0.6, side: THREE.DoubleSide },
  { wave: 220, strength: 0.35, hi: 0x8fd3f0 });
M.waterSurf = flow({ color: 0x3aa3d8, roughness: 0.08, metalness: 0.3, emissive: 0x145d85, emissiveIntensity: 0.7, side: THREE.DoubleSide,
  transparent: true, opacity: 0.96 }, { wave: 200, strength: 1.25, hi: 0xdff6ff });
M.waterSurfFull = flow({ color: 0x5aa7d6, roughness: 0.2, metalness: 0.12, emissive: 0x7a2a1a, emissiveIntensity: 0.55, side: THREE.DoubleSide },
  { wave: 220, strength: 0.9, hi: 0xffc9a8 });
const shaftWaterMat = {};
for (const sid of Object.keys(D.systems))
  shaftWaterMat[sid] = flow({ color: SC.COL.waterHi, roughness: 0.2, emissive: 0x1d6f92, emissiveIntensity: 0.8, transparent: true, opacity: 0.92 },
    { useUV: true, len: 90, speed: SC.displaySpeed(PLUNGE_MS, FLOW_BASE), wave: 14, strength: 1.2, dir: -1 });

/* ================================================ 4. building the world */
const pts2 = feat => ST.route === 'corridor' ? feat.corridor : feat.pts;
const _d = new THREE.Object3D();

/** A flat strip along a 3-D polyline, carrying the flow attributes. */
function flowRibbon(pts, width) {
  const v = [], uv = [], fl = [], vel = [], idx = [], cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z; const L = Math.hypot(tx, tz) || 1;
    const nx = -tz / L * width / 2, nz = tx / L * width / 2;
    v.push(pts[i].x + nx, pts[i].y, pts[i].z + nz, pts[i].x - nx, pts[i].y, pts[i].z - nz);
    uv.push(0, cum[i], 1, cum[i]); fl.push(cum[i], cum[i]); vel.push(0, 0);
  }
  for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(fl, 1));
  g.setAttribute('aVel', new THREE.Float32BufferAttribute(vel, 1));
  g.setIndex(idx); g.computeVertexNormals(); g.userData.cum = cum;
  return g;
}
function addLabel(text, x, z, y, cls, maxDist) {
  const d = el('div', 'lbl ' + (cls || '')); d.textContent = text;
  const o = new CSS2DObject(d); o.position.set(x, y, z); layerG.labels.add(o);
  labelObjs.push({ o, y, d: maxDist || 1e9, div: d });
  return d;
}
function addGauge(cls, x, y, z, maxDist) {
  const d = el('div', 'lbl ' + cls + ' gauge3d');
  const o = new CSS2DObject(d); o.position.set(x, y, z); layerG.labels.add(o);
  labelObjs.push({ o, y, d: maxDist, div: d });
  return { div: d, obj: o };
}
const gaugeHtml = (name, pct, vTxt) =>
  `<b>${esc(name)}</b><span class="bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></span><span class="pct">${(pct * 100).toFixed(0)}%</span><i>${vTxt}</i>`;

/* --------------------------------------------------- ground and geography */
function buildGround() {
  const box = new THREE.Box3();
  for (const t of D.tunnels) for (const p of t.corridor) box.expandByPoint(V3(p[0], 0, p[1]));
  for (const f of D.facilities) box.expandByPoint(V3(f.x, 0, f.z));
  const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
  const span = Math.max(sz.x, sz.z) * 1.45;
  const g = new THREE.PlaneGeometry(span, span); g.rotateX(-Math.PI / 2);
  ground = new THREE.Mesh(g, std({ color: dark ? 0x222a34 : 0xc4cedb, roughness: 1, transparent: true, opacity: 0.30, depthWrite: false, side: THREE.DoubleSide }));
  ground.position.set(c.x, 0, c.z); ground.renderOrder = -3; world.add(ground);
  grid = new THREE.GridHelper(span, Math.round(span / 1609.344), dark ? 0x2e3a47 : 0xaab5c2, dark ? 0x232c36 : 0xbcc6d1);
  grid.position.set(c.x, 1, c.z); grid.material.transparent = true; grid.material.opacity = 0.42; world.add(grid);
  world.userData.bounds = box;

  const rb = new THREE.Box3();
  for (const b of D.basins) for (const ring of b.outline) for (const p of ring) rb.expandByPoint(V3(p[0], 0, p[1]));
  if (!rb.isEmpty()) {
    const N = 3200, pos = new Float32Array(N * 3), seed = new Float32Array(N), s2 = rb.getSize(new THREE.Vector3()), mn = rb.min;
    for (let i = 0; i < N; i++) { pos[i * 3] = mn.x + Math.random() * s2.x; pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = mn.z + Math.random() * s2.z; seed[i] = Math.random(); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0x9ec9ea, size: 70, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false });
    const pts = new THREE.Points(rg, mat); pts.frustumCulled = false; world.add(pts);
    rain = { pts, pos, seed, N, mat, H: 2600 };
  }
}
/* Rough geography: everything here is line work at grade, or a translucent
 * sheet with depth writes off, so nothing underground is ever hidden by it. */
function buildGeo() {
  const G = D.geo; if (!G) return;
  const bounds = world.userData.bounds;
  // Lake Michigan: the sheet east of the shoreline, out to the model's edge
  if (G.shoreline && G.shoreline.length > 3) {
    const sh = G.shoreline.slice().sort((a, b) => a[1] - b[1]);
    const east = Math.max(bounds.max.x, 60000) + 40000;
    const s = new THREE.Shape();
    s.moveTo(sh[0][0], sh[0][1] - 20000);
    for (const p of sh) s.lineTo(p[0], p[1]);
    s.lineTo(sh[sh.length - 1][0], sh[sh.length - 1][1] + 20000);
    s.lineTo(east, sh[sh.length - 1][1] + 20000); s.lineTo(east, sh[0][1] - 20000); s.closePath();
    const g = new THREE.ShapeGeometry(s); g.rotateX(Math.PI / 2); g.translate(0, 3, 0);
    const lake = new THREE.Mesh(g, M.lake); lake.renderOrder = -2; layerG.geo.add(lake);
    const shore = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sh.map(p => V3(p[0], 4, p[1]))), M.geoLine);
    layerG.geo.add(shore);
    const mid = sh[Math.floor(sh.length / 2)];
    addLabel('Lake Michigan', mid[0] + 9000, mid[1], 6, 'geo', 1e9);
    reg(lake, { kind: 'geo', title: 'Lake Michigan', sub: 'geographic context',
      rows: [['Shoreline', 'the eastern edge of MWRD’s service-area polygons, north of the state line', 'derived']],
      note: 'The lake is the reason the whole system exists: the river was reversed in 1900 to keep sewage out of it. Drawn rough, from data already in the archive.', doc: 'doc14' });
  }
  for (const ring of (G.district || [])) {
    const ln = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring.map(p => V3(p[0], 4, p[1]))), M.district);
    layerG.geo.add(ln);
  }
  for (const w of (G.waterways || [])) {
    if (w.pts.length < 2) continue;
    const major = /Chicago River|Sanitary and Ship|North Shore Channel|Calumet-Sag|Cal-Sag|Calumet River|Little Calumet River$|Des Plaines River$|Salt Creek$|Bubbly Creek/i.test(w.name);
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(w.pts.map(p => V3(p[0], 4, p[1]))), major ? M.geoLine : M.geoFaint);
    layerG.geo.add(ln);
  }
  for (const lk of (G.lakes || [])) {
    for (const g of SC.polyShape([lk.pts], 3)) { const m = new THREE.Mesh(g, M.lake); m.renderOrder = -2; layerG.geo.add(m); }
    const cx = lk.pts.reduce((a, p) => a + p[0], 0) / lk.pts.length, cz = lk.pts.reduce((a, p) => a + p[1], 0) / lk.pts.length;
    addLabel(lk.name, cx, cz, 6, 'geo', 40000);
  }
}
/* Ground contours, fetched on demand: 10-ft lines from USGS-derived terrain
 * tiles, drawn at grade as thin line work. The 580 ft line is the shoreline. */
async function buildContours() {
  let data;
  try { data = await (await fetch('map-data/gis/contours.json')).json(); }
  catch (e) { console.warn('contours unavailable', e); return; }
  const major = new THREE.LineBasicMaterial({ color: dark ? 0x7d8fa5 : 0x5f6f80, transparent: true, opacity: 0.55 });
  const minor = new THREE.LineBasicMaterial({ color: dark ? 0x4a5666 : 0x8a97a6, transparent: true, opacity: 0.35 });
  let labelled = 0;
  for (const lv of data.levels) {
    const isMajor = lv.ft % 50 === 0;
    for (const ln of lv.lines) {
      const pts = ln.map(p => V3(p[0], 5, p[1]));
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const m = new THREE.Line(g, isMajor ? major : minor); layerG.contours.add(m);
      // label the long lines, in the middle, at the elevation, only when close
      if (isMajor && ln.length > 30 && labelled < 80) {
        const mid = pts[Math.floor(pts.length / 2)];
        addLabel(`${lv.ft} ft`, mid.x, mid.z, 6, 'contour', 22000); labelled++;
      }
    }
  }
  D.contourMeta = data.meta;
}

function buildSurface() {
  for (const w of D.waterways) if (w.pts.length >= 2) layerG.geo.add(new THREE.Mesh(SC.ribbon(w.pts, 140, 6), M.river));
  for (const b of D.basins) {
    for (const g of SC.polyShape(b.outline, 2)) {
      const mm = M.basin.clone(); mm.color = new THREE.Color(b.color); mm.opacity = 0.13;
      const m = new THREE.Mesh(g, mm); layerG.basins.add(m);
      reg(m, { kind: 'basin', title: b.name, sub: 'MWRD combined sewer area',
        rows: [['Combined sewer area', `${b.areaSqMi.v} sq mi`, b.areaSqMi.s], ['Treatment plant', (facById(b.plant) || {}).name || b.plant, 'gis'],
               ['TARP systems', b.systems.map(s => D.systems[s].name).join(', ') || 'none', 'doc09']],
        note: 'Geodesic area of MWRD’s own Combined Sewer Area polygons. The five basins total 311 sq mi against the ~360 sq mi MWRD quotes publicly.', doc: 'doc14' });
    }
  }
  const im = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 6), M.outfall, D.outfalls.length);
  D.outfalls.forEach((o, i) => { _d.position.set(o[0], 120, o[1]); _d.scale.set(180, 260, 180); _d.rotation.set(Math.PI, 0, 0); _d.updateMatrix(); im.setMatrixAt(i, _d.matrix); });
  im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; layerG.outfalls.add(im);
  reg(im, { kind: 'outfalls', title: 'CSO outfalls', sub: 'MWRD CSO_Points layer',
    rows: [['Outfalls in layer', `${D.outfalls.length}`, 'gis'], ['City-owned outfalls under NPDES IL0045012', '184', 'doc06']],
    note: 'Every point where the combined system can discharge to a waterway when the tunnels and reservoirs are full.', doc: 'doc14' });
}

/* ------------------------------------------------------------- tunnels */
function buildTunnels() {
  layerG.tunnels.clear(); layerG.water.clear(); conduits.length = 0;
  for (const k of Object.keys(sysConduits)) delete sysConduits[k];
  for (const f of D.tunnels) {
    const c = new SC.Conduit(pts2(f), f.depth.map(d => d * FT), f.dia.map(d => d * FT / 2), { ring: 12 });
    const mesh = new THREE.Mesh(c.geom, tunnelMat[f.system]); mesh.renderOrder = 2; layerG.tunnels.add(mesh);
    const w = new SC.ConduitWater(c);
    const wm = new THREE.Mesh(w.geom, M.waterBody); wm.renderOrder = 3; layerG.water.add(wm);
    const sm = new THREE.Mesh(w.surf, M.waterSurf); sm.renderOrder = 4; layerG.water.add(sm);
    const sys = D.systems[f.system];
    reg(mesh, { kind: 'tunnel', title: f.name, sub: sys.name,
      rows: [['Diameter along this reach', `${f.dia[0].toFixed(1)}–${f.dia[f.dia.length - 1].toFixed(1)} ft`, 'derived'],
        ['Depth below ground', `${f.depth[0]}–${f.depth[f.depth.length - 1]} ft`, 'doc09'],
        ['Drawn length', `${f.lenMi} mi (as-traced corridor ${f.corridorMi} mi)`, 'derived'],
        ['System length', `${sys.lengthMi.v} mi`, sys.lengthMi.s], ['System storage', `${sys.storageMG.v.toLocaleString()} MG`, sys.storageMG.s],
        ['System diameter range', `${sys.diaFt.v[0]}–${sys.diaFt.v[1]} ft`, sys.diaFt.s],
        ['Water here now', () => {
          const cd = conduits.find(x => x.feat.id === f.id), s = V.systems[f.system];
          if (!cd || !s || cd.level == null) return '—';
          const A = c.wetted(Math.floor(c.n / 2), cd.level), v = SC.conduitVelocity(Math.max(s.inflow, s.pumped), A);
          return A > 0.01 ? `${(v * 3.281).toFixed(2)} ft/s through ${num(A * 10.764)} sq ft of wetted bore` : 'dry';
        }, 'derived']], note: f.note, doc: 'doc09' });
    conduits.push({ sid: f.system, c, w, mesh, wm, sm, feat: f, level: null });
    (sysConduits[f.system] = sysConduits[f.system] || []).push(c);
  }
  for (const sid of Object.keys(sysConduits)) sysGeomVol[sid] = sysConduits[sid].reduce((a, c) => a + c.volumeAt(-1e9), 0);
}
/** The downstream end of a system's main line, at depth. */
function tunnelEnd(sid) {
  const feats = D.tunnels.filter(t => t.system === sid && !t.spur).sort((a, b) => b.f1 - a.f1 || b.order - a.order);
  const f = feats[0]; if (!f) return null;
  const p = pts2(f), i = p.length - 1;
  return { x: p[i][0], z: p[i][1], depthM: f.depth[i] * FT, diaM: f.dia[i] * FT };
}

/* -------------------------------------------------------------- shafts */
function buildShafts() {
  const groups = {};
  for (const s of D.shafts) (groups[s.system || 'connection'] = groups[s.system || 'connection'] || []).push(s);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), cylUV = new THREE.CylinderGeometry(1, 1, 1, 10, 6, true);
  for (const [key, items] of Object.entries(groups)) {
    const isConn = key === 'connection';
    const mesh = new THREE.InstancedMesh(cyl, isConn ? M.conn : M.shaft, items.length); mesh.frustumCulled = false;
    (isConn ? layerG.connections : layerG.shafts).add(mesh);
    let wmesh = null;
    if (!isConn) { wmesh = new THREE.InstancedMesh(cylUV, shaftWaterMat[key], items.length); wmesh.frustumCulled = false; layerG.shafts.add(wmesh); }
    shaftSets.push({ sid: isConn ? null : key, mesh, wmesh, items, drive: -1 });
    reg(mesh, { kind: 'shaftset', key, items });
  }
  positionShafts();
}
function positionShafts() {
  const repR = (10 * FT) / 2;
  for (const set of shaftSets) {
    set.items.forEach((s, i) => {
      const depthFt = ST.route === 'corridor' ? (s.cdepth != null ? s.cdepth : s.depth) : s.depth;
      const d = (set.sid ? depthFt : 25) * FT * ST.vExag, r = (set.sid ? repR : 3 * FT) * ST.dExag;
      _d.position.set(s.x, -d / 2, s.z); _d.scale.set(r, Math.max(d, 1), r); _d.rotation.set(0, 0, 0); _d.updateMatrix();
      set.mesh.setMatrixAt(i, _d.matrix); s._y = d;
    });
    set.mesh.instanceMatrix.needsUpdate = true; set.drive = -1;
  }
}

/* ---------------------------------------------------------- reservoirs */
function buildReservoirs() {
  for (const f of D.facilities) {
    if (f.kind !== 'reservoir') continue;
    const g = f.geom, grp = new THREE.Group(); grp.position.set(f.x, 0, f.z);
    const bench = f.shape === 'quarry' ? 6 : (f.shape === 'pit' ? 4 : 0);
    const pit = new THREE.Mesh(SC.frustumGeometry(g.L, g.W, g.D * ST.vExag, g.insetM, bench), M.rock); grp.add(pit);
    const rim = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: f.retired ? 0x7a8694 : 0x6fc3e8 })); grp.add(rim);
    const fw = new SC.FrustumWater();
    const water = new THREE.Mesh(fw.geom, M.resWater); water.renderOrder = 1; water.visible = false; grp.add(water);
    const waterline = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8ad8ff })); waterline.renderOrder = 2; grp.add(waterline);
    layerG.reservoirs.add(grp);
    const sys = f.system ? D.systems[f.system] : null;
    reg(pit, { kind: 'reservoir', title: f.name, sub: f.retired ? 'decommissioned' : (sys ? sys.name : ''),
      rows: [['Capacity (TARP share)', `${f.spec.capMG.v.toLocaleString()} MG`, f.spec.capMG.s],
        ['Capacity (total)', `${f.spec.capFullMG.v.toLocaleString()} MG`, f.spec.capFullMG.s],
        ['Depth', `${g.depthFt} ft (${num(g.D)} m)`, f.spec.depthFt.s],
        ['Surface', `${g.topAcres} acres`, f.spec.surfaceAcres ? f.spec.surfaceAcres.s : 'derived'],
        ['Drawn as', `${num(g.L)} × ${num(g.W)} × ${num(g.D)} m frustum`, 'derived'],
        ['Volume check', `drawn solid holds ${g.geomMG.toLocaleString()} MG vs published ${g.sourcedMG.toLocaleString()} MG (${g.deltaPct >= 0 ? '+' : ''}${g.deltaPct}%)`, 'derived'],
        ['Dimension solved for', g.solvedFor, 'derived'],
        ['Drawn for the selected era', () => { const r = resObjects[f.id]; return r ? `${num(r.builtMG)} MG excavated — plan dimensions scaled by ×${r.k.toFixed(2)}` : '—'; }, 'derived'],
        ['Holding now', () => { const s = V.reservoirs[f.id]; return s && s.cap > 0 ? `${num(s.vol)} of ${num(s.cap)} MG (${(100 * s.vol / s.cap).toFixed(0)}%)` : 'not built in this era'; }, 'derived'],
        ['Flow now', () => { const r = resObjects[f.id]; return !r || Math.abs(r.net) < 1 ? 'still' : (r.net > 0 ? `filling from the tunnel at ${num(r.net)} MGD` : `draining to the pumps at ${num(-r.net)} MGD`); }, 'derived']],
      note: f.note, doc: f.doc, facId: f.id });
    resObjects[f.id] = { f, grp, pit, rim, fw, water, waterline, bench, k: 1, builtMG: f.spec.capFullMG.v, shown: -1, net: 0 };
    addLabel(f.short, f.x, f.z, 30, 'res', 60000);
  }
}
function applyBuildOut() {
  if (!ST.run) return;
  const f0 = ST.run.frames[0];
  for (const [rid, r] of Object.entries(resObjects)) {
    const cap = f0.reservoirs[rid] ? f0.reservoirs[rid].capMG : 0, full = r.f.spec.capFullMG.v;
    const built = rid === 'res-thornton' ? full : (cap > 0 ? cap : r.f.spec.capMG.v);
    const k = Math.sqrt(Math.max(0.08, built / full));
    r.k = k; r.builtMG = built;
    const L = r.f.geom.L * k, W = r.f.geom.W * k, Dp = r.f.geom.D * ST.vExag, inset = r.f.geom.insetM * k;
    r.pit.geometry.dispose(); r.pit.geometry = SC.frustumGeometry(L, W, Dp, inset, r.bench);
    r.rim.geometry.dispose();
    r.rim.geometry = new THREE.BufferGeometry().setFromPoints([V3(-L / 2, 0, -W / 2), V3(L / 2, 0, -W / 2), V3(L / 2, 0, W / 2), V3(-L / 2, 0, W / 2), V3(-L / 2, 0, -W / 2)]);
    r.fw.setShape(L, W, Dp, inset);
    r.holdsMG = r.f.geom.geomMG * k * k;
    r.grp.visible = cap > 0 || (r.f.retired && ST.storm.config === 'r2015');
    r.built = cap > 0; r.shown = -1;
  }
  for (const l of links) if (l.res) l.mesh.visible = !!(resObjects[l.res] && resObjects[l.res].built);
}

/* -------------------------------------------------------------- plants */
function buildPlants() {
  layerG.plants.clear();
  for (const k of Object.keys(plantObjects)) delete plantObjects[k];
  for (const f of D.facilities) {
    if (f.kind !== 'wrp') continue;
    const g = f.geom, grp = new THREE.Group(); grp.position.set(f.x, 0, f.z);
    const padH = 2 * ST.vExag;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(g.siteL, padH, g.siteW), M.pad); pad.position.y = padH / 2; grp.add(pad);
    const rows = [['Design average flow', `${f.spec.daf.v.toLocaleString()} MGD`, f.spec.daf.s],
      ['Design maximum flow', `${f.spec.dmf.v.toLocaleString()} MGD`, f.spec.dmf.s],
      ['Reported average flow', `${f.spec.avg.v.toLocaleString()} MGD`, f.spec.avg.s],
      ['Site', `${f.spec.acres.v} acres (drawn ${num(g.siteL)} × ${num(g.siteW)} m)`, f.spec.acres.s],
      ['Treating now', () => { const s = V.plants[f.id]; return s ? `${num(s.flow)} MGD, ${(100 * s.flow / s.dmf).toFixed(0)}% of design maximum` : '—'; }, 'derived']];
    if (!f.basin) rows.push(['In the storm model', 'held at its reported average flow — this plant serves separate-sewer suburbs that are not inside MWRD’s combined-sewer areas, so no storm flow is routed to it', 'derived']);
    const lay = SC.layoutPlant(g), byRow = {};
    for (const t of lay.tanks) (byRow[t.row] = byRow[t.row] || []).push(t);
    const nStage = Math.max(1, lay.train.length), stages = {};
    for (const [rid, list] of Object.entries(byRow)) {
      const spec = g.rows.find(r => r.id === rid), proto = list[0], idx = lay.train.findIndex(t => t.id === rid);
      const frac = spec.train === 'solids' ? 1 : (idx < 0 ? 0.5 : idx / Math.max(1, nStage - 1)), isCyl = proto.type === 'cyl';
      const walls = new THREE.InstancedMesh(isCyl ? new THREE.CylinderGeometry(1, 1, 1, 24, 1, true) : new THREE.BoxGeometry(1, 1, 1), spec.train === 'solids' ? M.solidsWall : M.tankWall, list.length);
      const wcol = SC.trainColor(frac);
      const wmat = flow({ color: wcol, roughness: 0.22, metalness: 0.15, emissive: new THREE.Color(wcol).multiplyScalar(0.18) },
        { useUV: true, len: isCyl ? proto.r * 6.3 : proto.L, speed: 0, wave: 30, strength: 0.55, hi: 0xd8f4ff });
      const water = new THREE.InstancedMesh(isCyl ? new THREE.CylinderGeometry(1, 1, 1, 24) : new THREE.BoxGeometry(1, 1, 1), wmat, list.length);
      list.forEach((t, i) => {
        const h = Math.max(t.h * ST.vExag, 0.4), wh = h * 0.86;
        _d.rotation.set(0, 0, 0); _d.position.set(t.x, h / 2 + padH, t.z); isCyl ? _d.scale.set(t.r, h, t.r) : _d.scale.set(t.L, h, t.W); _d.updateMatrix(); walls.setMatrixAt(i, _d.matrix);
        _d.position.set(t.x, wh / 2 + padH, t.z); isCyl ? _d.scale.set(t.r * 0.94, wh, t.r * 0.94) : _d.scale.set(t.L * 0.94, wh, t.W * 0.94); _d.updateMatrix(); water.setMatrixAt(i, _d.matrix);
      });
      walls.instanceMatrix.needsUpdate = true; walls.frustumCulled = false; water.instanceMatrix.needsUpdate = true; water.frustumCulled = false;
      grp.add(walls, water);
      const dims = spec.shape === 'cyl' ? `${spec.n} ${spec.n === 1 ? 'tank' : 'tanks'}, ${num(spec.dia)} m dia × ${num(spec.D)} m deep`
        : spec.shape === 'box' ? `${spec.n} ${spec.n === 1 ? 'tank' : 'tanks'}, ${num(spec.L)} × ${num(spec.W)} × ${num(spec.D)} m` : `${spec.acres} acres of surface, ${num(spec.D)} m deep`;
      rows.push([spec.label, dims, (spec.src && (spec.src.n === 'doc11' || spec.src.dia === 'doc11')) ? 'doc11' : (spec.src && spec.src.n) || 'assumed']);
      reg(walls, { kind: 'tankrow', title: `${f.short} — ${spec.label}`, sub: `${f.name} · ${spec.train === 'solids' ? 'solids handling' : 'stage ' + spec.stage + ' of the water train'}`,
        rows: [['Count', `${spec.n}`, (spec.src && spec.src.n) || 'assumed'], ['Dimensions', dims, (spec.src && (spec.src.dia || spec.src.L || spec.src.acres)) || 'assumed'],
          ['Depth', `${num(spec.D)} m`, (spec.src && spec.src.D) || 'assumed'],
          ['Holds the water for', () => { const st = stages[rid]; return st && st.hrt ? `${fmtDur(st.hrt)} at the current flow` : '—'; }, 'derived'],
          ['Arrangement on the site', 'schematic — the counts and sizes are the sourced part', 'assumed']], note: spec.note, doc: f.doc, facId: f.id });
      const anchor = spec.train === 'solids' ? lay.solids.find(x => x.id === rid) : lay.train[idx];
      let label = null;
      if (anchor) {
        const tier = spec.train === 'solids' ? 3 : (spec.stage % 3), yy = proto.h * ST.vExag + 16 + tier * 26;
        label = el('div', 'lbl stage' + (spec.train === 'solids' ? ' solids' : ''));
        const o = new CSS2DObject(label); o.position.set(f.x + anchor.x, yy, f.z + anchor.z); layerG.labels.add(o);
        labelObjs.push({ o, y: yy, d: 2600, div: label, abs: true });
      }
      stages[rid] = { spec, dims, water, wmat, label, hrt: 0 };
    }
    // the process flow as a ribbon of moving water, and the solids branch
    const y = padH + 3;
    const linePts = [V3(lay.inlet.x, y, lay.inlet.z), ...lay.train.map(t => V3(t.x, y, t.z)), V3(lay.outlet.x, y, lay.outlet.z)];
    const trainGeo = flowRibbon(linePts, Math.max(6, g.siteW * 0.012));
    const train = new THREE.Mesh(trainGeo, M.train); train.renderOrder = 4; grp.add(train);
    if (lay.solids.length && lay.solidsTap)
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([V3(lay.solidsTap.x, y, lay.solidsTap.z), ...lay.solids.map(t => V3(t.x, y, t.z))]),
        new THREE.LineBasicMaterial({ color: 0xb09050, transparent: true, opacity: 0.5 })));
    // CSO discharge points: at the relief pumping stations upstream, never at the plant
    const csoPaths = [];
    for (const c of (f.cso || [])) {
      if (c.x == null) continue;
      const pth = [V3(lay.inlet.x, y, lay.inlet.z), V3(c.x - f.x, y, c.z - f.z)];
      if (c.ox != null) pth.push(V3(c.ox - f.x, y, c.oz - f.z));
      const dia = 2 * Math.sqrt((c.areaM2 || 14) / Math.PI);
      const cc = new SC.Conduit(pth.map(p => [p.x, p.z]), pth.map(p => -p.y / ST.vExag), pth.map(() => dia / 2), { ring: 10 });
      cc.update(ST.vExag, ST.dExag * 0.6);
      const ribbon = new THREE.Mesh(cc.geom, M.pipeCso); ribbon.renderOrder = 4; ribbon.visible = false; grp.add(ribbon);
      const geo = cc;
      const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pth), new THREE.LineDashedMaterial({ color: 0xd64545, dashSize: 260, gapSize: 170, transparent: true, opacity: 0.25 }));
      guide.computeLineDistances(); grp.add(guide);
      const marker = new THREE.Mesh(new THREE.ConeGeometry(120, 260, 7), std({ color: 0xd64545, emissive: 0x4a1010 }));
      const last = pth[pth.length - 1]; marker.position.set(last.x, 130, last.z); marker.rotation.x = Math.PI; grp.add(marker);
      const cp = { spec: c, ribbon, geo, guide, marker, share: 0, passed: 0, backup: 0, v: 0, on: false };
      csoPaths.push(cp);
      reg(marker, { kind: 'cso', title: `${f.short} — ${c.outfall}`, sub: 'combined sewer overflow discharge point',
        rows: [['Discharges to', c.water, c.s], ['Structure', c.oloc || (facById(c.at) || {}).name || '—', 'gis'],
          ['Opens when', 'the interceptors, the tunnel and the reservoir are all at their limit', 'derived'],
          c.ratedMGD ? ['Station rated capacity', `${num(c.ratedMGD)} MGD`, 'doc07'] : null,
          ['Discharging now', () => {
            if (!cp.share) return 'no — the system is holding it';
            const base = `${num(cp.passed)} MGD at ${(cp.v * 3.281).toFixed(1)} ft/s`;
            return cp.backup > 1 ? `${base}. A further ${num(cp.backup)} MGD is arriving that this station is not rated to pass — in a real storm that surplus surcharges back up the collection system, which is how basements flood.` : base;
          }, 'derived']].filter(Boolean),
        note: c.note || 'Excess never reaches the plant. It is held back in the collection system, goes down the drop shafts into the Deep Tunnel, and only once the tunnel and its reservoir are full does it leave here, untreated.', doc: f.doc, facId: f.id });
    }
    const gauge = addGauge('plant', f.x, 60, f.z, f.spec.dmf.v >= 400 ? 30000 : 14000);
    for (const x of (f.extras || [])) rows.push([x.label, x.v, x.s]);
    layerG.plants.add(grp);
    reg(pad, { kind: 'plant', title: f.name, sub: `Water reclamation plant · ${lay.train.length}-stage train` + (g.trainSourced ? ' (sequence sourced, tank sizes assumed)' : ''), rows, note: f.note, doc: f.doc, facId: f.id });
    plantObjects[f.id] = { f, grp, pad, lay, stages, train, trainGeo, csoPaths, gauge, budget: null, rate: 0,
      inlet: V3(f.x + lay.inlet.x, y, f.z + lay.inlet.z), outlet: V3(f.x + lay.outlet.x, y, f.z + lay.outlet.z) };
    addLabel(f.short, f.x, f.z, 30, 'plant', f.spec.dmf.v >= 400 ? 46000 : 17000);
  }
}

/* --------------------------------------------------------------- pumps */
function buildPumps() {
  layerG.pumps.clear();
  for (const k of Object.keys(pumpObjects)) delete pumpObjects[k];
  for (const f of D.facilities) {
    if (f.kind !== 'tarp-ps' && f.kind !== 'sewage-ps') continue;
    const g = f.geom, grp = new THREE.Group(); grp.position.set(f.x, 0, f.z);
    const hall = new THREE.Mesh(new THREE.BoxGeometry(g.hallL, g.hallH * ST.vExag, g.hallW), M.bldg); hall.position.y = g.hallH * ST.vExag / 2; grp.add(hall);
    const rows = [];
    for (const [k, lbl] of [['pumps', 'Pumps'], ['capMGD', 'Capacity'], ['capCFS', 'Capacity'], ['hp', 'Largest motor'], ['liftFt', 'Lift'], ['shaftDepthFt', 'Shaft depth'],
      ['riserFt', 'Riser / force main'], ['areaSqMi', 'Interceptor area'], ['stormPumpFt', 'Storm pump discharge'], ['dryPumpFt', 'Dry-weather pump discharge'], ['screwFt', 'Screw propeller'], ['bldgSqFt', 'Building']]) {
      const v = f.spec[k]; if (v) rows.push([lbl, `${num(v.v)} ${v.u}`, v.s, v.n]);
    }
    const n = Math.min(g.n || 4, 16);
    const pumps = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 16), std({ color: 0xe0b050, roughness: 0.4, metalness: 0.5 }), n);
    const pr = Math.max(g.pumpDia / 2, 1.2) * ST.dExag * 0.5;
    for (let i = 0; i < n; i++) {
      const h = g.hallH * 0.7 * ST.vExag;
      _d.rotation.set(0, 0, 0); _d.position.set(-g.hallL / 2 + g.hallL * (i + 0.5) / n, h / 2, 0); _d.scale.set(pr, h, pr); _d.updateMatrix(); pumps.setMatrixAt(i, _d.matrix);
    }
    pumps.instanceMatrix.needsUpdate = true; pumps.frustumCulled = false; grp.add(pumps);
    const po = { f, grp, pumped: 0, riserV: 0 };
    if (g.shaftM > 1) {
      const d = g.shaftM * ST.vExag, sr = Math.max(g.riserM, 2) * ST.dExag * 1.4;
      const sh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 14, 1, true), M.shaft); sh.position.y = -d / 2; sh.scale.set(sr, d, sr); grp.add(sh);
      const rmat = flowClone(M.riser, { uLen: d }); rmat.userData.isRiser = true;
      const riser = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12, 8), rmat);
      riser.position.set(sr * 0.9, -d / 2, 0); riser.scale.set(g.riserM / 2 * ST.dExag, d, g.riserM / 2 * ST.dExag); grp.add(riser);
      Object.assign(po, { riser, rmat, riserR: g.riserM / 2, depth: d });
    }
    if (f.kind === 'tarp-ps' && f.system) po.gauge = addGauge('tun', f.x, 92, f.z, 34000);
    layerG.pumps.add(grp);
    reg(hall, { kind: 'pump', title: f.name, sub: f.kind === 'tarp-ps' ? 'TARP dewatering pumping station' : 'MWRD sewage pumping station',
      rows: [...rows, ['Lifting now', () => po.pumped > 1 ? `${num(po.pumped)} MGD at ${(po.riserV * 3.281).toFixed(1)} ft/s up the force main` : 'idle', 'derived']],
      note: f.note, doc: f.doc, facId: f.id, conflict: f.conflict });
    pumpObjects[f.id] = po;
    addLabel(f.short, f.x, f.z, 22, 'pump', f.kind === 'tarp-ps' ? 46000 : 15000);
  }
}

/* --------------------------------------------------------------- links */
/* The conduits that join facilities together. Endpoints are real; routes
 * between them are straight because none is published:
 *   tunnel -> reservoir       the inflow tunnel (McCook's ~20 ft Des Plaines
 *                             Inflow Tunnel; Thornton's ~1,300 ft, ~30 ft
 *                             connecting tunnel; Majewski by gravity)
 *   reservoir -> pump station dewatering, back through the same connection
 *   pump station -> plant     the return main after the ~300 ft lift
 *   relief station -> plant   the intercepting-sewer trunk (dry-weather flow)
 *   plant -> receiving water  the treated effluent outfall
 */
function nearestWaterPoint(name, from) {
  let best = null, bd = 1e18;
  const consider = (pts) => { for (const p of pts) { const dd = (p[0] - from.x) ** 2 + (p[1] - from.z) ** 2; if (dd < bd) { bd = dd; best = p; } } };
  for (const w of (D.geo ? D.geo.waterways : [])) if (w.name === name) consider(w.pts);
  if (!best) for (const w of D.waterways) if (w.id.includes(name.toLowerCase().split(' ')[0]) || (name === 'wb-dupage' && w.id.includes('dupage'))) consider(w.pts);
  return best ? V3(best[0], 6, best[1]) : null;
}
const EFFLUENT = { 'wrp-stickney': 'Chicago Sanitary and Ship Canal', 'wrp-calumet': 'Little Calumet River', 'wrp-obrien': 'North Shore Channel',
  'wrp-kirie': 'Higgins Creek', 'wrp-egan': 'Salt Creek', 'wrp-hanoverpark': 'wb-dupage', 'wrp-lemont': 'Chicago Sanitary and Ship Canal' };
const INTERCEPTOR = { 'ps-racine': 'wrp-stickney', 'ps-westchester': 'wrp-stickney', 'ps-north-branch': 'wrp-obrien',
  'ps-95th': 'wrp-calumet', 'ps-122nd': 'wrp-calumet', 'ps-125th': 'wrp-calumet' };
function addLink(o) {
  // a real tube: 2-D route plus a depth per point, so the Conduit class can
  // carry it at true diameter under the same exaggeration as the tunnels
  const c = new SC.Conduit(o.pts.map(p => [p.x, p.z]), o.pts.map(p => -p.y / ST.vExag), o.pts.map(() => o.diaM / 2), { ring: 10 });
  c.update(ST.vExag, ST.dExag * (o.dScale || 1));
  const mesh = new THREE.Mesh(c.geom, o.mat); mesh.renderOrder = 3; layerG.links.add(mesh);
  const l = Object.assign({ c, mesh, q: 0, v: 0, areaM2: Math.PI * (o.diaM / 2) ** 2 }, o);
  reg(mesh, { kind: 'link', title: o.title, sub: o.sub,
    rows: [['Drawn as', `${num(o.diaM / FT)} ft diameter conduit, ${num(c.length / 1609.344)} mi`, o.diaSrc || 'assumed'],
      ['Route', 'straight between the real endpoints — the alignment is not published', 'assumed'],
      ['Carrying now', () => Math.abs(l.q) > 1 ? `${num(Math.abs(l.q))} MGD at ${(l.v * 3.281).toFixed(2)} ft/s ${l.q < 0 ? '(reversed)' : ''}` : 'nothing', 'derived']],
    note: o.note, doc: o.doc });
  links.push(l);
  return l;
}
function buildLinks() {
  layerG.links.clear(); links.length = 0;
  const yGrade = 8, yInter = -40 * FT * ST.vExag;
  const seen = new Set();
  for (const [sid, sys] of Object.entries(D.systems)) {
    const end = tunnelEnd(sid), res = facById(sys.reservoir), ps = facById(sys.pump), plant = facById(sys.plant);
    if (!end) continue;
    const yTun = -end.depthM * ST.vExag;
    if (res) {
      // inflow tunnel: tunnel end -> reservoir floor edge
      const rdepth = -(res.geom.D * 0.5) * ST.vExag;
      const dia = sid === 'calumet' ? 30 * FT : sid === 'udp' ? 12 * FT : 20 * FT;
      addLink({ kind: 'inflow', sid, res: res.id, mat: M.pipeTunnel, diaM: dia,
        diaSrc: sid === 'udp' ? 'assumed' : 'doc10',
        pts: [V3(end.x, yTun, end.z), V3(res.x, rdepth, res.z)],
        title: `${sys.name.replace(/ Tunnel System.*/, '')} → ${res.short}`, sub: 'reservoir inflow tunnel',
        note: sid === 'mainstream' || sid === 'desplaines' ? 'The Des Plaines Inflow Tunnel: ~20 ft diameter with a gate shaft, primary and backup gates, and a "tiger-teeth" energy-dissipation apron at the reservoir. Substantially complete October 2021 ($109.9M).'
            : sid === 'calumet' ? 'A ~30-ft-diameter, ~1,300 ft connecting tunnel with four gates of about 100 tons each, roughly 1,000 ft into the tunnel; apron rated for 30 ft/s.'
            : 'The Upper Des Plaines system is pure gravity: flow reaches Majewski without pumping.', doc: 'doc10' });
      if (ps && !seen.has('drain:' + res.id + ps.id)) {
        seen.add('drain:' + res.id + ps.id);
        // dewatering: reservoir -> pumping station shaft (the water goes back the way it came, then to the pumps)
        const psDepth = -(ps.geom.shaftM || end.depthM) * ST.vExag;
        addLink({ kind: 'drain', sid, res: res.id, sids: Object.keys(D.systems).filter(x => D.systems[x].reservoir === res.id), mat: M.pipeReturn, diaM: dia * 0.8, diaSrc: 'assumed',
          pts: [V3(res.x, rdepth, res.z), V3(ps.x - 60, psDepth, ps.z - 60)],
          title: `${res.short} → ${ps.short}`, sub: 'reservoir dewatering',
          note: 'Stored flow is drawn back out of the reservoir to the pumping station once the tunnel has room, and lifted to the plant. This is the return leg the reservoir exists for.', doc: 'doc10' });
      }
    }
    if (ps && plant && plantObjects[plant.id] && !seen.has('return:' + ps.id + plant.id)) {
      seen.add('return:' + ps.id + plant.id);
      // return main: pump station (top of the lift) -> plant inlet
      const inlet = plantObjects[plant.id].inlet;
      const dia = (ps.spec.riserFt ? ps.spec.riserFt.v : 8) * FT;
      addLink({ kind: 'return', sid, sids: Object.keys(D.systems).filter(x => D.systems[x].pump === ps.id), mat: M.pipeReturn, diaM: dia, diaSrc: ps.spec.riserFt ? ps.spec.riserFt.s : 'assumed',
        pts: [V3(ps.x, yGrade + 2, ps.z), V3(inlet.x, inlet.y, inlet.z)],
        title: `${ps.short} → ${plant.short}`, sub: 'pumped return to treatment',
        note: `After the lift of ${ps.spec.liftFt ? num(ps.spec.liftFt.v) + ' ft' : 'the shaft'}, captured flow is returned to the plant on top of its dry-weather load, which is why the return rate is set by the plant’s spare capacity rather than the pumps.`, doc: 'doc09' });
    }
  }
  // interceptor trunks: relief pumping station -> plant inlet (dry-weather flow)
  for (const [psId, plantId] of Object.entries(INTERCEPTOR)) {
    const ps = facById(psId), po = plantObjects[plantId]; if (!ps || !po) continue;
    addLink({ kind: 'interceptor', plant: plantId, mat: M.pipeSewage, diaM: 12 * FT, diaSrc: 'assumed',
      pts: [V3(ps.x, yInter, ps.z), V3(po.inlet.x, yInter, po.inlet.z), V3(po.inlet.x, po.inlet.y, po.inlet.z)],
      title: `${ps.short} → ${po.f.short}`, sub: 'intercepting sewer (dry-weather flow)',
      note: 'MWRD’s ~560 miles of intercepting sewers, 6 in to 27 ft in diameter, carry dry-weather sewage to the plants. Their alignments are not published; this trunk runs straight from the relief station that sits on it to the plant, at a typical interceptor depth.', doc: 'doc07' });
  }
  // effluent: plant outlet -> receiving water
  for (const [plantId, water] of Object.entries(EFFLUENT)) {
    const po = plantObjects[plantId]; if (!po) continue;
    const w = nearestWaterPoint(water, po.outlet); if (!w) continue;
    addLink({ kind: 'effluent', plant: plantId, mat: M.pipeEffluent, diaM: 10 * FT, diaSrc: 'assumed',
      pts: [po.outlet.clone(), V3(w.x, yGrade, w.z)],
      title: `${po.f.short} → ${water.replace('wb-dupage', 'West Branch DuPage River')}`, sub: 'treated effluent outfall',
      note: 'Clarified, disinfected water leaving the plant for its receiving stream. Stickney’s goes to the Sanitary and Ship Canal and on to the Illinois and Mississippi.', doc: po.f.doc });
  }
  applyBuildOut();
}

/* ------------------------------------------------------- scale change */
function setScale(v, d) {
  ST.vExag = v; ST.dExag = d;
  $('#vexag').value = v; $('#dexag').value = d; $('#vexagv').textContent = '×' + v; $('#dexagv').textContent = '×' + d;
  applyScale();
}
function applyScale() {
  for (const { c } of conduits) c.update(ST.vExag, ST.dExag);
  positionShafts();
  labelObjs.length = 0; layerG.labels.clear();
  for (const r of Object.values(resObjects)) addLabel(r.f.short, r.f.x, r.f.z, 30, 'res', 60000);
  buildPlants(); buildPumps(); buildGeoLabels(); buildLinks();
  clearHi();
  for (const l of labelObjs) if (!l.abs) l.o.position.y = l.y * Math.max(1, ST.vExag / 8);
  for (const r of Object.values(resObjects)) r.shown = -1;
  const b = $('#exagbadge');
  b.innerHTML = ST.vExag === 1 && ST.dExag === 1 ? '<b>1:1 true scale</b> — nothing exaggerated' : `vertical <b>×${ST.vExag}</b> · conduit width <b>×${ST.dExag}</b>`;
  b.classList.toggle('true', ST.vExag === 1 && ST.dExag === 1);
  syncView(true);
}
function buildGeoLabels() {
  const G = D.geo; if (!G) return;
  layerG.contours.children.filter(c => c.userData.lbl).forEach(c => layerG.contours.remove(c));
  if (G.shoreline && G.shoreline.length) { const mid = G.shoreline[Math.floor(G.shoreline.length / 2)]; addLabel('Lake Michigan', mid[0] + 9000, mid[1], 6, 'geo', 1e9); }
  for (const lk of (G.lakes || [])) addLabel(lk.name, lk.pts.reduce((a, p) => a + p[0], 0) / lk.pts.length, lk.pts.reduce((a, p) => a + p[1], 0) / lk.pts.length, 6, 'geo', 40000);
}

/* =================================== 5. the live view of the simulation */
const model = new SewerModel(D);
function runSim() {
  ST.run = model.run(ST.storm);
  ST.pos = 0;
  $('#scrub').max = ST.run.frames.length - 1; $('#scrub').value = 0;
  applyBuildOut(); drawChart(); renderSummary(); syncView(true);
}
function sampleFrame(pos) {
  const F = ST.run.frames, i = Math.max(0, Math.min(F.length - 1, Math.floor(pos))), j = Math.min(F.length - 1, i + 1), k = clamp01(pos - i);
  const a = F[i], b = F[j], mix = (x, y) => lerp(x, y, k);
  const out = { t: mix(a.t, b.t), inHr: mix(a.inHr, b.inHr), csoRate: mix(a.csoRate, b.csoRate), csoCum: mix(a.csoCum, b.csoCum),
    pumpedRate: mix(a.pumpedRate, b.pumpedRate), systems: {}, reservoirs: {}, plants: {}, basins: {} };
  for (const sid of Object.keys(a.systems)) out.systems[sid] = { vol: mix(a.systems[sid].volMG, b.systems[sid].volMG), cap: a.systems[sid].capMG,
    inflow: mix(a.systems[sid].inflow, b.systems[sid].inflow), pumped: mix(a.systems[sid].pumped, b.systems[sid].pumped) };
  for (const rid of Object.keys(a.reservoirs)) out.reservoirs[rid] = { vol: mix(a.reservoirs[rid].volMG, b.reservoirs[rid].volMG), cap: a.reservoirs[rid].capMG,
    net: (b.reservoirs[rid].volMG - a.reservoirs[rid].volMG) / ST.run.dtHr * 24 };      // MGD, + filling
  for (const pid of Object.keys(a.plants)) out.plants[pid] = { flow: mix(a.plants[pid].flow, b.plants[pid].flow), dmf: a.plants[pid].dmf };
  for (const bid of Object.keys(a.basins)) out.basins[bid] = { cso: mix(a.basins[bid].cso || 0, b.basins[bid].cso || 0), intercepted: mix(a.basins[bid].intercepted || 0, b.basins[bid].intercepted || 0) };
  return out;
}
function easeView(target, dt, snap) {
  const k = snap ? 1 : 1 - Math.pow(0.02, dt);
  const ez = (obj, key, val) => { obj[key] = obj[key] == null || snap ? val : lerp(obj[key], val, k); };
  ez(V, 't', target.t); ez(V, 'inHr', target.inHr); ez(V, 'csoRate', target.csoRate); ez(V, 'csoCum', target.csoCum); ez(V, 'pumpedRate', target.pumpedRate);
  for (const [sid, s] of Object.entries(target.systems)) { const o = V.systems[sid] = V.systems[sid] || {}; ez(o, 'vol', s.vol); ez(o, 'inflow', s.inflow); ez(o, 'pumped', s.pumped); o.cap = s.cap; }
  for (const [rid, r] of Object.entries(target.reservoirs)) { const o = V.reservoirs[rid] = V.reservoirs[rid] || {}; ez(o, 'vol', r.vol); ez(o, 'net', r.net); o.cap = r.cap; }
  for (const [pid, p] of Object.entries(target.plants)) { const o = V.plants[pid] = V.plants[pid] || {}; ez(o, 'flow', p.flow); o.dmf = p.dmf; }
  for (const [bid, b] of Object.entries(target.basins)) { const o = V.basins[bid] = V.basins[bid] || {}; ez(o, 'cso', b.cso); ez(o, 'intercepted', b.intercepted); }
  V.ready = true;
}
/** Push the live view into the geometry. Runs every render tick. */
function syncView(snap, dt = 1 / 60) {
  if (!ST.run) return;
  easeView(sampleFrame(ST.pos), dt, snap);
  const disp = q => q > 0.5 ? SC.displaySpeed(q, FLOW_BASE) : 0;

  for (const [sid, cs] of Object.entries(sysConduits)) {
    const s = V.systems[sid], frac = s && s.cap > 0 ? clamp01(s.vol / s.cap) : 0;
    const level = SC.solveLevel(cs, frac * sysGeomVol[sid]), q = s ? Math.max(s.inflow, s.pumped) : 0;
    for (const cd of conduits) {
      if (cd.sid !== sid) continue;
      cd.level = level;
      cd.w.update(level, ST.vExag, ST.dExag);
      cd.wm.visible = frac > 0.0008;
      cd.sm.visible = cd.wm.visible && cd.w.surfaceOpen;
      cd.sm.material = frac > 0.985 ? M.waterSurfFull : M.waterSurf;
      cd.w.setVelocity(i => q > 0.5 ? disp(SC.conduitVelocity(q, cd.c.wetted(i, level))) : 0);
    }
  }
  for (const r of Object.values(resObjects)) {
    const s = V.reservoirs[r.f.id];
    r.net = s ? s.net : 0;
    const frac = s && r.holdsMG > 0 ? clamp01(s.vol / r.holdsMG) : 0;
    if (Math.abs(frac - r.shown) < 1e-4) continue;
    r.shown = frac;
    r.water.visible = r.fw.update(frac);
    const [hx, hz] = r.fw.surfaceHalf, y = r.fw.surfaceY;
    r.waterline.geometry.dispose();
    r.waterline.geometry = new THREE.BufferGeometry().setFromPoints([V3(-hx, y, -hz), V3(hx, y, -hz), V3(hx, y, hz), V3(-hx, y, hz), V3(-hx, y, -hz)]);
    r.waterline.visible = r.water.visible;
    r.waterline.material.color.set(s && s.cap > 0 && s.vol / s.cap > 0.995 ? 0xff9a6b : 0x8ad8ff);
  }
  for (const set of shaftSets) {
    if (!set.sid) continue;
    const s = V.systems[set.sid], drive = clamp01((s ? s.inflow : 0) / 3000);
    if (Math.abs(drive - set.drive) > 0.002) {
      set.drive = drive;
      const rr = (10 * FT) / 2 * ST.dExag * 0.62;
      set.items.forEach((sh, i) => {
        const d = sh._y || 1, h = Math.max(d * drive, 1e-3);
        _d.rotation.set(0, 0, 0); _d.position.set(sh.x, -d + h / 2, sh.z); _d.scale.set(rr, h, rr); _d.updateMatrix(); set.wmesh.setMatrixAt(i, _d.matrix);
      });
      set.wmesh.instanceMatrix.needsUpdate = true;
    }
    set.wmesh.visible = drive > 0.004;
  }
  for (const po of Object.values(pumpObjects)) {
    const sysIds = Object.keys(D.systems).filter(sid => D.systems[sid].pump === po.f.id);
    const q = sysIds.reduce((a, sid) => a + (V.systems[sid] ? V.systems[sid].pumped : 0), 0);
    po.pumped = q;
    if (po.rmat) {
      po.riserV = SC.conduitVelocity(q, Math.PI * po.riserR * po.riserR);
      po.rmat.userData.flow.uSpeed.value = q > 1 ? disp(po.riserV) : 0;
      po.rmat.userData.flow.uStrength.value = q > 1 ? 1.1 : 0;
    }
    if (po.gauge) {
      let vol = 0, cap = 0;
      for (const sid of sysIds) { vol += V.systems[sid].vol; cap += V.systems[sid].cap; }
      po.gauge.obj.visible = cap > 0;
      const pct = cap > 0 ? Math.min(1, vol / cap) : 0;
      po.gauge.div.classList.toggle('full', pct > 0.995);
      po.gauge.div.innerHTML = gaugeHtml(sysIds.map(x => D.systems[x].name.replace(/ Tunnel System.*/, '')).join(' + ') + ' tunnel', pct, `${num(vol)} / ${num(cap)} MG`);
    }
  }
  for (const po of Object.values(plantObjects)) {
    const st = V.plants[po.f.id]; if (!st) continue;
    po.rate = st.flow;
    po.budget = SC.plantTimeBudget(po.lay.train, Math.max(st.flow, 0.1), po.lay.inlet, po.lay.outlet);
    const vel = po.trainGeo.attributes.aVel.array, cum = po.trainGeo.userData.cum, segs = po.budget.segs.filter(s => s.kind === 'channel');
    for (let i = 0; i < cum.length; i++) { const sg = segs[Math.min(i, segs.length - 1)]; vel[i * 2] = vel[i * 2 + 1] = sg ? disp(sg.v) : 0; }
    po.trainGeo.attributes.aVel.needsUpdate = true;
    for (const seg of po.budget.segs) {
      if (seg.kind !== 'dwell') continue;
      const stg = po.stages[seg.id]; if (!stg) continue;
      stg.hrt = seg.hrt;
      stg.wmat.userData.flow.uSpeed.value = disp(seg.v) * 4;
      if (stg.label) stg.label.innerHTML = `<b>${stg.spec.train === 'solids' ? '' : (stg.spec.stage + '. ')}${esc(stg.spec.label)}</b><i>${esc(stg.dims)}</i><i class="hrt">holds it ${fmtDur(seg.hrt)} · ${(seg.v * 3.281).toFixed(2)} ft/s</i>`;
    }
    const pct = clamp01(st.flow / st.dmf);
    po.gauge.div.classList.toggle('full', pct > 0.995);
    po.gauge.div.innerHTML = gaugeHtml(po.f.short + ' WRP', pct, `${num(st.flow)} / ${num(st.dmf)} MGD`);
    const csoRate = po.f.basin && V.basins[po.f.basin] ? V.basins[po.f.basin].cso : 0;
    const totalRated = po.csoPaths.reduce((a, x) => a + (x.spec.ratedMGD || 200), 0) || 1;
    for (const cp of po.csoPaths) {
      const share = csoRate * ((cp.spec.ratedMGD || 200) / totalRated), passed = cp.spec.ratedMGD ? Math.min(share, cp.spec.ratedMGD) : share;
      cp.share = share; cp.passed = passed; cp.backup = Math.max(0, share - passed);
      cp.v = share > 1 ? SC.conduitVelocity(passed, cp.spec.areaM2 || 14) : 0;
      cp.on = share > 1; cp.ribbon.visible = cp.on;
      cp.geo.setVelocity(disp(cp.v));
      cp.guide.material.opacity = cp.on ? 0.6 : 0.25;
      cp.marker.material.emissiveIntensity = cp.on ? 1.4 : 0.15;
    }
  }
  // the links: which way, how fast
  for (const l of links) {
    let q = 0;
    if (l.kind === 'inflow' || l.kind === 'drain') {
      const r = V.reservoirs[l.res]; const net = r ? r.net : 0;
      q = l.kind === 'inflow' ? Math.max(0, net) : Math.max(0, -net);
    } else if (l.kind === 'return') { q = (l.sids || [l.sid]).reduce((a, x) => a + (V.systems[x] ? V.systems[x].pumped : 0), 0); }
    else if (l.kind === 'interceptor') {
      const po = plantObjects[l.plant], st = V.plants[l.plant];
      const ret = Object.keys(D.systems).filter(s => D.systems[s].plant === l.plant).reduce((a, s) => a + (V.systems[s] ? V.systems[s].pumped : 0), 0);
      const n = Object.values(INTERCEPTOR).filter(p => p === l.plant).length || 1;
      q = st ? Math.max(0, st.flow - ret) / n : 0;
    } else if (l.kind === 'effluent') { const st = V.plants[l.plant]; q = st ? st.flow : 0; }
    l.q = q; l.v = SC.conduitVelocity(q, l.areaM2);
    l.c.setVelocity(disp(l.v));
    l.mesh.material.opacity = q > 1 ? 0.92 : 0.3;
  }
  ST.rainK = Math.min(1, V.inHr / 0.5);
  layerG.basins.children.forEach(m => { m.material.opacity = 0.11 + ST.rainK * 0.14; });
}

/* ============================================ 6. panels and readouts */
function srcChip(tag, note) {
  const s = D.sources[tag] || D.sources[(tag || '').split(':')[0]];
  const cls = tag === 'assumed' ? 'assumed' : tag === 'derived' ? 'derived' : 'sourced';
  return `<span class="chip ${cls}" title="${esc(s ? s[0] : tag)}${note ? ' — ' + esc(note) : ''}">${esc(tag)}</span>`;
}
function inspect(rec) {
  ST.selected = rec;
  const p = $('#inspector');
  if (!rec) { p.classList.add('empty'); p.innerHTML = '<p class="hint">Click any tunnel, shaft, tank, pump house, reservoir or connecting conduit to see its real dimensions and where they come from.</p>'; return; }
  p.classList.remove('empty'); renderInspector();
  document.querySelector('[data-tab="inspect"]').click();
}
let inspTick = 0;
function renderInspector() {
  const rec = ST.selected; if (!rec) return;
  let h = `<h3>${esc(rec.title)}</h3>`;
  if (rec.sub) h += `<div class="sub">${esc(rec.sub)}</div>`;
  if (rec.conflict) h += `<div class="conflict"><b>Source conflict.</b> ${esc(rec.conflict)}</div>`;
  if (rec.rows && rec.rows.length) {
    h += '<table class="spec">';
    for (const [k, v, s, n] of rec.rows) h += `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'function' ? v() : v)} ${srcChip(s, n)}</td></tr>`;
    h += '</table>';
  }
  if (rec.note) h += `<p class="note">${esc(rec.note)}</p>`;
  if (rec.doc && D.sources[rec.doc] && D.sources[rec.doc][1]) h += `<p><a href="${D.sources[rec.doc][1]}">${esc(D.sources[rec.doc][0])} →</a></p>`;
  if (rec.facId) h += `<p><button class="mini" data-focus="${esc(rec.facId)}">Fly here at true 1:1 scale</button></p>`;
  $('#inspector').innerHTML = h;
}
let readoutAt = 0;
function renderReadout() {
  if (!V.ready) return;
  const hrs = V.t;
  $('#clock').textContent = `${Math.floor(hrs)}h ${String(Math.round((hrs % 1) * 60)).padStart(2, '0')}m`;
  $('#rainrate').textContent = V.inHr > 0.001 ? `${V.inHr.toFixed(2)} in/hr` : 'dry';
  let h = '';
  for (const [sid, s] of Object.entries(V.systems)) if (s.cap > 0) h += gaugeRow(D.systems[sid].name, s.vol, s.cap, D.systems[sid].color, 'MG');
  for (const [rid, r] of Object.entries(V.reservoirs)) { if (r.cap === 0) continue; const fac = facById(rid); h += gaugeRow(fac ? fac.short + ' Reservoir' : rid, r.vol, r.cap, '#5aa0c8', 'MG'); }
  h += '<div class="gsep"></div>';
  for (const [pid, p] of Object.entries(V.plants)) { if (p.dmf < 50) continue; const fac = facById(pid); h += gaugeRow((fac ? fac.short : pid) + ' WRP', p.flow, p.dmf, p.flow / p.dmf > 0.99 ? '#d64545' : '#2c9a8f', 'MGD'); }
  $('#gauges').innerHTML = h;
  const cso = $('#csobox');
  cso.classList.toggle('active', V.csoRate > 1);
  cso.innerHTML = `<div class="k">Combined sewer overflow</div><div class="v">${num(V.csoCum)} <span>MG discharged</span></div><div class="r">${V.csoRate > 1 ? `discharging now at ${num(V.csoRate)} MGD` : 'no overflow'}</div><div class="r">pumped back for treatment: ${num(V.pumpedRate)} MGD</div>`;
  const ph = $('#phase'), filling = Object.values(V.systems).some(s => s.inflow > 1);
  let txt, cls = '';
  if (V.csoRate > 1) { txt = `<b>Discharging</b> — the tunnels and reservoirs are full; ${num(V.csoRate)} MGD is going to the rivers untreated`; cls = 'cso'; }
  else if (V.inHr > 0.005 && filling) { txt = `<b>Raining ${V.inHr.toFixed(2)} in/hr</b> — excess is going down the drop shafts`; cls = 'rain'; }
  else if (V.pumpedRate > 1) txt = `<b>Dewatering</b> — pumping ${num(V.pumpedRate)} MGD back up to the plants`;
  else if (ST.pos < 0.5) txt = '<b>Dry weather</b> — press play';
  else txt = '<b>Dry weather</b> — storage is empty again';
  ph.className = cls; ph.innerHTML = txt;
  if (ST.selected && ++inspTick % 2 === 0) renderInspector();
}
const gaugeRow = (name, v, cap, color, unit) => {
  const pct = cap > 0 ? clamp01(v / cap) : 0;
  return `<div class="gauge${pct > 0.995 ? ' full' : ''}"><div class="gl"><span>${esc(name)}</span><b>${(pct * 100).toFixed(0)}%</b></div><div class="gb"><i style="width:${(pct * 100).toFixed(1)}%;background:${color}"></i></div><div class="gv">${num(v)} / ${num(cap)} ${unit}</div></div>`;
};
function renderSummary() {
  const s = ST.run.summary, c = ST.run.config;
  let val = '';
  if (Math.abs(ST.storm.inches - 6.64) < 0.01 && ST.storm.config === 'tunnels') {
    const rec = D.sim.events.find(e => e.date === '2008-09-13');
    if (rec) {
      const four = ['ps-north-branch', 'ps-racine', 'ps-westchester', 'ps-125th'].reduce((a, k) => a + (s.csoByStation[k] || 0), 0);
      val = `<div class="valid"><b>Against the record.</b> MWRD logged ${rec.totalMG.toLocaleString()} MG of discharge across four pumping stations on 13 Sept 2008. This model puts those same four at <b>${num(four)} MG</b>. The runoff coefficient (0.32) was chosen to make that comparison line up — it is the model’s one calibrated parameter.</div>`;
    }
  }
  $('#summary').innerHTML = `
    <div class="srow"><span>Rain on the combined sewer area</span><b>${num(s.rainVolMG)} MG</b></div>
    <div class="srow"><span>More than the plants could take</span><b>${num(s.excessMG)} MG</b></div>
    <div class="srow"><span>Captured by tunnels + reservoirs</span><b>${s.capturePct.toFixed(1)}%</b></div>
    <div class="srow${s.csoMG > 1 ? ' bad' : ''}"><span>Discharged to the rivers</span><b>${num(s.csoMG)} MG</b></div>
    <div class="srow"><span>Storage empty again after</span><b>${s.emptyHr != null ? (s.emptyHr < 48 ? s.emptyHr.toFixed(0) + ' h' : (s.emptyHr / 24).toFixed(1) + ' days') : 'still holding at ' + (ST.run.totalHr / 24).toFixed(0) + ' days'}</b></div>
    ${bottleneck(s)}<div class="cfgnote">${esc(c.note)}</div>${val}`;
}
function bottleneck(s) {
  let slow = Object.entries(s.boundBy || {}).filter(([sid, b]) => b === 'plant' && ST.run.frames[0].systems[sid].capMG > 0);
  if (!slow.length) return '';
  const ratio = sid => (D.sim.plants[D.systems[sid].plant].dmf - D.sim.plants[D.systems[sid].plant].avg) / D.sim.pumps[D.systems[sid].pump].capMGD;
  slow.sort((a, b) => ratio(a[0]) - ratio(b[0]));
  const names = slow.slice(0, 2).map(([sid]) => { const sys = D.systems[sid], plant = facById(sys.plant), p = D.sim.plants[sys.plant];
    return `${sys.name} (${plant ? plant.short : ''} has ${num(p.dmf - p.avg)} MGD spare against ${num(D.sim.pumps[sys.pump].capMGD)} MGD of pumps)`; });
  return `<div class="cfgnote"><b>What sets the drawdown rate.</b> Emptying the tunnel is limited by the receiving plant, not the pumps, for: ${names.join('; ')}. Switch "dewatering limited by" to pump nameplate to see the difference.</div>`;
}
function canvasCtx(sel, minH) {
  const cv = $(sel), w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio;
  if (w < 20 || h < (minH || 8)) return null;
  cv.width = w; cv.height = h; const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function drawChart() {
  const c = canvasCtx('#chart'); if (!c || !ST.run) return;
  const { ctx, w, h } = c, F = ST.run.frames, maxT = F[F.length - 1].t, x = t => (t / maxT) * w, px = devicePixelRatio;
  const maxI = Math.max(0.01, ...F.map(f => f.inHr));
  ctx.fillStyle = 'rgba(90,150,200,.25)'; ctx.beginPath(); ctx.moveTo(0, 0);
  for (const f of F) ctx.lineTo(x(f.t), (f.inHr / maxI) * h * 0.30);
  ctx.lineTo(w, 0); ctx.closePath(); ctx.fill();
  const series = [];
  for (const [sid, s] of Object.entries(D.systems)) if (F[0].systems[sid].capMG > 0) series.push([s.color, f => f.systems[sid].fill]);
  for (const rid of Object.keys(D.sim.reservoirs)) if (F[0].reservoirs[rid].capMG > 0) series.push(['#5aa0c8', f => f.reservoirs[rid].fill]);
  ctx.lineWidth = 2 * px;
  for (const [col, fn] of series) { ctx.strokeStyle = col; ctx.beginPath(); F.forEach((f, i) => { const y = h - fn(f) * h * 0.92; i ? ctx.lineTo(x(f.t), y) : ctx.moveTo(x(f.t), y); }); ctx.stroke(); }
  const maxC = Math.max(1, ...F.map(f => f.csoCum));
  ctx.strokeStyle = '#d64545'; ctx.lineWidth = 2.4 * px; ctx.setLineDash([6 * px, 4 * px]); ctx.beginPath();
  F.forEach((f, i) => { const y = h - (f.csoCum / maxC) * h * 0.92; i ? ctx.lineTo(x(f.t), y) : ctx.moveTo(x(f.t), y); });
  ctx.stroke(); ctx.setLineDash([]);
  $('#chartmax').textContent = maxC > 1 ? `CSO peak ${num(maxC)} MG` : 'no CSO';
  const marks = [];
  if (ST.run.opts.hours > 0) marks.push([ST.run.opts.hours, 'rain ends', '#5a96c8']);
  const firstCso = F.find(f => f.csoRate > 1); if (firstCso) marks.push([firstCso.t, 'first discharge', '#d64545']);
  if (ST.run.summary.emptyHr) marks.push([ST.run.summary.emptyHr, 'empty', '#2c9a8f']);
  ctx.font = `${9.5 * px}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'left';
  for (const [t, lbl, col] of marks) {
    const xx = x(t); ctx.strokeStyle = col; ctx.lineWidth = px; ctx.setLineDash([3 * px, 3 * px]);
    ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, h); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.fillText(lbl, xx + 3 * px, h - 4 * px);
  }
}
function drawPlayhead() {
  const c = canvasCtx('#playhead'); if (!c || !ST.run) return;
  const { ctx, w, h } = c, xx = (ST.pos / (ST.run.frames.length - 1)) * w;
  ctx.strokeStyle = dark ? '#e8eef5' : '#1a202c'; ctx.lineWidth = 1.5 * devicePixelRatio;
  ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, h); ctx.stroke();
}
function drawLadder() {
  const c = canvasCtx('#ladder', 40); if (!c) return;
  const { ctx, w, h } = c, px = devicePixelRatio;
  const items = [['4 in', 4 / 12, '#7d8fa5'], ['12 in', 1, '#7d8fa5'], ['36 in', 3, '#7d8fa5'], ['78 in', 6.5, '#8fa1b5'], ['17 ft city trunk', 17, '#6f8095'], ['27 ft MWRD interceptor', 27, '#b7791f'], ['33 ft Deep Tunnel', 33, '#e2a33c']];
  const pad = 10 * px, scale = (h - pad * 2 - 40 * px) / 33;
  let x = pad + 8 * px;
  ctx.font = `${10 * px}px -apple-system,system-ui,sans-serif`;
  for (const [lbl, ft, col] of items) {
    const r = ft * scale / 2;
    ctx.beginPath(); ctx.arc(x + r, h - pad - r, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = dark ? '#0d1218' : '#ffffff'; ctx.lineWidth = px; ctx.stroke();
    ctx.fillStyle = dark ? '#9fb0c2' : '#4a5568';
    ctx.save(); ctx.translate(x + r, h - pad - r * 2 - 6 * px); ctx.rotate(-Math.PI / 2.6); ctx.textAlign = 'left'; ctx.fillText(lbl, 0, 0); ctx.restore();
    x += r * 2 + 14 * px;
  }
  const ph = 5.9 * scale;
  ctx.fillStyle = dark ? '#e8eef5' : '#1a202c';
  ctx.beginPath(); ctx.arc(x + 4 * px, h - pad - ph, ph * 0.12, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(x + 2 * px, h - pad - ph * 0.82, 5 * px, ph * 0.82);
  ctx.fillStyle = dark ? '#9fb0c2' : '#4a5568'; ctx.textAlign = 'left'; ctx.fillText('5 ft 11 in', x - 6 * px, h - pad + 9 * px);
}
function renderFidelity() {
  let h = '<table class="fid"><tr><th>Tunnel system</th><th>route drawn</th><th>published</th><th>volume drawn</th><th>published</th></tr>';
  for (const [sid, f] of Object.entries(D.fidelity))
    h += `<tr class="${Math.abs(f.lenDeltaPct) > 15 ? 'warn' : ''}"><td>${esc(D.systems[sid].name)}</td><td>${f.drawnMi} mi</td><td>${f.sourcedMi} mi <i>(${f.lenDeltaPct >= 0 ? '+' : ''}${f.lenDeltaPct}%)</i></td><td>${num(f.drawnMG)} MG</td><td>${f.sourcedMG.toLocaleString()} MG <i>(${f.volDeltaPct >= 0 ? '+' : ''}${f.volDeltaPct}%)</i></td></tr>`;
  h += '</table><table class="fid"><tr><th>Reservoir</th><th>solid drawn holds</th><th>published</th><th>solved for</th></tr>';
  for (const f of D.facilities) if (f.kind === 'reservoir')
    h += `<tr><td>${esc(f.short)}</td><td>${num(f.geom.geomMG)} MG</td><td>${f.geom.sourcedMG.toLocaleString()} MG <i>(${f.geom.deltaPct >= 0 ? '+' : ''}${f.geom.deltaPct}%)</i></td><td>${esc(f.geom.solvedFor)}</td></tr>`;
  h += '</table>';
  if (D.repairs && D.repairs.length)
    h += '<h4 style="margin-top:14px">Defects repaired in the traced geometry</h4><p class="hint">Each of these showed up in the model as a straight line running across the map, following nothing. They are errors in the corridor tracing, not modelling choices, and the repair is applied in <code>scripts/build_system3d.py</code> where it can be audited.</p><ul>' + D.repairs.map(r => `<li>${esc(r)}</li>`).join('') + '</ul>';
  $('#fidelity').innerHTML = h;
  $('#caveats').innerHTML = '<ul>' + D.meta.caveats.map(c => `<li>${esc(c)}</li>`).join('') + '</ul>';
}
const _hud = new THREE.Vector3();
let hudAt = 0;
function updateNavHud(now) {
  if (now - hudAt < 90) return; hudAt = now;
  _hud.subVectors(controls.target, camera.position); _hud.y = 0;
  const az = Math.atan2(_hud.x, -_hud.z);
  if (isFinite(az)) $('#needle').setAttribute('transform', `rotate(${(-az * 180 / Math.PI).toFixed(1)} 20 20)`);
  const dist = camera.position.distanceTo(controls.target), mPerPx = 2 * dist * Math.tan(camera.fov * Math.PI / 360) / host.clientHeight;
  const nice = [10, 20, 50, 100, 200, 500, 1000, 1609.344, 3218.7, 8046.7, 16093.4, 32186.9, 80467.2];
  let L = nice[0]; for (const n of nice) if (n <= mPerPx * 110) L = n;
  $('#scalebar i').style.width = (L / mPerPx).toFixed(0) + 'px';
  $('#scaletxt').textContent = L >= 1609 ? `${(L / 1609.344).toFixed(0)} mi` : (L >= 1000 ? `${(L / 1000).toFixed(0)} km` : `${L} m`);
  const dFt = -controls.target.y / ST.vExag / FT;
  $('#depthtxt').textContent = dFt > 5 ? `pivot ${dFt.toFixed(0)} ft below grade` : 'pivot at grade';
}

/* ============================================================ 7. wiring */
function buildUI() {
  const names = { geo: 'Geography (lake, rivers, district)', contours: 'Ground contours (10 ft)', tunnels: 'Deep tunnels', water: 'Water in the tunnels', shafts: 'TARP drop shafts',
    connections: 'Interceptor connecting structures', links: 'Conduits between facilities', reservoirs: 'Reservoirs', plants: 'Treatment plants',
    pumps: 'Pumping stations', outfalls: 'CSO outfalls (441)', basins: 'Combined sewer areas', labels: 'Labels', flow: 'Flow animation' };
  const box = $('#layers');
  for (const [k, lbl] of Object.entries(names)) {
    const row = el('label', 'lrow', `<input type="checkbox"${ST.layers[k] ? ' checked' : ''}><span>${lbl}</span>`);
    box.appendChild(row);
    row.querySelector('input').addEventListener('change', e => { ST.layers[k] = e.target.checked ? 1 : 0; });
  }
  const cs = $('#config'); for (const c of CONFIGS) cs.appendChild(el('option', null, c.label)).value = c.id; cs.value = ST.storm.config;
  const ss = $('#scenario'); for (const s of D.sim.scenarios) { const o = el('option', null, s.label); o.value = s.id; ss.appendChild(o); } ss.value = 'design';
  const ev = $('#eventlist');
  for (const e of D.sim.events.slice(0, 12)) {
    const b = el('button', 'evbtn', `<b>${e.date}</b><span>${e.totalMG.toLocaleString()} MG recorded</span>`);
    b.addEventListener('click', () => {
      const yr = +e.date.slice(0, 4), cfg = yr < 2007 ? 'pre' : yr < 2015 ? 'tunnels' : yr < 2017 ? 'r2015' : 'today';
      $('#config').value = cfg; ST.storm.config = cfg;
      $('#recnote').innerHTML = `Recorded on <b>${e.date}</b>: ${e.totalMG.toLocaleString()} MG across ${Object.keys(e.stations).length} MWRD pumping stations (` +
        Object.entries(e.stations).map(([k, v]) => { const f = facById(k); return `${f ? f.short : k} ${v.toLocaleString()} MG`; }).join(', ') + `). Set a rainfall above and compare.`;
      runSim();
    });
    ev.appendChild(b);
  }
  const bind = (sel, fn) => $(sel).addEventListener('input', fn);
  bind('#vexag', e => { ST.vExag = +e.target.value; $('#vexagv').textContent = '×' + ST.vExag; applyScale(); });
  bind('#dexag', e => { ST.dExag = +e.target.value; $('#dexagv').textContent = '×' + ST.dExag; applyScale(); });
  $('#truescale').addEventListener('click', () => setScale(1, 1));
  $('#defscale').addEventListener('click', () => setScale(18, 34));
  $('#frameall').addEventListener('click', frameAll);
  $('#routemode').addEventListener('change', e => {
    ST.route = e.target.value;
    buildTunnels(); positionShafts(); buildLinks(); clearHi(); syncView(true);
    $('#routenote').textContent = ST.route === 'corridor'
      ? 'Drop shafts sit exactly on their MWRD coordinates; the route follows the traced surface corridor, which is longer than the published tunnel.'
      : 'The route is smoothed until its length matches MWRD’s published mileage; drop shafts are then offset from it by the amount the smoothing moved the line.';
  });
  bind('#rain', e => { ST.storm.inches = +e.target.value; $('#rainv').textContent = ST.storm.inches.toFixed(2) + ' in'; runSim(); });
  bind('#dur', e => { ST.storm.hours = +e.target.value; $('#durv').textContent = ST.storm.hours + ' h'; runSim(); });
  bind('#runoff', e => { ST.storm.runoffC = +e.target.value / 100; $('#runoffv').textContent = ST.storm.runoffC.toFixed(2); runSim(); });
  $('#scenario').addEventListener('change', e => {
    const s = D.sim.scenarios.find(x => x.id === e.target.value); if (!s) return;
    ST.storm.inches = s.inches; ST.storm.hours = s.hours || 1;
    $('#rain').value = s.inches; $('#rainv').textContent = s.inches.toFixed(2) + ' in'; $('#dur').value = ST.storm.hours; $('#durv').textContent = ST.storm.hours + ' h';
    $('#scennote').textContent = s.note; runSim();
  });
  $('#config').addEventListener('change', e => { ST.storm.config = e.target.value; runSim(); });
  $('#shape').addEventListener('change', e => { ST.storm.shape = e.target.value; runSim(); });
  $('#pumplimit').addEventListener('change', e => { ST.storm.pumpLimit = e.target.value; runSim(); });
  $('#play').addEventListener('click', () => togglePlay());
  $('#speed').addEventListener('input', e => { ST.speedIx = +e.target.value; $('#speedv').textContent = SPEEDS[ST.speedIx][1]; });
  $('#speedv').textContent = SPEEDS[ST.speedIx][1];
  $('#scrub').addEventListener('input', e => { ST.pos = +e.target.value; });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-focus]'); if (b) flyTo(b.getAttribute('data-focus'));
    const t = e.target.closest('[data-tab]');
    if (t) {
      const n = t.getAttribute('data-tab');
      document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === t));
      document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('on', p.id === 'tab-' + n));
      if (n === 'notes') renderFidelity();
      requestAnimationFrame(() => { drawLadder(); if (ST.run) drawChart(); });
    }
  });
  $('#legendX').addEventListener('click', () => $('#legend').classList.add('hidden'));
  $('#panelToggle').addEventListener('click', () => { document.body.classList.toggle('collapsed'); setTimeout(resize, 260); });
}
function togglePlay(v) {
  ST.playing = v == null ? !ST.playing : v;
  if (ST.playing && ST.pos >= ST.run.frames.length - 1.01) ST.pos = 0;
  $('#play').textContent = ST.playing ? '❚❚' : '▶';
}
function resize() {
  const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
  camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); labelRenderer.setSize(w, h);
  if (!isFinite(camera.position.x)) frameAll();
  if (ST.run) drawChart(); drawLadder();
}
addEventListener('resize', resize);

let last = performance.now(), clock = 0;
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now - last) / 1000); last = now; clock += dt;
  if (!isFinite(camera.position.x) || !isFinite(controls.target.x)) frameAll();
  applyKeys(dt); stepCamAnim(now);
  if (ST.run) {
    if (ST.playing) {
      ST.pos += dt * speedHrs() / ST.run.dtHr;
      if (ST.pos >= ST.run.frames.length - 1) { ST.pos = ST.run.frames.length - 1; togglePlay(false); }
      $('#scrub').value = ST.pos;
    }
    syncView(false, dt);
    if (now - readoutAt > 120) { readoutAt = now; renderReadout(); }
  }
  drawPlayhead();
  SC.tickFlow(flowMats, clock);
  // the flow toggle mutes every flow shader without touching its owner's speed
  const flowOn = ST.layers.flow === 1;
  for (const m of flowMats) {
    const u = m.userData.flow;
    if (m.userData.flowBase == null) m.userData.flowBase = u.uStrength.value;
    if (!flowOn) u.uStrength.value = 0;
    else if (u.uStrength.value === 0 && !(m === M.riser || m.userData.isRiser)) u.uStrength.value = m.userData.flowBase;
  }
  const pulse = 1 + 0.35 * Math.sin(now / 160);
  for (const po of Object.values(plantObjects)) for (const cp of po.csoPaths) cp.marker.scale.setScalar(cp.on ? 1.6 * pulse : 1);
  if (rain) {
    // rain reads at city scale; up close it is just squares, so it fades out
    const near = clamp01((camera.position.distanceTo(controls.target) - 4000) / 12000);
    rain.mat.opacity = lerp(rain.mat.opacity, ST.rainK * 0.32 * near, 1 - Math.pow(0.05, dt));
    rain.pts.visible = rain.mat.opacity > 0.01;
    if (rain.pts.visible) {
      const H = rain.H * Math.max(1, ST.vExag / 12);
      for (let i = 0; i < rain.N; i++) { let y = rain.pos[i * 3 + 1] / H - dt * 1.1 * (0.7 + rain.seed[i] * 0.6); if (y < 0) y += 1; rain.pos[i * 3 + 1] = y * H; }
      rain.pts.geometry.attributes.position.needsUpdate = true;
    }
  }
  for (const l of labelObjs) {
    const dd = camera.position.distanceTo(l.o.position), op = dd > l.d ? 0 : (dd > l.d * 0.78 ? 1 - (dd - l.d * 0.78) / (l.d * 0.22) : 0.94);
    l.div.style.opacity = op; l.div.style.display = op <= 0 ? 'none' : '';
  }
  updateNavHud(now);
  for (const k in ST.layers) if (layerG[k]) layerG[k].visible = !!ST.layers[k];
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

buildUI(); buildGround(); buildGeo(); buildSurface(); buildContours(); buildTunnels(); buildShafts(); buildReservoirs(); buildPlants(); buildPumps(); buildLinks();
frameAll();
$('#scennote').textContent = D.sim.scenarios.find(s => s.id === 'design').note;
runSim();
setScale(18, 34);
renderFidelity(); drawLadder(); inspect(null);
animate(performance.now());

window.__S3D = { THREE, scene, world, camera, controls, ST, V, D, layerG, conduits, resObjects, plantObjects, pumpObjects, shaftSets, links, setScale, flyTo, runSim, syncView, frameAll, model, KEYS };
