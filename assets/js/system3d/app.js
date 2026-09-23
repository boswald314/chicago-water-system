/* Chicago sewer system — 3D model viewer.
 * Data: window.SYS3D (built by scripts/build_system3d.py).
 * Hydrology: ./sim.js. Geometry: ./scene.js.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { SewerModel, CONFIGS } from './sim.js?v=5';
import * as SC from './scene.js?v=5';

const D = window.SYS3D;
const FT = SC.FT;
const $ = s => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const num = n => n == null ? '—' :
  (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() :
   Math.abs(n) >= 10 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(1) : n.toFixed(2));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Metres of on-screen travel per second for water moving at V_REF (1 m/s).
 * Everything in the model is animated off this one constant through
 * SC.displaySpeed, so every speed you see is in true proportion to every
 * other one. */
const FLOW_BASE = 900;

const ST = {
  vExag: 18, dExag: 34, route: 'corridor', trueScale: false,
  playing: false, speed: 8, frame: 0, run: null, needLevels: true,
  storm: { inches: 2.0, hours: 24, shape: 'peaked', runoffC: 0.32, config: 'today', pumpLimit: 'plant' },
  layers: { tunnels: 1, water: 1, shafts: 1, connections: 0, reservoirs: 1, plants: 1,
            pumps: 1, outfalls: 0, basins: 1, waterways: 1, labels: 1, particles: 1 },
  selected: null,
};

/* ==================================================== three.js bootstrap */
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
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.497;

scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x28303a, dark ? 1.6 : 2.1));
const sun = new THREE.DirectionalLight(0xffffff, dark ? 1.15 : 1.5);
sun.position.set(-30000, 70000, -25000); scene.add(sun);
const fill = new THREE.DirectionalLight(0x8fb4d6, 0.5);
fill.position.set(28000, 24000, 32000); scene.add(fill);

const world = new THREE.Group(); scene.add(world);
const layerG = {};
for (const k of Object.keys(ST.layers)) { const g = new THREE.Group(); g.name = k; world.add(g); layerG[k] = g; }

const pickables = [];
const info = new Map();
const conduits = [];
const sysConduits = {};
const sysGeomVol = {};
const shaftSets = [];
const resObjects = {};
const plantObjects = {};
const stageLabelNodes = {};
const pumpObjects = {};
const particles = {};
const labelObjs = [];

const M = {
  water: new THREE.MeshStandardMaterial({ color: SC.COL.water, roughness: 0.22, metalness: 0.12,
    emissive: 0x0d3a52, emissiveIntensity: 0.55, side: THREE.DoubleSide }),
  shaft: new THREE.MeshStandardMaterial({ color: SC.COL.shaft, roughness: 0.75, metalness: 0.15 }),
  shaftWater: new THREE.MeshStandardMaterial({ color: SC.COL.waterHi, roughness: 0.2,
    emissive: 0x1d6f92, emissiveIntensity: 0.8, transparent: true, opacity: 0.92 }),
  conn: new THREE.MeshStandardMaterial({ color: SC.COL.connection, roughness: 0.85 }),
  rock: new THREE.MeshStandardMaterial({ color: dark ? 0x4d5761 : 0x8f99a5, roughness: 0.96,
    side: THREE.DoubleSide, flatShading: true }),
  resWater: new THREE.MeshStandardMaterial({ color: 0x2d93cc, roughness: 0.12, metalness: 0.25,
    emissive: 0x11557a, emissiveIntensity: 0.75, transparent: true, opacity: 0.97,
    side: THREE.DoubleSide }),
  pad: new THREE.MeshStandardMaterial({ color: dark ? 0x333c47 : 0xbac3ce, roughness: 1 }),
  tank: new THREE.MeshStandardMaterial({ color: SC.COL.plant, roughness: 0.6, metalness: 0.08 }),
  bldg: new THREE.MeshStandardMaterial({ color: SC.COL.pump, roughness: 0.7 }),
  river: new THREE.MeshBasicMaterial({ color: SC.COL.river, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
  basin: new THREE.MeshBasicMaterial({ color: SC.COL.basin, transparent: true, opacity: 0.17,
    side: THREE.DoubleSide, depthWrite: false }),
  outfall: new THREE.MeshStandardMaterial({ color: SC.COL.outfall, roughness: 0.6, emissive: 0x3d0e0e }),
  hi: new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true, transparent: true, opacity: 0.9 }),
};
const tunnelMat = {};
for (const [sid, s] of Object.entries(D.systems)) {
  tunnelMat[sid] = new THREE.MeshStandardMaterial({
    color: new THREE.Color(s.color), roughness: 0.82, metalness: 0.06,
    transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false,
    emissive: new THREE.Color(s.color).multiplyScalar(0.18) });
}

function reg(mesh, rec) { info.set(mesh.uuid, rec); pickables.push(mesh); }

/* ============================================================ build world */
function pts2(feat) { return ST.route === 'corridor' ? feat.corridor : feat.pts; }

function buildTunnels() {
  layerG.tunnels.clear(); layerG.water.clear();
  conduits.length = 0;
  for (const k of Object.keys(sysConduits)) delete sysConduits[k];
  for (const f of D.tunnels) {
    const p = pts2(f);
    const depths = f.depth.map(d => d * FT);
    const radii = f.dia.map(d => d * FT / 2);
    // corridor mode has the same vertex count as the calibrated line
    const c = new SC.Conduit(p, depths, radii, { ring: 12 });
    const mesh = new THREE.Mesh(c.geom, tunnelMat[f.system]);
    mesh.renderOrder = 2;
    layerG.tunnels.add(mesh);
    const w = new SC.ConduitWater(c);
    const wm = new THREE.Mesh(w.geom, M.water);
    wm.renderOrder = 3;
    layerG.water.add(wm);
    const sys = D.systems[f.system];
    reg(mesh, {
      kind: 'tunnel', title: f.name, sub: sys.name,
      rows: [
        ['Diameter along this reach', `${f.dia[0].toFixed(1)}–${f.dia[f.dia.length - 1].toFixed(1)} ft`, 'derived'],
        ['Depth below ground', `${f.depth[0]}–${f.depth[f.depth.length - 1]} ft`, 'doc09'],
        ['Drawn length', `${f.lenMi} mi (as-traced corridor ${f.corridorMi} mi)`, 'derived'],
        ['System length', `${sys.lengthMi.v} mi`, sys.lengthMi.s],
        ['System storage', `${sys.storageMG.v.toLocaleString()} MG`, sys.storageMG.s],
        ['System diameter range', `${sys.diaFt.v[0]}–${sys.diaFt.v[1]} ft`, sys.diaFt.s],
      ],
      note: f.note, sysId: f.system, doc: 'doc09',
    });
    conduits.push({ sid: f.system, c, w, mesh, wm, feat: f });
    (sysConduits[f.system] = sysConduits[f.system] || []).push(c);
  }
  for (const sid of Object.keys(sysConduits))
    sysGeomVol[sid] = sysConduits[sid].reduce((a, c) => a + c.volumeAt(-1e9), 0);
  buildParticles();
  ST.needLevels = true;
}

function buildShafts() {
  layerG.shafts.clear(); layerG.connections.clear();
  shaftSets.length = 0;
  const groups = {};
  for (const s of D.shafts) {
    const key = s.system || 'connection';
    (groups[key] = groups[key] || []).push(s);
  }
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  for (const [key, items] of Object.entries(groups)) {
    const isConn = key === 'connection';
    const mesh = new THREE.InstancedMesh(cyl, isConn ? M.conn : M.shaft, items.length);
    mesh.frustumCulled = false;
    const wmesh = new THREE.InstancedMesh(cyl, M.shaftWater, items.length);
    wmesh.frustumCulled = false;
    (isConn ? layerG.connections : layerG.shafts).add(mesh);
    if (!isConn) layerG.shafts.add(wmesh);
    shaftSets.push({ sid: isConn ? null : key, mesh, wmesh, items });
    reg(mesh, { kind: 'shaftset', key, items });
  }
  positionShafts();
  buildPlunge();
}

/* Water falling down the drop shafts. A "Chicago style" plunge shaft is a
 * split air/water shaft with a vent chamber at the top, engineered from 1975
 * physical hydraulic-model testing at the St Anthony Falls laboratory
 * specifically to dissipate the energy of a fall of this size. The plunge is
 * drawn at a design-limited velocity rather than free fall, which over 250 ft
 * would reach about 130 ft/s. */
const PLUNGE_MS = 8.0;              // assumed, energy-dissipated design value
function buildPlunge() {
  for (const set of shaftSets) {
    if (!set.sid) continue;
    const per = 3, N = set.items.length * per;
    const pos = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xb8ecff, size: 300, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    layerG.shafts.add(pts);
    const prog = new Float32Array(N);
    for (let i = 0; i < N; i++) prog[i] = Math.random();
    set.plunge = { pts, pos, mat, prog, N, per };
  }
}

function positionShafts() {
  const dummy = new THREE.Object3D();
  const repDia = 10 * FT;                          // representative shaft diameter
  for (const set of shaftSets) {
    set.items.forEach((s, i) => {
      const corridor = ST.route === 'corridor';
      const depthFt = corridor ? (s.cdepth != null ? s.cdepth : s.depth) : s.depth;
      const d = (set.sid ? depthFt : 25) * FT * ST.vExag;
      const r = (set.sid ? repDia : 6 * FT) / 2 * ST.dExag;
      dummy.position.set(s.x, -d / 2, s.z);
      dummy.scale.set(r, Math.max(d, 1), r);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      set.mesh.setMatrixAt(i, dummy.matrix);
      if (set.wmesh) {
        dummy.scale.set(r * 0.62, 1e-4, r * 0.62);
        dummy.updateMatrix();
        set.wmesh.setMatrixAt(i, dummy.matrix);
      }
      s._y = d;
    });
    set.mesh.instanceMatrix.needsUpdate = true;
    if (set.wmesh) set.wmesh.instanceMatrix.needsUpdate = true;
  }
}

function buildReservoirs() {
  layerG.reservoirs.clear();
  for (const f of D.facilities) {
    if (f.kind !== 'reservoir') continue;
    const g = f.geom;
    const grp = new THREE.Group();
    grp.position.set(f.x, 0, f.z);
    const bench = f.shape === 'quarry' ? 6 : (f.shape === 'pit' ? 4 : 0);
    const pit = new THREE.Mesh(SC.frustumGeometry(g.L, g.W, g.D * ST.vExag, g.insetM, bench), M.rock);
    grp.add(pit);
    const rimPts = [
      new THREE.Vector3(-g.L / 2, 0, -g.W / 2), new THREE.Vector3(g.L / 2, 0, -g.W / 2),
      new THREE.Vector3(g.L / 2, 0, g.W / 2), new THREE.Vector3(-g.L / 2, 0, g.W / 2),
      new THREE.Vector3(-g.L / 2, 0, -g.W / 2)];
    const rim = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rimPts),
      new THREE.LineBasicMaterial({ color: f.retired ? 0x7a8694 : 0x6fc3e8 }));
    grp.add(rim);
    layerG.reservoirs.add(grp);
    const sys = f.system ? D.systems[f.system] : null;
    reg(pit, {
      kind: 'reservoir', title: f.name, sub: f.retired ? 'decommissioned' : (sys ? sys.name : ''),
      rows: [
        ['Capacity (TARP share)', `${f.spec.capMG.v.toLocaleString()} MG`, f.spec.capMG.s],
        ['Capacity (total)', `${f.spec.capFullMG.v.toLocaleString()} MG`, f.spec.capFullMG.s],
        ['Depth', `${g.depthFt} ft (${num(g.D)} m)`, f.spec.depthFt.s],
        ['Surface', `${g.topAcres} acres`, f.spec.surfaceAcres ? f.spec.surfaceAcres.s : 'derived'],
        ['Drawn as', `${num(g.L)} × ${num(g.W)} × ${num(g.D)} m frustum`, 'derived'],
        ['Volume check', `drawn solid holds ${g.geomMG.toLocaleString()} MG vs published ${g.sourcedMG.toLocaleString()} MG (${g.deltaPct >= 0 ? '+' : ''}${g.deltaPct}%)`, 'derived'],
        ['Dimension solved for', g.solvedFor, 'derived'],
        ['Drawn for the selected era', () => {
          const r = resObjects[f.id];
          return r ? `${num(r.builtMG)} MG excavated — plan dimensions scaled by ×${r.k.toFixed(2)}` : '—';
        }, 'derived'],
      ],
      note: f.note, doc: f.doc, facId: f.id,
    });
    // no floating gauge: the water level drawn inside the structure IS the readout
    resObjects[f.id] = { f, grp, pit, rim, water: null, waterline: null, bench, k: 1,
                         builtMG: f.spec.capFullMG.v };
    addLabel(f.short, f.x, f.z, 30, 'res', 60000);
  }
}

function buildPlants() {
  layerG.plants.clear();
  for (const f of D.facilities) {
    if (f.kind !== 'wrp') continue;
    const g = f.geom;
    const grp = new THREE.Group();
    grp.position.set(f.x, 0, f.z);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(g.siteL, 2 * ST.vExag, g.siteW), M.pad);
    pad.position.y = ST.vExag;
    grp.add(pad);

    const rows = [
      ['Design average flow', `${f.spec.daf.v.toLocaleString()} MGD`, f.spec.daf.s],
      ['Design maximum flow', `${f.spec.dmf.v.toLocaleString()} MGD`, f.spec.dmf.s],
      ['Reported average flow', `${f.spec.avg.v.toLocaleString()} MGD`, f.spec.avg.s],
      ['Site', `${f.spec.acres.v} acres (drawn ${num(g.siteL)} \u00d7 ${num(g.siteW)} m)`, f.spec.acres.s],
    ];
    if (!f.basin) rows.push(['In the storm model',
      'held at its reported average flow \u2014 this plant serves separate-sewer suburbs that are ' +
      'not inside MWRD\u2019s combined-sewer areas, so no storm flow is routed to it', 'derived']);

    const lay = SC.layoutPlant(g);
    const byRow = {};
    for (const t of lay.tanks) (byRow[t.row] = byRow[t.row] || []).push(t);
    const nStage = Math.max(1, lay.train.length);
    const dummy = new THREE.Object3D();
    const stageMeshes = {}, waterMeshes = {};

    for (const [rid, list] of Object.entries(byRow)) {
      const spec = g.rows.find(r => r.id === rid);
      const proto = list[0];
      const idx = lay.train.findIndex(t => t.id === rid);
      const frac = spec.train === 'solids' ? 1 : (idx < 0 ? 0.5 : idx / Math.max(1, nStage - 1));

      const shell = proto.type === 'cyl'
        ? new THREE.CylinderGeometry(1, 1, 1, 24, 1, true)
        : new THREE.BoxGeometry(1, 1, 1);
      const wallMat = new THREE.MeshStandardMaterial({
        color: spec.train === 'solids' ? 0x8a7f6a : 0xb4bec9,
        roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide });
      const im = new THREE.InstancedMesh(shell, wallMat, list.length);

      // the water the plant is actually treating, graded raw -> clarified
      const wgeo = proto.type === 'cyl'
        ? new THREE.CylinderGeometry(1, 1, 1, 24) : new THREE.BoxGeometry(1, 1, 1);
      const wmat = new THREE.MeshStandardMaterial({
        color: SC.trainColor(frac), roughness: 0.22, metalness: 0.15,
        emissive: new THREE.Color(SC.trainColor(frac)).multiplyScalar(0.18) });
      const wim = new THREE.InstancedMesh(wgeo, wmat, list.length);

      list.forEach((t, i) => {
        const h = Math.max(t.h * ST.vExag, 0.4);
        const wh = h * 0.86;
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(t.x, h / 2 + 2 * ST.vExag, t.z);
        if (t.type === 'cyl') dummy.scale.set(t.r, h, t.r);
        else dummy.scale.set(t.L, h, t.W);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        dummy.position.set(t.x, wh / 2 + 2 * ST.vExag, t.z);
        if (t.type === 'cyl') dummy.scale.set(t.r * 0.94, wh, t.r * 0.94);
        else dummy.scale.set(t.L * 0.94, wh, t.W * 0.94);
        dummy.updateMatrix();
        wim.setMatrixAt(i, dummy.matrix);
      });
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
      wim.instanceMatrix.needsUpdate = true; wim.frustumCulled = false;
      grp.add(im); grp.add(wim);
      stageMeshes[rid] = im; waterMeshes[rid] = wim;

      const dims = spec.shape === 'cyl'
        ? `${spec.n} ${spec.n === 1 ? 'tank' : 'tanks'}, ${num(spec.dia)} m dia \u00d7 ${num(spec.D)} m deep`
        : spec.shape === 'box'
        ? `${spec.n} ${spec.n === 1 ? 'tank' : 'tanks'}, ${num(spec.L)} \u00d7 ${num(spec.W)} \u00d7 ${num(spec.D)} m`
        : `${spec.acres} acres of surface, ${num(spec.D)} m deep`;
      const srcTag = (spec.src && (spec.src.n === 'doc11' || spec.src.dia === 'doc11')) ? 'doc11'
        : (spec.src && spec.src.n) || 'assumed';
      rows.push([spec.label, dims, srcTag]);
      reg(im, {
        kind: 'tankrow', title: `${f.short} \u2014 ${spec.label}`,
        sub: `${f.name} \u00b7 ${spec.train === 'solids' ? 'solids handling' : 'stage ' + spec.stage + ' of the water train'}`,
        rows: [['Count', `${spec.n}`, (spec.src && spec.src.n) || 'assumed'],
               ['Dimensions', dims, (spec.src && (spec.src.dia || spec.src.L || spec.src.acres)) || 'assumed'],
               ['Depth', `${num(spec.D)} m`, (spec.src && spec.src.D) || 'assumed'],
               ['Arrangement on the site', 'schematic \u2014 the counts and sizes are the sourced part', 'assumed']],
        note: spec.note, doc: f.doc, facId: f.id,
      });

      // stage label, only once you are close enough to read it
      const anchor = spec.train === 'solids'
        ? lay.solids.find(x => x.id === rid) : lay.train[idx];
      if (anchor) {
        const d = document.createElement('div');
        d.className = 'lbl stage' + (spec.train === 'solids' ? ' solids' : '');
        d.innerHTML = `<b>${spec.train === 'solids' ? '' : (spec.stage + '. ')}${esc(spec.label)}</b>` +
                      `<i>${esc(dims)}</i>`;
        const tier = (spec.train === 'solids' ? 3 : (spec.stage % 3));
        const yy = (proto.h * ST.vExag) + 16 + tier * 26;
        const o = new CSS2DObject(d);
        o.position.set(f.x + anchor.x, yy, f.z + anchor.z);
        layerG.labels.add(o);
        labelObjs.push({ o, y: yy, d: 2600, div: d, abs: true });
        stageLabelNodes[f.id] = stageLabelNodes[f.id] || {};
        stageLabelNodes[f.id][rid] = { div: d, spec, dims };
      }
    }

    // --- the process flow line: influent in, through the train, effluent out
    const y = 2 * ST.vExag + 3;
    const linePts = [new THREE.Vector3(lay.inlet.x, y, lay.inlet.z)];
    for (const t of lay.train) linePts.push(new THREE.Vector3(t.x, y, t.z));
    linePts.push(new THREE.Vector3(lay.outlet.x, y, lay.outlet.z));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({ color: 0x6fc3e8, transparent: true, opacity: 0.55 }));
    grp.add(line);
    if (lay.solids.length && lay.solidsTap) {
      const sp = [new THREE.Vector3(lay.solidsTap.x, y, lay.solidsTap.z)];
      for (const t of lay.solids) sp.push(new THREE.Vector3(t.x, y, t.z));
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sp),
        new THREE.LineBasicMaterial({ color: 0xb09050, transparent: true, opacity: 0.5 })));
    }

    // flow animation along the train. Speed is NOT constant: each unit process
    // holds the water for volume / flow, so the particles crawl through the
    // aeration basin and dart along the channels between tanks.
    const N = 90;
    const ppos = new Float32Array(N * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
    const pmat = new THREE.PointsMaterial({ color: 0x9fe3ff, size: 26, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false });
    const pts = new THREE.Points(pg, pmat);
    pts.frustumCulled = false;
    grp.add(pts);
    const cum = [0];
    for (let i = 1; i < linePts.length; i++) cum.push(cum[i - 1] + linePts[i].distanceTo(linePts[i - 1]));

    // --- where the flow leaves untreated when everything upstream is full.
    // These sit at the relief pumping stations, not at the plant: excess never
    // reaches the plant at all, which is the point worth drawing.
    const csoPaths = [];
    for (const c of (f.cso || [])) {
      if (c.x == null) continue;
      const pth = [new THREE.Vector3(lay.inlet.x, y, lay.inlet.z),
                   new THREE.Vector3(c.x - f.x, y, c.z - f.z)];
      if (c.ox != null) pth.push(new THREE.Vector3(c.ox - f.x, y, c.oz - f.z));
      const lm = new THREE.LineDashedMaterial({ color: 0xd64545, dashSize: 260, gapSize: 170,
        transparent: true, opacity: 0.5 });
      const lg = new THREE.BufferGeometry().setFromPoints(pth);
      const ln = new THREE.Line(lg, lm);
      ln.computeLineDistances();
      grp.add(ln);
      const marker = new THREE.Mesh(new THREE.ConeGeometry(120, 260, 7),
        new THREE.MeshStandardMaterial({ color: 0xd64545, emissive: 0x4a1010 }));
      const last = pth[pth.length - 1];
      marker.position.set(last.x, 130, last.z);
      marker.rotation.x = Math.PI;
      grp.add(marker);
      reg(marker, {
        kind: 'cso', title: `${f.short} \u2014 ${c.outfall}`,
        sub: 'combined sewer overflow discharge point',
        rows: [['Discharges to', c.water, c.s],
               ['Structure', c.oloc || (D.facilities.find(x => x.id === c.at) || {}).name || '\u2014', 'gis'],
               ['Opens when', 'the interceptors, the tunnel and the reservoir are all at their limit', 'derived']],
        note: c.note || 'Excess never reaches the plant. It is held back in the collection ' +
                        'system, goes down the drop shafts into the Deep Tunnel, and only once ' +
                        'the tunnel and its reservoir are full does it leave here, untreated.',
        doc: f.doc, facId: f.id,
      });
      const CN = 34;
      const cpos = new Float32Array(CN * 3);
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
      const cmat = new THREE.PointsMaterial({ color: 0xff8b6b, size: 330, sizeAttenuation: true,
        transparent: true, opacity: 0, depthWrite: false });
      const cpts = new THREE.Points(cg, cmat);
      cpts.frustumCulled = false;
      grp.add(cpts);
      const ccum = [0];
      for (let i = 1; i < pth.length; i++) ccum.push(ccum[i - 1] + pth[i].distanceTo(pth[i - 1]));
      const cprog = new Float32Array(CN);
      for (let i = 0; i < CN; i++) cprog[i] = i / CN;
      csoPaths.push({ pth, ccum, cpts, cpos, cmat, cprog, CN, marker, line: ln, spec: c });
    }

    // live flow readout over the plant
    const gauge = document.createElement('div');
    gauge.className = 'lbl plant gauge3d';
    const gObj = new CSS2DObject(gauge);
    gObj.position.set(f.x, 60, f.z);
    layerG.labels.add(gObj);
    labelObjs.push({ o: gObj, y: 60, d: f.spec.dmf.v >= 400 ? 30000 : 14000, div: gauge });

    for (const x of (f.extras || [])) rows.push([x.label, x.v, x.s]);
    layerG.plants.add(grp);
    reg(pad, {
      kind: 'plant', title: f.name,
      sub: `Water reclamation plant \u00b7 ${lay.train.length}-stage train` +
           (g.trainSourced ? ' (sequence sourced, tank sizes assumed)' : ''),
      rows, note: f.note, doc: f.doc, facId: f.id });
    plantObjects[f.id] = { f, grp, pad, lay, pts, ppos, pmat, N,
                           linePts, cum, prog: new Float32Array(N).map((_, i) => i / N),
                           gauge, gObj, waterMeshes, budget: null, stageLabels: {}, csoPaths };
    if (f.spec.dmf.v >= 400) addLabel(f.short, f.x, f.z, 30, 'plant', 46000);
    else addLabel(f.short, f.x, f.z, 30, 'plant', 17000);
  }
}

function buildPumps() {
  layerG.pumps.clear();
  for (const f of D.facilities) {
    if (f.kind !== 'tarp-ps' && f.kind !== 'sewage-ps') continue;
    const g = f.geom;
    const grp = new THREE.Group();
    grp.position.set(f.x, 0, f.z);
    const hall = new THREE.Mesh(
      new THREE.BoxGeometry(g.hallL, g.hallH * ST.vExag, g.hallW), M.bldg);
    hall.position.y = g.hallH * ST.vExag / 2;
    grp.add(hall);
    const rows = [];
    for (const [k, lbl] of [['pumps', 'Pumps'], ['capMGD', 'Capacity'], ['capCFS', 'Capacity'],
                            ['hp', 'Largest motor'], ['liftFt', 'Lift'], ['shaftDepthFt', 'Shaft depth'],
                            ['riserFt', 'Riser / force main'], ['areaSqMi', 'Interceptor area'],
                            ['stormPumpFt', 'Storm pump discharge'], ['dryPumpFt', 'Dry-weather pump discharge'],
                            ['screwFt', 'Screw propeller'], ['bldgSqFt', 'Building']]) {
      const v = f.spec[k];
      if (v) rows.push([lbl, `${num(v.v)} ${v.u}${v.n ? '' : ''}`, v.s, v.n]);
    }
    // pumps in a row inside the hall
    const n = Math.min(g.n || 4, 16);
    const pg = new THREE.CylinderGeometry(1, 1, 1, 16);
    const im = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({
      color: 0xe0b050, roughness: 0.4, metalness: 0.5 }), n);
    const dummy = new THREE.Object3D();
    const pr = Math.max(g.pumpDia / 2, 1.2) * ST.dExag * 0.5;
    for (let i = 0; i < n; i++) {
      const h = g.hallH * 0.7 * ST.vExag;
      dummy.position.set(-g.hallL / 2 + g.hallL * (i + 0.5) / n, h / 2, 0);
      dummy.scale.set(pr, h, pr);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
    grp.add(im);
    // shaft + riser down to the tunnel
    if (g.shaftM > 1) {
      const d = g.shaftM * ST.vExag;
      const sh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 14, 1, true), M.shaft);
      const sr = Math.max(g.riserM, 2) * ST.dExag * 1.4;
      sh.position.y = -d / 2; sh.scale.set(sr, d, sr);
      grp.add(sh);
      const riser = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12),
        new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.4, metalness: 0.5 }));
      riser.position.set(sr * 0.9, -d / 2, 0);
      riser.scale.set(g.riserM / 2 * ST.dExag, d, g.riserM / 2 * ST.dExag);
      grp.add(riser);
      const RN = 26;
      const rpos = new Float32Array(RN * 3);
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
      const rmat = new THREE.PointsMaterial({ color: 0xffd98a, size: 240, sizeAttenuation: true,
        transparent: true, opacity: 0, depthWrite: false });
      const rpts = new THREE.Points(rg, rmat);
      rpts.frustumCulled = false;
      grp.add(rpts);
      const rprog = new Float32Array(RN);
      for (let i = 0; i < RN; i++) rprog[i] = i / RN;
      pumpObjects[f.id] = { f, grp, riser, shaft: sh, rpts, rpos, rmat, rprog, RN,
                            riserX: sr * 0.9, riserR: g.riserM / 2, depth: d };
    } else pumpObjects[f.id] = { f, grp };
    layerG.pumps.add(grp);
    if (f.kind === 'tarp-ps' && f.system) {
      const tg = document.createElement('div');
      tg.className = 'lbl tun gauge3d';
      const tObj = new CSS2DObject(tg);
      tObj.position.set(f.x, 92, f.z);
      layerG.labels.add(tObj);
      labelObjs.push({ o: tObj, y: 92, d: 34000, div: tg });
      pumpObjects[f.id].gauge = tg;
      pumpObjects[f.id].gObj = tObj;
      pumpObjects[f.id].sid = f.system;
    }
    reg(hall, { kind: 'pump', title: f.name, sub: f.kind === 'tarp-ps' ? 'TARP dewatering pumping station' : 'MWRD sewage pumping station',
                rows, note: f.note, doc: f.doc, facId: f.id, conflict: f.conflict });
    addLabel(f.short, f.x, f.z, 22, 'pump', f.kind === 'tarp-ps' ? 46000 : 15000);
  }
}

let groundMesh = null, gridMesh = null;
function buildGround() {
  const box = new THREE.Box3();
  for (const t of D.tunnels) for (const p of t.corridor) box.expandByPoint(new THREE.Vector3(p[0], 0, p[1]));
  for (const f of D.facilities) box.expandByPoint(new THREE.Vector3(f.x, 0, f.z));
  const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
  const span = Math.max(sz.x, sz.z) * 1.45;
  const g = new THREE.PlaneGeometry(span, span);
  g.rotateX(-Math.PI / 2);
  groundMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: dark ? 0x222a34 : 0xc4cedb, roughness: 1,
    transparent: true, opacity: 0.30, depthWrite: false, side: THREE.DoubleSide }));
  groundMesh.position.set(c.x, 0, c.z);
  groundMesh.renderOrder = -3;
  world.add(groundMesh);
  gridMesh = new THREE.GridHelper(span, Math.round(span / 1609.344), dark ? 0x2e3a47 : 0xaab5c2,
                                  dark ? 0x232c36 : 0xbcc6d1);
  gridMesh.position.set(c.x, 1, c.z);
  gridMesh.material.transparent = true; gridMesh.material.opacity = 0.42;
  world.add(gridMesh);
  world.userData.center = c; world.userData.span = span;
}

function buildSurface() {
  layerG.waterways.clear(); layerG.basins.clear(); layerG.outfalls.clear();
  for (const w of D.waterways) {
    if (w.pts.length < 2) continue;
    const m = new THREE.Mesh(SC.ribbon(w.pts, 140, 6), M.river);
    layerG.waterways.add(m);
  }
  for (const b of D.basins) {
    for (const g of SC.polyShape(b.outline, 2)) {
      const mm = M.basin.clone();
      mm.color = new THREE.Color(b.color);
      mm.opacity = 0.13;
      const m = new THREE.Mesh(g, mm);
      layerG.basins.add(m);
      reg(m, { kind: 'basin', title: b.name, sub: 'MWRD combined sewer area',
               rows: [['Combined sewer area', `${b.areaSqMi.v} sq mi`, b.areaSqMi.s],
                      ['Treatment plant', (D.facilities.find(f => f.id === b.plant) || {}).name || b.plant, 'gis'],
                      ['TARP systems', b.systems.map(s => D.systems[s].name).join(', ') || 'none', 'doc09']],
               note: 'Geodesic area of MWRD’s own Combined Sewer Area polygons. The five basins total 311 sq mi against the ~360 sq mi MWRD quotes publicly.', doc: 'doc14' });
    }
  }
  const og = new THREE.ConeGeometry(1, 1, 6);
  const im = new THREE.InstancedMesh(og, M.outfall, D.outfalls.length);
  const dummy = new THREE.Object3D();
  D.outfalls.forEach((o, i) => {
    dummy.position.set(o[0], 120, o[1]);
    dummy.scale.set(180, 260, 180);
    dummy.rotation.set(Math.PI, 0, 0);
    dummy.updateMatrix();
    im.setMatrixAt(i, dummy.matrix);
  });
  im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
  layerG.outfalls.add(im);
  reg(im, { kind: 'outfalls', title: 'CSO outfalls', sub: 'MWRD CSO_Points layer',
            rows: [['Outfalls in layer', `${D.outfalls.length}`, 'gis'],
                   ['City-owned outfalls under NPDES IL0045012', '184', 'doc06']],
            note: 'Every point where the combined system can discharge to a waterway when the tunnels and reservoirs are full.', doc: 'doc14' });
}

function addLabel(text, x, z, y, cls, maxDist) {
  const d = document.createElement('div');
  d.className = 'lbl ' + (cls || '');
  d.textContent = text;
  const o = new CSS2DObject(d);
  o.position.set(x, y, z);
  layerG.labels.add(o);
  labelObjs.push({ o, y, d: maxDist || 1e9, div: d });
}

/* --------------------------------------------------------- flow particles */
/* One particle stream PER TUNNEL FEATURE. Concatenating a system's features
 * into a single path made particles leap between the end of one leg and the
 * start of the next -- up to 29 km of straight line across the map, following
 * nothing. Branches converge, they are not a single chain, so each feature
 * carries its own stream and its own flow share. */
function buildParticles() {
  layerG.particles.clear();
  for (const k of Object.keys(particles)) delete particles[k];
  for (const f of D.tunnels) {
    const p2 = pts2(f);
    if (p2.length < 2) continue;
    const path = p2.map((q, i) => [q[0], -f.depth[i] * FT, q[1]]);
    const cum = [0];
    for (let i = 1; i < path.length; i++)
      cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][2] - path[i - 1][2]));
    const len = cum[cum.length - 1];
    if (len < 200) continue;
    const N = Math.max(24, Math.min(220, Math.round(len / 420)));
    const pos = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pmat = new THREE.PointsMaterial({ color: SC.COL.waterHi, size: 380, sizeAttenuation: true,
      transparent: true, opacity: 0, depthWrite: false });
    const pts = new THREE.Points(g, pmat);
    pts.frustumCulled = false;
    layerG.particles.add(pts);
    const prog = new Float32Array(N);
    for (let i = 0; i < N; i++) prog[i] = i / N;
    const cd = conduits.find(c => c.feat.id === f.id);
    particles[f.id] = { pts, pos, path, cum, prog, N, mat: pmat, sid: f.system, len,
                        conduit: cd ? cd.c : null, vAt: new Float32Array(N) };
  }
}

/* ==================================================== exaggeration update */
function applyScale() {
  for (const { c, w } of conduits) { c.update(ST.vExag, ST.dExag); }
  positionShafts();
  // reservoirs / plants / pumps carry vertical exaggeration in their geometry
  applyBuildOut();
  rebuildPlants();
  rebuildPumps();
  for (const l of labelObjs) if (!l.abs) l.o.position.y = l.y * Math.max(1, ST.vExag / 8);
  ST.needLevels = true;
  applyFrame(true);
  $('#exagbadge').innerHTML = ST.vExag === 1 && ST.dExag === 1
    ? '<b>1:1 true scale</b> — nothing exaggerated'
    : `vertical <b>×${ST.vExag}</b> · conduit width <b>×${ST.dExag}</b>`;
  $('#exagbadge').classList.toggle('true', ST.vExag === 1 && ST.dExag === 1);
}

function rebuildPlants() {
  layerG.plants.clear(); labelObjs.length = 0; layerG.labels.clear();
  for (const k of Object.keys(plantObjects)) delete plantObjects[k];
  buildPlants();
}
function rebuildPumps() {
  layerG.pumps.clear();
  for (const k of Object.keys(pumpObjects)) delete pumpObjects[k];
  buildPumps();
}

/* ============================================================== simulation */
const model = new SewerModel(D);

/** Draw each reservoir at the size actually excavated in the selected
 *  build-out state: McCook Stage 1 is a 3.5 BG hole, not a 10 BG hole that
 *  happens to be 35% full. Depth is fixed by the source, so the plan
 *  dimensions carry the difference. */
function applyBuildOut() {
  if (!ST.run) return;
  const f0 = ST.run.frames[0];
  for (const [rid, r] of Object.entries(resObjects)) {
    const cap = f0.reservoirs[rid] ? f0.reservoirs[rid].capMG : 0;
    const full = r.f.spec.capFullMG.v;
    // Thornton's TARP share is 4.8 of its 7.9 BG; the hole is the full size
    const built = rid === 'res-thornton' ? full : (cap > 0 ? cap : r.f.spec.capMG.v);
    const k = Math.sqrt(Math.max(0.08, built / full));
    r.k = k;
    r.builtMG = built;
    r.pit.geometry.dispose();
    r.pit.geometry = SC.frustumGeometry(r.f.geom.L * k, r.f.geom.W * k,
                                        r.f.geom.D * ST.vExag, r.f.geom.insetM * k, r.bench);
    r.grp.visible = cap > 0 || (r.f.retired && ST.storm.config === 'r2015');
    if (r.rim) {
      const L = r.f.geom.L * k / 2, W = r.f.geom.W * k / 2;
      r.rim.geometry.dispose();
      r.rim.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-L, 0, -W), new THREE.Vector3(L, 0, -W),
        new THREE.Vector3(L, 0, W), new THREE.Vector3(-L, 0, W), new THREE.Vector3(-L, 0, -W)]);
    }
  }
}

function runSim() {
  ST.run = model.run(ST.storm);
  ST.frame = 0;
  $('#scrub').max = ST.run.frames.length - 1;
  $('#scrub').value = 0;
  applyBuildOut();
  drawChart();
  renderSummary();
  applyFrame(true);
}

function applyFrame(force) {
  if (!ST.run) return;
  const f = ST.run.frames[Math.min(ST.frame, ST.run.frames.length - 1)];
  // tunnel water: solve the level surface that holds the modelled volume
  for (const [sid, cs] of Object.entries(sysConduits)) {
    const s = f.systems[sid];
    const frac = s && s.capMG > 0 ? Math.max(0, Math.min(1, s.volMG / s.capMG)) : 0;
    const volM3 = frac * sysGeomVol[sid];
    const level = SC.solveLevel(cs, volM3);
    for (const cd of conduits) {
      if (cd.sid !== sid) continue;
      cd.w.update(level, ST.vExag, ST.dExag);
      cd.wm.visible = frac > 0.0008;
      const ps = particles[cd.feat.id];
      if (ps) ps.level = level;
    }
  }
  // reservoirs
  for (const [rid, r] of Object.entries(resObjects)) {
    const s = f.reservoirs[rid];
    // fill the drawn solid by VOLUME against what that solid actually holds,
    // so Thornton at its full 4.8 BG CSO allocation correctly fills only the
    // TARP share of a 7.9 BG hole
    const holds = (r.f.geom.geomMG) * (r.k * r.k);
    const frac = holds > 0 && s ? Math.max(0, Math.min(1, s.volMG / holds)) : 0;
    if (r.water) { r.grp.remove(r.water); r.water.geometry.dispose(); r.water = null; }
    if (r.waterline) { r.grp.remove(r.waterline); r.waterline.geometry.dispose(); r.waterline = null; }
    const g = SC.frustumWaterGeometry(r.f.geom.L * r.k, r.f.geom.W * r.k,
                                      r.f.geom.D * ST.vExag, r.f.geom.insetM * r.k, frac);
    if (g) {
      r.water = new THREE.Mesh(g, M.resWater);
      r.water.renderOrder = 1;
      r.grp.add(r.water);
      // a bright rim exactly at the surface, so the level reads as a level
      const y = g.userData.surfaceY;
      const D = r.f.geom.D * ST.vExag;
      const t = (y + D) / (D || 1);                       // 0 at the floor, 1 at the rim
      const hx = r.f.geom.L * r.k / 2, hz = r.f.geom.W * r.k / 2;
      const inset = r.f.geom.insetM * r.k;
      const ix = Math.max(1, hx - inset), iz = Math.max(1, hz - inset);
      const wx = ix + (hx - ix) * t, wz = iz + (hz - iz) * t;
      r.waterline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-wx, y, -wz), new THREE.Vector3(wx, y, -wz),
        new THREE.Vector3(wx, y, wz), new THREE.Vector3(-wx, y, wz),
        new THREE.Vector3(-wx, y, -wz)]),
        new THREE.LineBasicMaterial({ color: frac > 0.995 ? 0xff9a6b : 0x8ad8ff }));
      r.waterline.renderOrder = 2;
      r.grp.add(r.waterline);
    }
    if (r.gauge) {
      // the gauge reports fill against the TARP allocation the model tracks;
      // the drawn water fills the solid by volume, which for Thornton is the
      // 4.8 BG CSO share of a 7.9 BG hole
      const capMG = s ? s.capMG : 0;
      const pct = capMG > 0 ? Math.max(0, Math.min(1, s.volMG / capMG)) : 0;
      const off = capMG === 0;
      r.gObj.visible = !!r.grp.visible;
      r.gauge.classList.toggle('full', pct > 0.995);
      r.gauge.classList.toggle('off', off);
      r.gauge.innerHTML = off
        ? `<b>${esc(r.f.short)}</b><i>not built yet</i>`
        : `<b>${esc(r.f.short)}</b>
           <span class="bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></span>
           <span class="pct">${(pct * 100).toFixed(0)}%</span>
           <i>${num(s.volMG)} / ${num(capMG)} MG</i>`;
    }
  }
  for (const po of Object.values(plantObjects)) {
    const st = f.plants[po.f.id];
    if (!st) continue;
    po.rate = st.flow;
    po.budget = SC.plantTimeBudget(po.lay.train, Math.max(st.flow, 0.1),
                                   po.lay.inlet, po.lay.outlet);
    const bas = po.f.basin ? f.basins[po.f.basin] : null;
    const csoRate = bas ? (bas.cso || 0) : 0;
    po.csoRate = csoRate;
    for (const cp of (po.csoPaths || [])) {
      const on = csoRate > 1;
      cp.cmat.opacity = on ? 0.95 : 0;
      cp.line.material.opacity = on ? 0.95 : 0.22;
      cp.marker.material.emissiveIntensity = on ? 1.4 : 0.15;
      cp.marker.scale.setScalar(on ? 1.6 : 1);
      // Split the basin's discharge across its outfalls in proportion to what
      // each station is rated to pass, not evenly -- Outfall 150's 129 MGD
      // station cannot take the same share as Bubbly Creek's 3,878 MGD one.
      const totalRated = (po.csoPaths || []).reduce((a, x) => a + (x.spec.ratedMGD || 200), 0) || 1;
      const share = csoRate * ((cp.spec.ratedMGD || 200) / totalRated);
      cp.share = share;
      cp.over = cp.spec.ratedMGD ? share > cp.spec.ratedMGD : false;
      // A conduit cannot pass more than it can pass. Once the share exceeds the
      // station's rating the velocity stops rising and the surplus surcharges
      // back up the collection system instead -- which is what puts water in
      // basements.
      const passed = cp.spec.ratedMGD ? Math.min(share, cp.spec.ratedMGD) : share;
      cp.passed = passed;
      cp.backup = Math.max(0, share - passed);
      cp.v = on ? SC.conduitVelocity(passed, cp.spec.areaM2 || 14) : 0;
    }
    const labs = stageLabelNodes[po.f.id] || {};
    for (const seg of po.budget.segs) {
      if (seg.kind !== 'dwell') continue;
      const L = labs[seg.id];
      if (!L) continue;
      L.div.innerHTML = `<b>${L.spec.train === 'solids' ? '' : (L.spec.stage + '. ')}${esc(L.spec.label)}</b>` +
        `<i>${esc(L.dims)}</i>` +
        `<i class="hrt">holds it ${fmtDur(seg.hrt)} \u00b7 ${(seg.v * 3.281).toFixed(2)} ft/s</i>`;
    }
    const pct = Math.max(0, Math.min(1, st.flow / st.dmf));
    po.pmat.opacity = Math.min(0.9, 0.12 + pct * 0.8);
    if (po.gauge) {
      po.gauge.classList.toggle('full', pct > 0.995);
      po.gauge.innerHTML = `<b>${esc(po.f.short)} WRP</b>
        <span class="bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></span>
        <span class="pct">${(pct * 100).toFixed(0)}%</span>
        <i>${num(st.flow)} / ${num(st.dmf)} MGD</i>`;
    }
  }
  for (const po of Object.values(pumpObjects)) {
    if (po.rpts) {
      const sysIds = Object.keys(D.systems).filter(sid => D.systems[sid].pump === po.f.id);
      const q = sysIds.reduce((a, sid) => a + f.systems[sid].pumped, 0);
      po.pumped = q;
      // velocity up the force main is flow over the riser's own area
      const A = Math.PI * po.riserR * po.riserR;
      po.riserV = SC.conduitVelocity(q, A);
      po.rmat.opacity = q > 1 ? 0.9 : 0;
    }
    if (!po.gauge) continue;
    const sysIds = Object.keys(D.systems).filter(sid => D.systems[sid].pump === po.f.id);
    let vol = 0, cap = 0;
    for (const sid of sysIds) { vol += f.systems[sid].volMG; cap += f.systems[sid].capMG; }
    const pct = cap > 0 ? Math.max(0, Math.min(1, vol / cap)) : 0;
    po.gObj.visible = cap > 0;
    po.gauge.classList.toggle('full', pct > 0.995);
    po.gauge.innerHTML = `<b>${esc(sysIds.map(x => D.systems[x].name.replace(/ Tunnel System.*/, '')).join(' + '))} tunnel</b>
      <span class="bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></span>
      <span class="pct">${(pct * 100).toFixed(0)}%</span>
      <i>${num(vol)} / ${num(cap)} MG</i>`;
  }
  // drop-shaft water columns: plunge depth scales with the system's inflow
  const dummy = new THREE.Object3D();
  for (const set of shaftSets) {
    if (!set.sid || !set.wmesh) continue;
    const s = f.systems[set.sid];
    const inflow = s ? s.inflow : 0;
    const drive = Math.max(0, Math.min(1, inflow / 3000));
    set.items.forEach((sh, i) => {
      const d = sh._y || 1;
      const h = Math.max(d * drive, 1e-3);
      const r = (10 * FT) / 2 * ST.dExag * 0.62;
      dummy.position.set(sh.x, -d + h / 2, sh.z);
      dummy.scale.set(r, h, r);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      set.wmesh.setMatrixAt(i, dummy.matrix);
    });
    set.wmesh.instanceMatrix.needsUpdate = true;
    set.wmesh.visible = drive > 0.004;
    if (set.plunge) { set.plunge.mat.opacity = Math.min(0.9, drive * 1.5); set.plunge.drive = drive; }
  }
  // particle intensity, per feature, from its own system's flow
  for (const p of Object.values(particles)) {
    const s = f.systems[p.sid];
    const q = s ? Math.max(s.inflow, s.pumped) : 0;
    p.mat.opacity = Math.min(0.85, q / 900);
    p.rate = q;
  }
  renderReadout(f);
}

/* ================================================================== UI */
function srcChip(tag, note) {
  const s = D.sources[tag] || D.sources[(tag || '').split(':')[0]];
  const cls = tag === 'assumed' ? 'assumed' : tag === 'derived' ? 'derived' : 'sourced';
  const t = s ? s[0] : tag;
  return `<span class="chip ${cls}" title="${esc(t)}${note ? ' — ' + esc(note) : ''}">${esc(tag)}</span>`;
}

function inspect(rec) {
  ST.selected = rec;
  const p = $('#inspector');
  if (!rec) { p.classList.add('empty'); p.innerHTML = '<p class="hint">Click any tunnel, shaft, tank, pump house or reservoir to see its real dimensions and where they come from.</p>'; return; }
  p.classList.remove('empty');
  let h = `<h3>${esc(rec.title)}</h3>`;
  if (rec.sub) h += `<div class="sub">${esc(rec.sub)}</div>`;
  if (rec.conflict) h += `<div class="conflict"><b>Source conflict.</b> ${esc(rec.conflict)}</div>`;
  if (rec.rows && rec.rows.length) {
    h += '<table class="spec">';
    for (const [k, v, s, n] of rec.rows)
      h += `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'function' ? v() : v)} ${srcChip(s, n)}</td></tr>`;
    h += '</table>';
  }
  if (rec.note) h += `<p class="note">${esc(rec.note)}</p>`;
  if (rec.doc && D.sources[rec.doc] && D.sources[rec.doc][1])
    h += `<p><a href="${D.sources[rec.doc][1]}">${esc(D.sources[rec.doc][0])} →</a></p>`;
  if (rec.facId) h += `<p><button class="mini" data-focus="${esc(rec.facId)}">Fly here at true 1:1 scale</button></p>`;
  p.innerHTML = h;
}

function renderReadout(f) {
  const hrs = f.t;
  $('#clock').textContent = `${Math.floor(hrs)}h ${String(Math.round((hrs % 1) * 60)).padStart(2, '0')}m`;
  $('#rainrate').textContent = f.inHr > 0.001 ? `${f.inHr.toFixed(2)} in/hr` : 'dry';
  const g = $('#gauges');
  let h = '';
  for (const [sid, s] of Object.entries(f.systems)) {
    const sys = D.systems[sid];
    if (s.capMG === 0) continue;
    h += gaugeRow(sys.name, s.volMG, s.capMG, sys.color, 'MG');
  }
  for (const [rid, r] of Object.entries(f.reservoirs)) {
    if (r.capMG === 0) continue;
    const fac = D.facilities.find(x => x.id === rid);
    h += gaugeRow(fac ? fac.short + ' Reservoir' : rid, r.volMG, r.capMG, '#5aa0c8', 'MG');
  }
  h += '<div class="gsep"></div>';
  for (const [pid, p] of Object.entries(f.plants)) {
    if (p.dmf < 50) continue;
    const fac = D.facilities.find(x => x.id === pid);
    h += gaugeRow((fac ? fac.short : pid) + ' WRP', p.flow, p.dmf, p.util > 0.99 ? '#d64545' : '#2c9a8f', 'MGD');
  }
  g.innerHTML = h;
  const cso = $('#csobox');
  cso.classList.toggle('active', f.csoRate > 1);
  cso.innerHTML = `<div class="k">Combined sewer overflow</div>
    <div class="v">${num(f.csoCum)} <span>MG discharged</span></div>
    <div class="r">${f.csoRate > 1 ? `discharging now at ${num(f.csoRate)} MGD` : 'no overflow'}</div>
    <div class="r">pumped back for treatment: ${num(f.pumpedRate)} MGD</div>`;
}

function gaugeRow(name, v, cap, color, unit) {
  const pct = cap > 0 ? Math.max(0, Math.min(1, v / cap)) : 0;
  const full = pct > 0.995;
  return `<div class="gauge${full ? ' full' : ''}">
    <div class="gl"><span>${esc(name)}</span><b>${(pct * 100).toFixed(0)}%</b></div>
    <div class="gb"><i style="width:${(pct * 100).toFixed(1)}%;background:${color}"></i></div>
    <div class="gv">${num(v)} / ${num(cap)} ${unit}</div></div>`;
}

function renderSummary() {
  const s = ST.run.summary, c = ST.run.config;
  const ev = D.sim.events;
  let val = '';
  if (Math.abs(ST.storm.inches - 6.64) < 0.01 && ST.storm.config === 'tunnels') {
    const rec = ev.find(e => e.date === '2008-09-13');
    if (rec) {
      const four = ['ps-north-branch', 'ps-racine', 'ps-westchester', 'ps-125th']
        .reduce((a, k) => a + (s.csoByStation[k] || 0), 0);
      val = `<div class="valid"><b>Against the record.</b> MWRD logged
        ${rec.totalMG.toLocaleString()} MG of discharge across four pumping stations on 13 Sept 2008.
        This model puts those same four at <b>${num(four)} MG</b>. The runoff coefficient (0.32)
        was chosen to make that comparison line up — it is the model’s one calibrated parameter.</div>`;
    }
  }
  $('#summary').innerHTML = `
    <div class="srow"><span>Rain on the combined sewer area</span><b>${num(s.rainVolMG)} MG</b></div>
    <div class="srow"><span>More than the plants could take</span><b>${num(s.excessMG)} MG</b></div>
    <div class="srow"><span>Captured by tunnels + reservoirs</span><b>${s.capturePct.toFixed(1)}%</b></div>
    <div class="srow${s.csoMG > 1 ? ' bad' : ''}"><span>Discharged to the rivers</span><b>${num(s.csoMG)} MG</b></div>
    <div class="srow"><span>Storage empty again after</span><b>${s.emptyHr != null ? (s.emptyHr < 48 ? s.emptyHr.toFixed(0) + ' h' : (s.emptyHr / 24).toFixed(1) + ' days') : 'still holding at ' + (ST.run.totalHr / 24).toFixed(0) + ' days'}</b></div>
    ${bottleneck(s)}
    <div class="cfgnote">${esc(c.note)}</div>${val}`;
}

/* ------------------------------------------------------------- the chart */
function fmtDur(sec) {
  if (!isFinite(sec) || sec <= 0) return '\u2014';
  if (sec < 90) return `${sec.toFixed(0)} s`;
  if (sec < 5400) return `${(sec / 60).toFixed(0)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function bottleneck(s) {
  let slow = Object.entries(s.boundBy || {}).filter(([sid, b]) => b === 'plant' &&
    ST.run.frames[0].systems[sid].capMG > 0);
  if (!slow.length) return '';
  slow.sort((a, b) => {
    const r = sid => (D.sim.plants[D.systems[sid].plant].dmf - D.sim.plants[D.systems[sid].plant].avg)
      / D.sim.pumps[D.systems[sid].pump].capMGD;
    return r(a[0]) - r(b[0]);
  });
  slow = slow.slice(0, 2);
  const names = slow.map(([sid]) => {
    const sys = D.systems[sid], plant = D.facilities.find(f => f.id === sys.plant);
    const p = D.sim.plants[sys.plant];
    return `${sys.name} (${plant ? plant.short : ''} has ${num(p.dmf - p.avg)} MGD spare against
      ${num(D.sim.pumps[sys.pump].capMGD)} MGD of pumps)`;
  });
  return `<div class="cfgnote"><b>What sets the drawdown rate.</b> Emptying the tunnel is limited by the
    receiving plant, not the pumps, for: ${names.join('; ')}. Switch "dewatering limited by" to pump
    nameplate to see the difference.</div>`;
}

function drawChart() {
  const cv = $('#chart'), ctx = cv.getContext('2d');
  const w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio;
  if (w < 20 || h < 8) return;
  cv.width = w; cv.height = h;
  ctx.clearRect(0, 0, w, h);
  const F = ST.run.frames;
  const maxT = F[F.length - 1].t;
  const x = t => (t / maxT) * w;
  // rainfall band
  const maxI = Math.max(0.01, ...F.map(f => f.inHr));
  ctx.fillStyle = 'rgba(90,150,200,.25)';
  ctx.beginPath(); ctx.moveTo(0, 0);
  for (const f of F) ctx.lineTo(x(f.t), (f.inHr / maxI) * h * 0.30);
  ctx.lineTo(w, 0); ctx.closePath(); ctx.fill();
  // storage fill curves
  const series = [];
  for (const [sid, s] of Object.entries(D.systems))
    if (ST.run.frames[0].systems[sid].capMG > 0)
      series.push([s.color, f => f.systems[sid].fill]);
  for (const rid of Object.keys(D.sim.reservoirs))
    if (ST.run.frames[0].reservoirs[rid].capMG > 0)
      series.push(['#5aa0c8', f => f.reservoirs[rid].fill]);
  ctx.lineWidth = 2 * devicePixelRatio;
  for (const [col, fn] of series) {
    ctx.strokeStyle = col; ctx.beginPath();
    F.forEach((f, i) => { const y = h - fn(f) * h * 0.92; i ? ctx.lineTo(x(f.t), y) : ctx.moveTo(x(f.t), y); });
    ctx.stroke();
  }
  // CSO
  const maxC = Math.max(1, ...F.map(f => f.csoCum));
  ctx.strokeStyle = '#d64545'; ctx.lineWidth = 2.4 * devicePixelRatio;
  ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
  ctx.beginPath();
  F.forEach((f, i) => { const y = h - (f.csoCum / maxC) * h * 0.92; i ? ctx.lineTo(x(f.t), y) : ctx.moveTo(x(f.t), y); });
  ctx.stroke(); ctx.setLineDash([]);
  $('#chartmax').textContent = maxC > 1 ? `CSO peak ${num(maxC)} MG` : 'no CSO';
}

function drawPlayhead() {
  const cv = $('#playhead'), ctx = cv.getContext('2d');
  const w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio;
  if (w < 20 || h < 8 || !ST.run) return;
  cv.width = w; cv.height = h;
  ctx.clearRect(0, 0, w, h);
  const f = ST.run.frames[ST.frame];
  const maxT = ST.run.frames[ST.run.frames.length - 1].t;
  const x = (f.t / maxT) * w;
  ctx.strokeStyle = dark ? '#e8eef5' : '#1a202c';
  ctx.lineWidth = 1.5 * devicePixelRatio;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
}

/* ------------------------------------------------------- size comparison */
function drawLadder() {
  const cv = $('#ladder'), ctx = cv.getContext('2d');
  const w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio;
  if (w < 40 || h < 40) return;                // pane not laid out yet
  cv.width = w; cv.height = h;
  ctx.clearRect(0, 0, w, h);
  const items = [
    ['4 in', 4 / 12, '#7d8fa5'], ['12 in', 1, '#7d8fa5'], ['36 in', 3, '#7d8fa5'],
    ['78 in', 6.5, '#8fa1b5'], ['17 ft city trunk', 17, '#6f8095'],
    ['27 ft MWRD interceptor', 27, '#b7791f'], ['33 ft Deep Tunnel', 33, '#c98a2e'],
  ];
  const maxFt = 33, pad = 10 * devicePixelRatio;
  const labelRoom = 40 * devicePixelRatio;         // space for the rotated captions
  const scale = (h - pad * 2 - labelRoom) / maxFt;
  let x = pad + 8 * devicePixelRatio;
  ctx.font = `${10 * devicePixelRatio}px -apple-system,system-ui,sans-serif`;
  ctx.textAlign = 'center';
  for (const [lbl, ft, col] of items) {
    const r = ft * scale / 2;
    ctx.beginPath();
    ctx.arc(x + r, h - pad - r, r, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = dark ? '#0d1218' : '#ffffff'; ctx.lineWidth = devicePixelRatio; ctx.stroke();
    ctx.fillStyle = dark ? '#9fb0c2' : '#4a5568';
    ctx.save(); ctx.translate(x + r, h - pad - r * 2 - 6 * devicePixelRatio);
    ctx.rotate(-Math.PI / 2.6); ctx.textAlign = 'left'; ctx.fillText(lbl, 0, 0); ctx.restore();
    ctx.textAlign = 'center';
    x += r * 2 + 14 * devicePixelRatio;
  }
  // 1.8 m person for scale
  const ph = 5.9 * scale;
  ctx.fillStyle = dark ? '#e8eef5' : '#1a202c';
  ctx.beginPath(); ctx.arc(x + 4 * devicePixelRatio, h - pad - ph, ph * 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(x + 2 * devicePixelRatio, h - pad - ph * 0.82, 5 * devicePixelRatio, ph * 0.82);
  ctx.fillStyle = dark ? '#9fb0c2' : '#4a5568';
  ctx.textAlign = 'left';
  ctx.fillText('5 ft 11 in', x - 6 * devicePixelRatio, h - pad + 9 * devicePixelRatio);
}

/* ------------------------------------------------------- fidelity panel */
function renderFidelity() {
  let h = '<table class="fid"><tr><th>Tunnel system</th><th>route drawn</th><th>published</th><th>volume drawn</th><th>published</th></tr>';
  for (const [sid, f] of Object.entries(D.fidelity)) {
    const bad = Math.abs(f.lenDeltaPct) > 15;
    h += `<tr class="${bad ? 'warn' : ''}"><td>${esc(D.systems[sid].name)}</td>
      <td>${f.drawnMi} mi</td><td>${f.sourcedMi} mi <i>(${f.lenDeltaPct >= 0 ? '+' : ''}${f.lenDeltaPct}%)</i></td>
      <td>${num(f.drawnMG)} MG</td><td>${f.sourcedMG.toLocaleString()} MG <i>(${f.volDeltaPct >= 0 ? '+' : ''}${f.volDeltaPct}%)</i></td></tr>`;
  }
  h += '</table>';
  h += '<table class="fid"><tr><th>Reservoir</th><th>solid drawn holds</th><th>published</th><th>solved for</th></tr>';
  for (const f of D.facilities) {
    if (f.kind !== 'reservoir') continue;
    h += `<tr><td>${esc(f.short)}</td><td>${num(f.geom.geomMG)} MG</td>
      <td>${f.geom.sourcedMG.toLocaleString()} MG <i>(${f.geom.deltaPct >= 0 ? '+' : ''}${f.geom.deltaPct}%)</i></td>
      <td>${esc(f.geom.solvedFor)}</td></tr>`;
  }
  h += '</table>';
  if (D.repairs && D.repairs.length) {
    h += '<h4 style="margin-top:14px">Defects repaired in the traced geometry</h4>' +
      '<p class="hint">Each of these showed up in the model as a straight line running across the ' +
      'map, following nothing. They are errors in the corridor tracing, not modelling choices, and ' +
      'the repair is applied in <code>scripts/build_system3d.py</code> where it can be audited.</p><ul>' +
      D.repairs.map(r => `<li>${esc(r)}</li>`).join('') + '</ul>';
  }
  $('#fidelity').innerHTML = h;
  $('#caveats').innerHTML = '<ul>' + D.meta.caveats.map(c => `<li>${esc(c)}</li>`).join('') + '</ul>';
}

/* ================================================================ camera */
function frameAll() {
  const box = new THREE.Box3();
  for (const t of D.tunnels) for (const p of t.corridor) box.expandByPoint(new THREE.Vector3(p[0], 0, p[1]));
  for (const f of D.facilities)
    if (f.kind === 'reservoir' || f.kind === 'tarp-ps' || (f.spec.dmf && f.spec.dmf.v >= 400))
      box.expandByPoint(new THREE.Vector3(f.x, 0, f.z));
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  // distance that just fits the footprint, allowing for the camera's own tilt
  const vFov = camera.fov * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = Math.max(s.x / 2 / Math.tan(hFov / 2), (s.z * 0.62) / 2 / Math.tan(vFov / 2)) * 0.98;
  controls.target.set(c.x, -900, c.z);
  const az = -0.42, el = 0.42;                    // looking from the south-east, tilted down
  camera.position.set(c.x + dist * Math.sin(az) * Math.cos(el),
                      dist * Math.sin(el),
                      c.z + dist * Math.cos(az) * Math.cos(el));
  controls.update();
}

let flying = null;
function flyTo(facId) {
  const f = D.facilities.find(x => x.id === facId);
  if (!f) return;
  const span = f.kind === 'reservoir' ? Math.max(f.geom.L, f.geom.W)
    : f.kind === 'wrp' ? Math.max(f.geom.siteL, f.geom.siteW) : 500;
  setScale(1, 1);
  flying = {
    t0: performance.now(), dur: 900,
    from: camera.position.clone(), tgt0: controls.target.clone(),
    tgt1: new THREE.Vector3(f.x, -span * 0.08, f.z),
    to: new THREE.Vector3(f.x + span * 1.25, span * 1.0, f.z + span * 1.6),
  };
}

function setScale(v, d) {
  ST.vExag = v; ST.dExag = d;
  $('#vexag').value = v; $('#dexag').value = d;
  $('#vexagv').textContent = '×' + v; $('#dexagv').textContent = '×' + d;
  applyScale();
}

/* ================================================================ picking */
const ray = new THREE.Raycaster();
ray.params.Points.threshold = 400;
const mouse = new THREE.Vector2();
let hiMesh = null;

renderer.domElement.addEventListener('pointerdown', e => { mouse.sx = e.clientX; mouse.sy = e.clientY; });
renderer.domElement.addEventListener('pointerup', e => {
  if (Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) > 5) return;
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObjects(pickables.filter(m => {
    let p = m; while (p) { if (p.name && ST.layers[p.name] === 0) return false; p = p.parent; }
    return true;
  }), false);
  if (!hits.length) { inspect(null); clearHi(); return; }
  // the basin sheets and the outfall field blanket everything; prefer a real
  // piece of infrastructure under the cursor when there is one
  const rank = k => (k === 'basin' ? 2 : k === 'outfalls' ? 1 : 0);
  let hit = null, best = 99;
  for (const x of hits) {
    const r = info.get(x.object.uuid);
    if (!r) continue;
    const q = rank(r.kind);
    if (q < best) { best = q; hit = x; }
    if (q === 0) break;
  }
  if (!hit) { inspect(null); clearHi(); return; }
  const rec = info.get(hit.object.uuid);
  if (!rec) return;
  if (rec.kind === 'shaftset') {
    const s = rec.items[hit.instanceId];
    const sys = s.system ? D.systems[s.system] : null;
    inspect({
      kind: 'shaft', title: s.name || s.tc,
      sub: s.system ? `${sys.name} — ${s.kind === 'tide-gate' ? 'tide gate' : 'drop shaft'}`
                    : 'intercepting-sewer connecting structure',
      rows: [
        ['MWRD structure ID', s.tc, 'gis'],
        ['Location', s.loc || '—', 'gis'],
        ['Owner', s.owner || '—', 'gis'],
        ['Receiving water', s.reach || '—', 'gis'],
        ['Outfalls served', String(s.outfalls), 'gis'],
        s.system ? ['Drops to', `${s.depth} ft below grade, into ${num(s.dia)} ft of tunnel`, 'derived'] : null,
        s.system ? ['Shaft diameter', 'drawn at a representative 10 ft', 'assumed'] : null,
        s.dist != null ? ['Offset from the as-traced tunnel corridor', `${s.dist} m`, 'derived'] : null,
      ].filter(Boolean),
      note: s.system
        ? 'A "Chicago style" plunge drop shaft: a split air/water shaft with a vent chamber at the top, engineered from 1975 physical hydraulic-model testing at the St. Anthony Falls Hydraulic Laboratory. MWRD does not publish individual shaft diameters; the sourced range is 4–25 ft.'
        : 'A connecting structure on the intercepting sewers, not a TARP drop shaft.',
      doc: s.system ? 'doc09' : 'doc07',
    });
    highlightInstance(hit.object, hit.instanceId);
    return;
  }
  inspect(rec);
  highlight(hit.object);
});

function clearHi() { if (hiMesh) { world.remove(hiMesh); hiMesh = null; } }
function highlight(m) {
  clearHi();
  const b = new THREE.Box3().setFromObject(m);
  const s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  hiMesh = new THREE.Mesh(new THREE.BoxGeometry(s.x * 1.06 + 60, s.y * 1.06 + 60, s.z * 1.06 + 60), M.hi);
  hiMesh.position.copy(c); world.add(hiMesh);
}
function highlightInstance(im, id) {
  clearHi();
  const m4 = new THREE.Matrix4(); im.getMatrixAt(id, m4);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m4.decompose(p, q, s);
  hiMesh = new THREE.Mesh(new THREE.BoxGeometry(s.x * 4 + 200, s.y * 1.1, s.z * 4 + 200), M.hi);
  hiMesh.position.copy(p); world.add(hiMesh);
}

/* ================================================================== loop */
let last = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;

  if (flying) {
    const k = Math.min(1, (now - flying.t0) / flying.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(flying.from, flying.to, e);
    controls.target.lerpVectors(flying.tgt0, flying.tgt1, e);
    if (k >= 1) flying = null;
  }

  if (ST.playing && ST.run) {
    ST.acc = (ST.acc || 0) + dt * ST.speed;
    const step = Math.floor(ST.acc / ST.run.dtHr);
    if (step > 0) {
      ST.acc -= step * ST.run.dtHr;
      ST.frame = Math.min(ST.frame + step, ST.run.frames.length - 1);
      $('#scrub').value = ST.frame;
      applyFrame();
      if (ST.frame >= ST.run.frames.length - 1) togglePlay(false);
    }
  }
  drawPlayhead();

  // flow particles
  if (ST.layers.particles) {
    for (const p of Object.values(particles)) {
      if (!p.rate) { p.pts.visible = false; continue; }
      p.pts.visible = true;
      const total = p.len || 1;
      for (let i = 0; i < p.N; i++) {
        const d0 = p.prog[i] * total;
        let lo = 0, hi = p.cum.length - 1;
        while (lo < hi - 1) { const m = (lo + hi) >> 1; if (p.cum[m] < d0) lo = m; else hi = m; }
        // velocity here is the real one: flow divided by the wetted area of the
        // bore at this point, so a nearly-empty 33 ft tunnel runs fast and the
        // same tunnel running full runs slow
        let vReal = 1.0;
        if (p.conduit && p.level != null) {
          const A = p.conduit.wetted(Math.min(lo, p.conduit.n - 1), p.level);
          vReal = SC.conduitVelocity(p.rate, A);
        }
        p.vAt[i] = vReal;
        const step = SC.displaySpeed(vReal, FLOW_BASE) * dt / total;
        p.prog[i] = (p.prog[i] + step) % 1;
        const d = p.prog[i] * total;
        lo = 0; hi = p.cum.length - 1;
        while (lo < hi - 1) { const m = (lo + hi) >> 1; if (p.cum[m] < d) lo = m; else hi = m; }
        const seg = (p.cum[hi] - p.cum[lo]) || 1;
        const t = (d - p.cum[lo]) / seg;
        const a = p.path[lo], b = p.path[hi];
        p.pos[i * 3] = a[0] + (b[0] - a[0]) * t;
        p.pos[i * 3 + 1] = (a[1] + (b[1] - a[1]) * t) * ST.vExag;
        p.pos[i * 3 + 2] = a[2] + (b[2] - a[2]) * t;
      }
      p.pts.geometry.attributes.position.needsUpdate = true;
    }
  }

  for (const l of labelObjs) {
    const dd = camera.position.distanceTo(l.o.position);
    l.div.style.opacity = dd > l.d ? 0 : (dd > l.d * 0.78 ? String(1 - (dd - l.d * 0.78) / (l.d * 0.22)) : '.94');
    l.div.style.display = dd > l.d ? 'none' : '';
  }
  // combined sewer overflow leaving for the river
  for (const po of Object.values(plantObjects)) {
    for (const cp of (po.csoPaths || [])) {
      if (!cp.v) { cp.cpts.visible = false; continue; }
      cp.cpts.visible = true;
      const total = cp.ccum[cp.ccum.length - 1] || 1;
      const step = SC.displaySpeed(cp.v, FLOW_BASE) * dt / total;
      for (let i = 0; i < cp.CN; i++) {
        cp.cprog[i] = (cp.cprog[i] + step) % 1;
        const d = cp.cprog[i] * total;
        let k = 1;
        while (k < cp.ccum.length - 1 && cp.ccum[k] < d) k++;
        const seg = (cp.ccum[k] - cp.ccum[k - 1]) || 1;
        const u = (d - cp.ccum[k - 1]) / seg;
        const a = cp.pth[k - 1], b = cp.pth[k];
        cp.cpos[i * 3] = a.x + (b.x - a.x) * u;
        cp.cpos[i * 3 + 1] = a.y;
        cp.cpos[i * 3 + 2] = a.z + (b.z - a.z) * u;
      }
      cp.cpts.geometry.attributes.position.needsUpdate = true;
    }
  }
  // flow being lifted up the pumping stations' force mains
  for (const po of Object.values(pumpObjects)) {
    if (!po.rpts) continue;
    if (!po.pumped) { po.rpts.visible = false; continue; }
    po.rpts.visible = true;
    const step = SC.displaySpeed(po.riserV, FLOW_BASE) * dt / Math.max(po.depth, 1);
    for (let i = 0; i < po.RN; i++) {
      po.rprog[i] = (po.rprog[i] + step) % 1;
      po.rpos[i * 3] = po.riserX;
      po.rpos[i * 3 + 1] = -po.depth + po.rprog[i] * po.depth;
      po.rpos[i * 3 + 2] = 0;
    }
    po.rpts.geometry.attributes.position.needsUpdate = true;
  }
  // water plunging down the drop shafts
  for (const set of shaftSets) {
    const pl = set.plunge;
    if (!pl) continue;
    if (!pl.drive) { pl.pts.visible = false; continue; }
    pl.pts.visible = true;
    const step = SC.displaySpeed(PLUNGE_MS, FLOW_BASE) * dt;
    for (let i = 0; i < pl.N; i++) {
      const sh = set.items[Math.floor(i / pl.per)];
      const depth = sh._y || 1;
      pl.prog[i] = (pl.prog[i] + step / Math.max(depth, 1)) % 1;
      pl.pos[i * 3] = sh.x;
      pl.pos[i * 3 + 1] = -pl.prog[i] * depth;
      pl.pos[i * 3 + 2] = sh.z;
    }
    pl.pts.geometry.attributes.position.needsUpdate = true;
  }
  // flow through each treatment plant's process train
  for (const po of Object.values(plantObjects)) {
    if (!po.rate || !po.budget) { po.pts.visible = false; continue; }
    const near = camera.position.distanceTo(po.grp.position) < 26000;
    po.pts.visible = near;
    if (!near) continue;
    const segs = po.budget.segs;
    const y = po.linePts.length ? po.linePts[0].y : 0;
    for (let i = 0; i < po.N; i++) {
      // advance through the cycle in proportion to how long each segment
      // really holds the water
      let ph = po.prog[i];
      let k = 0;
      while (k < segs.length - 1 && segs[k].t1 <= ph) k++;
      const sg = segs[k];
      const dwellFrac = (sg.t1 - sg.t0) || 1e-6;
      const step = SC.displaySpeed(sg.v, FLOW_BASE) * dt / Math.max(sg.len, 1) * dwellFrac;
      ph = (ph + step) % 1;
      po.prog[i] = ph;
      k = 0;
      while (k < segs.length - 1 && segs[k].t1 <= ph) k++;
      const s2 = segs[k];
      const u = ((ph - s2.t0) / ((s2.t1 - s2.t0) || 1e-6));
      let px, pz;
      if (s2.kind === 'dwell') {
        // milling about inside the unit rather than sliding past it
        const a = (u * Math.PI * 2) + i;
        const r = s2.len * 0.28;
        px = s2.from.x + Math.cos(a) * r;
        pz = s2.from.z + Math.sin(a) * r * 0.5;
      } else {
        px = s2.from.x + (s2.to.x - s2.from.x) * u;
        pz = s2.from.z + (s2.to.z - s2.from.z) * u;
      }
      po.ppos[i * 3] = px;
      po.ppos[i * 3 + 1] = y;
      po.ppos[i * 3 + 2] = pz;
    }
    po.pts.geometry.attributes.position.needsUpdate = true;
  }
  for (const k in ST.layers) if (layerG[k]) layerG[k].visible = !!ST.layers[k];
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

/* ================================================================ wiring */
function buildUI() {
  // layers
  const names = {
    tunnels: 'Deep tunnels', water: 'Water in the tunnels', shafts: 'TARP drop shafts',
    connections: 'Interceptor connecting structures', reservoirs: 'Reservoirs',
    plants: 'Treatment plants', pumps: 'Pumping stations', outfalls: 'CSO outfalls (441)',
    basins: 'Combined sewer areas', waterways: 'Waterways', labels: 'Labels', particles: 'Flow animation',
  };
  const box = $('#layers');
  for (const [k, lbl] of Object.entries(names)) {
    const id = 'ly_' + k;
    const row = el('label', 'lrow', `<input type="checkbox" id="${id}"${ST.layers[k] ? ' checked' : ''}><span>${lbl}</span>`);
    box.appendChild(row);
    row.querySelector('input').addEventListener('change', e => { ST.layers[k] = e.target.checked ? 1 : 0; });
  }
  // configs
  const cs = $('#config');
  for (const c of CONFIGS) cs.appendChild(el('option', null, c.label)).value = c.id;
  cs.value = ST.storm.config;
  // scenarios
  const ss = $('#scenario');
  for (const s of D.sim.scenarios) {
    const o = el('option', null, s.label); o.value = s.id; ss.appendChild(o);
  }
  ss.value = 'design';
  // recorded events
  const ev = $('#eventlist');
  for (const e of D.sim.events.slice(0, 12)) {
    const b = el('button', 'evbtn', `<b>${e.date}</b><span>${e.totalMG.toLocaleString()} MG recorded</span>`);
    b.addEventListener('click', () => {
      const yr = +e.date.slice(0, 4);
      const cfg = yr < 2007 ? 'pre' : yr < 2015 ? 'tunnels' : yr < 2017 ? 'r2015' : 'today';
      $('#config').value = cfg; ST.storm.config = cfg;
      $('#recnote').innerHTML = `Recorded on <b>${e.date}</b>: ${e.totalMG.toLocaleString()} MG across ` +
        Object.keys(e.stations).length + ` MWRD pumping stations (` +
        Object.entries(e.stations).map(([k, v]) => {
          const f = D.facilities.find(x => x.id === k);
          return `${f ? f.short : k} ${v.toLocaleString()} MG`;
        }).join(', ') + `). Set a rainfall above and compare.`;
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
    buildTunnels(); positionShafts(); applyFrame(true);
    $('#routenote').textContent = ST.route === 'corridor'
      ? 'Drop shafts sit exactly on their MWRD coordinates; the route follows the traced surface corridor, which is longer than the published tunnel.'
      : 'The route is smoothed until its length matches MWRD’s published mileage; drop shafts are then offset from it by the amount the smoothing moved the line.';
  });
  bind('#rain', e => {
    ST.storm.inches = +e.target.value;
    $('#rainv').textContent = ST.storm.inches.toFixed(2) + ' in';
    runSim();
  });
  bind('#dur', e => {
    ST.storm.hours = +e.target.value;
    $('#durv').textContent = ST.storm.hours + ' h';
    runSim();
  });
  bind('#runoff', e => {
    ST.storm.runoffC = +e.target.value / 100;
    $('#runoffv').textContent = ST.storm.runoffC.toFixed(2);
    runSim();
  });
  $('#scenario').addEventListener('change', e => {
    const s = D.sim.scenarios.find(x => x.id === e.target.value);
    if (!s) return;
    ST.storm.inches = s.inches; ST.storm.hours = s.hours || 1;
    $('#rain').value = s.inches; $('#rainv').textContent = s.inches.toFixed(2) + ' in';
    $('#dur').value = ST.storm.hours; $('#durv').textContent = ST.storm.hours + ' h';
    $('#scennote').textContent = s.note;
    runSim();
  });
  $('#config').addEventListener('change', e => { ST.storm.config = e.target.value; runSim(); });
  $('#shape').addEventListener('change', e => { ST.storm.shape = e.target.value; runSim(); });
  $('#pumplimit').addEventListener('change', e => { ST.storm.pumpLimit = e.target.value; runSim(); });
  $('#play').addEventListener('click', () => togglePlay());
  $('#speed').addEventListener('input', e => { ST.speed = +e.target.value; $('#speedv').textContent = ST.speed + '×'; });
  $('#scrub').addEventListener('input', e => { ST.frame = +e.target.value; ST.playing = false; $('#play').textContent = '▶'; applyFrame(); });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-focus]');
    if (b) flyTo(b.getAttribute('data-focus'));
    const t = e.target.closest('[data-tab]');
    if (t) {
      const n = t.getAttribute('data-tab');
      document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === t));
      document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('on', p.id === 'tab-' + n));
      if (n === 'notes') renderFidelity();
      // canvases cannot be measured while their pane is display:none
      requestAnimationFrame(() => { drawLadder(); if (ST.run) { drawChart(); } });
    }
  });
  $('#panelToggle').addEventListener('click', () => {
    document.body.classList.toggle('collapsed');
    setTimeout(resize, 260);
  });
}

function togglePlay(v) {
  ST.playing = v == null ? !ST.playing : v;
  if (ST.playing && ST.frame >= ST.run.frames.length - 1) ST.frame = 0;
  $('#play').textContent = ST.playing ? '❙❙' : '▶';
}

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); labelRenderer.setSize(w, h);
  if (ST.run) drawChart();
  drawLadder();
}
addEventListener('resize', resize);

/* ================================================================== go */
buildUI();
buildGround();
buildSurface();
buildTunnels();
buildShafts();
buildReservoirs();
buildPlants();
buildPumps();
frameAll();
setScale(18, 34);
$('#scennote').textContent = D.sim.scenarios.find(s => s.id === 'design').note;
runSim();
renderFidelity();
drawLadder();
inspect(null);
animate(performance.now());

// handle for debugging and for driving the view from the console
window.__S3D = { THREE, scene, world, camera, controls, ST, D, layerG, conduits,
                 resObjects, plantObjects, pumpObjects, shaftSets, particles,
                 setScale, flyTo, runSim, applyFrame, frameAll, model };
