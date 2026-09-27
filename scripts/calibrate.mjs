#!/usr/bin/env node
/* Test the assumed hydrology of assets/js/system3d/sim.js against MWRD's
 * recorded pumping-station discharge for the ten storms in map-data/storms.json.
 *
 *   node scripts/calibrate.mjs [--quick] [--out map-data/calibration.json]
 *
 * SECOND ATTEMPT (27 Sept 2026). The first (e617919) fitted six knobs at once,
 * drove three of them onto their bounds and did worse on the held-out storms;
 * its record is kept under `previous` in the output. This one works in two
 * stages.
 *
 * 1. STRUCTURE FIRST. The first attempt's residuals were basin-structured --
 *    the Central basin read low, the South high -- and no coefficient that
 *    moves every basin together can close that. So before anything is fitted,
 *    each candidate structural cause is tried as one isolated change and its
 *    effect on the per-basin residuals is recorded. Only a change with a
 *    source is adopted (in the build or the model); the rest are reported as
 *    sensitivities and left alone.
 *
 * 2. THEN A SMALL FIT: runoffC, runoffMax and amcK only. Three knobs are held
 *    fixed, deliberately, and the output says why:
 *      reliefFactor 1.5  It scales gravity outfalls MWRD's station log never
 *                        sees. Fitted against that log it runs to its upper
 *                        bound, because spilling surplus where the log cannot
 *                        look improves the volume score -- and it cut the
 *                        standing-water layer by three quarters doing so.
 *      routeN 2, routeK 1.5 h
 *                        Timing. A storm-window volume total cannot see when
 *                        water arrives, so these were unconstrained (routeK ran
 *                        to its lower bound in every fold). The CSO database's
 *                        tide-gate times are the observation that could; see
 *                        the timing check at the end, which reports but never
 *                        fits them.
 *
 * OBJECTIVE, as in the first attempt, over the SIX stations MWRD logs:
 *   primary   RMS over storms of log(modelled / recorded) for the six-station
 *             total. Log space, so 2x too much and half too little cost the
 *             same.
 *   secondary RMS over (storm x basin group) of log((model+25)/(recorded+25)),
 *             weight 0.35. Groups are CENTRAL (Racine + Westchester), NORTH
 *             (North Branch) and SOUTH (95th + 122nd + 125th). Stations are
 *             pooled to their basin because the split between stations inside
 *             a basin is the model's capacity-share assumption, not data.
 *
 * Adopt only if the fit is better than the defaults on the two storms held
 * out before fitting AND under leave-one-out, no fitted parameter rests on a
 * bound, and every parameter's profile shows a real minimum.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');

/* Held out BEFORE fitting, and not on the basis of fit: one spring storm and
 * one summer storm, neither the largest (2020-05-14) nor the smallest
 * (2009-06-16) nor the known outlier (2010-07-23). Same pair as the first
 * attempt, so the two are comparable. */
const HOLDOUT = ['2013-04-15', '2014-08-21'];

const FIXED = { reliefFactor: 1.5, routeN: 2, routeK: 1.5 };
const FIXED_WHY = {
  reliefFactor: 'Scales gravity outfalls that MWRD\'s pumping-station log never sees, so the log cannot constrain it: fitted against it in the first attempt it ran to its upper bound (4.0), buying its score by spilling surplus where the log cannot look and cutting the standing-water layer by 75%.',
  routeN: 'Timing, not volume: a storm-window total cannot see when water arrives. Unconstrained in the first attempt.',
  routeK: 'Timing, not volume: ran to its 0.5 h lower bound in the first attempt\'s fit and in every leave-one-out fold. Checked against MWRD\'s tide-gate times below, never fitted from them.',
};
const DEFAULTS = { runoffC: 0.32, runoffMax: 0.62, amcK: 2.5 };
const NAMES = ['runoffC', 'runoffMax', 'amcK'];
const BOUNDS = {
  runoffC: [0.05, 0.60],
  runoffMax: ['runoffC', 0.90],           // never below runoffC
  amcK: [0.3, 10],                        // inches of 72-h rain, searched in log space
};
const GROUPS = {
  CENTRAL: ['ps-racine', 'ps-westchester'],
  NORTH:   ['ps-north-branch'],
  SOUTH:   ['ps-95th', 'ps-122nd', 'ps-125th'],
};
const GROUP_FLOOR = 25;      // MG, so a group that logged nothing stays finite
const W_STATION = 0.35;
const FLAT = 0.02;           // J within this of the best is "no better" (as in the first attempt)

const r4 = v => Math.round(v * 10000) / 10000;
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(a.length, 1));
const mean = a => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
const clamp01 = v => Math.min(1, Math.max(0, v));
const named = p => ({ runoffC: r4(p.runoffC), runoffMax: r4(p.runoffMax), amcK: r4(p.amcK) });

// ---------------------------------------------------------------- model env

async function loadEnv() {
  global.window = {};
  const src = fs.readFileSync(path.join(ROOT, 'map-data/system3d.js'), 'utf8')
    .replace('window.SYS3D =', 'global.__D =');
  (0, eval)(src);
  const D = global.__D;
  const storms = JSON.parse(fs.readFileSync(path.join(ROOT, 'map-data/storms.json'), 'utf8')).storms;
  const sim = await import(path.join(ROOT, 'assets/js/system3d/sim.js'));
  return { D, sim, storms, model: new sim.SewerModel(D) };
}

/** The stations MWRD's log carries, read from the build rather than assumed. */
const loggedStations = D => Object.values(D.sim.relief).filter(x => x.logged !== false).map(x => x.id);

/** Station discharge rebuilt from the frames, counted from `fromHr` -- the
 *  same arithmetic run() uses for summary.passedByStation. Used only to show
 *  what the old whole-run accounting gave. */
function passedFromFrames(model, D, r, fromHr) {
  const out = {};
  for (const id of Object.keys(D.sim.relief)) out[id] = 0;
  for (const f of r.frames) {
    if (f.t < fromHr) continue;
    for (const b of Object.values(model.basins)) {
      const rl = (b.relief || []).map(id => D.sim.relief[id]).filter(Boolean);
      const tot = rl.reduce((a, x) => a + x.capMGD, 0) || 1;
      const fb = f.basins[b.id];
      for (const x of rl)
        out[x.id] += (Math.min(fb.cso * x.capMGD / tot, x.capMGD) + fb._drainRate * x.capMGD / tot) * r.dtHr / 24;
    }
  }
  return out;
}

/** Run one parameter set over a list of storms and score it.
 *  opts.countFrom 'storm' (as run() now counts) or 'run' (the whole run,
 *  lead-in week included, as it counted before 27 Sept 2026). */
function score(env, params, storms, opts = {}) {
  const { model, D } = env;
  const logged = opts.logged || loggedStations(D);
  const per = [];
  for (const st of storms) {
    const r = model.run(Object.assign({ hyeto: st, config: st.era }, FIXED, params));
    const s = r.summary;
    const pbs = opts.countFrom === 'run' ? passedFromFrames(model, D, r, 0) : s.passedByStation;
    const passedMG = logged.reduce((a, id) => a + (pbs[id] || 0), 0);
    const groups = {};
    for (const [g, ids] of Object.entries(GROUPS)) {
      const mod = ids.reduce((a, id) => a + (pbs[id] || 0), 0);
      const rec = ids.reduce((a, id) => a + ((st.recordedCsoMG || {})[id] || 0), 0);
      groups[g] = { mod, rec, logRatio: Math.log((mod + GROUP_FLOOR) / (rec + GROUP_FLOOR)) };
    }
    const maj = (((st.observed || {}).reservoirs || {})['res-majewski']) || {};
    const majCap = r.frames[0].reservoirs['res-majewski'].capMG;
    per.push({
      start: st.start, era: st.era, holdout: HOLDOUT.includes(st.start),
      passedMG, recordedMG: st.recordedTotalMG,
      ratio: passedMG / Math.max(st.recordedTotalMG, 1),
      logRatio: Math.log(Math.max(passedMG, 1) / Math.max(st.recordedTotalMG, 1)),
      groups, csoMG: s.csoMG, peakPooledMG: s.peakPooledMG,
      // MWRD logs a Majewski fill event whenever the reservoir stores combined
      // sewage at all (map-data/storm-observations.json, meta)
      majewskiFillLogged: maj.fillEvent === undefined ? null : maj.fillEvent,
      majewskiPeakMG: (s.peakResFill['res-majewski'] || 0) * majCap,
      majewskiRecordedPeakMG: maj.peakMG == null ? null : maj.peakMG,
      stations: Object.fromEntries(logged.map(id => [id, Math.round(pbs[id] || 0)])),
      run: opts.keepRuns ? r : undefined,
    });
  }
  const primary = rms(per.map(p => p.logRatio));
  const gl = [];
  for (const p of per) for (const g of Object.values(p.groups)) gl.push(g.logRatio);
  const secondary = rms(gl);
  const byGroup = Object.fromEntries(Object.keys(GROUPS).map(g => {
    const l = per.map(p => p.groups[g].logRatio);
    return [g, { meanLog: mean(l), rmsLog: rms(l) }];
  }));
  return { J: primary + W_STATION * secondary, primary, secondary, per, byGroup,
           gmean: Math.exp(mean(per.map(p => p.logRatio))) };
}

// ------------------------------------------------------ parameter mapping

/** Free unit coordinates -> physical parameters, with any of the three pinned.
 *  runoffMax lives in [runoffC, 0.9]; amcK is searched in log space. */
function makeMap(fixed = {}) {
  const free = NAMES.filter(n => !(n in fixed));
  const lin = (lo, hi, u) => lo + (hi - lo) * u;
  const cHi = () => ('runoffMax' in fixed ? Math.min(BOUNDS.runoffC[1], fixed.runoffMax) : BOUNDS.runoffC[1]);
  const lk = [Math.log(BOUNDS.amcK[0]), Math.log(BOUNDS.amcK[1])];
  const map = u => {
    let k = 0;
    const next = () => clamp01(u[k++]);
    const v = {};
    v.runoffC = 'runoffC' in fixed ? fixed.runoffC : lin(BOUNDS.runoffC[0], cHi(), next());
    v.runoffMax = 'runoffMax' in fixed ? fixed.runoffMax : lin(v.runoffC, BOUNDS.runoffMax[1], next());
    v.amcK = 'amcK' in fixed ? fixed.amcK : Math.exp(lin(lk[0], lk[1], next()));
    return v;
  };
  const inv = p => {
    const u = [];
    const c = 'runoffC' in fixed ? fixed.runoffC : Math.min(cHi(), Math.max(BOUNDS.runoffC[0], p.runoffC));
    if (!('runoffC' in fixed)) u.push(clamp01((c - BOUNDS.runoffC[0]) / Math.max(1e-9, cHi() - BOUNDS.runoffC[0])));
    if (!('runoffMax' in fixed)) u.push(clamp01((p.runoffMax - c) / Math.max(1e-9, BOUNDS.runoffMax[1] - c)));
    if (!('amcK' in fixed)) u.push(clamp01((Math.log(p.amcK) - lk[0]) / (lk[1] - lk[0])));
    return u;
  };
  return { free, map, inv };
}

/** Which fitted parameters the box, not the data, stopped. */
function atBounds(p) {
  const out = [];
  const tol = 0.005;
  const uC = (p.runoffC - BOUNDS.runoffC[0]) / (BOUNDS.runoffC[1] - BOUNDS.runoffC[0]);
  if (uC <= tol) out.push({ param: 'runoffC', at: 'lower', value: r4(p.runoffC) });
  if (uC >= 1 - tol) out.push({ param: 'runoffC', at: 'upper', value: r4(p.runoffC) });
  const uM = (p.runoffMax - p.runoffC) / (BOUNDS.runoffMax[1] - p.runoffC);
  if (uM <= tol) out.push({ param: 'runoffMax', at: 'lower (= runoffC: the antecedent-moisture ramp is switched off, and amcK has no effect at all)', value: r4(p.runoffMax) });
  if (uM >= 1 - tol) out.push({ param: 'runoffMax', at: 'upper', value: r4(p.runoffMax) });
  const lk = [Math.log(BOUNDS.amcK[0]), Math.log(BOUNDS.amcK[1])];
  const uK = (Math.log(p.amcK) - lk[0]) / (lk[1] - lk[0]);
  if (uK <= tol) out.push({ param: 'amcK', at: 'lower', value: r4(p.amcK) });
  if (uK >= 1 - tol) out.push({ param: 'amcK', at: 'upper', value: r4(p.amcK) });
  return out;
}

// ------------------------------------------------------------- optimisation

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Latin hypercube in the unit box. */
function lhs(n, dim, rng) {
  const cols = Array.from({ length: dim }, () => {
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    return p;
  });
  return Array.from({ length: n }, (_, i) => cols.map(c => (c[i] + rng()) / n));
}

/** Nelder-Mead. f takes a free-dim vector. */
function nelderMead(f, x0, steps, maxEval) {
  const n = x0.length;
  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += steps[i]; simplex.push(p); }
  let evals = 0;
  const F = p => { evals++; return f(p); };
  let vals = simplex.map(F);
  const order = () => {
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    const s = idx.map(i => simplex[i]), v = idx.map(i => vals[i]);
    for (let i = 0; i <= n; i++) { simplex[i] = s[i]; vals[i] = v[i]; }
  };
  order();
  while (evals < maxEval) {
    const size = Math.max(...simplex.slice(1).map(p => Math.max(...p.map((v, k) => Math.abs(v - simplex[0][k])))));
    if (Math.abs(vals[n] - vals[0]) < 1e-6 && size < 1e-3) break;
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[k] += simplex[i][k] / n;
    const at = (a) => c.map((ck, k) => ck + a * (ck - simplex[n][k]));
    const xr = at(1), fr = F(xr);
    if (fr < vals[0]) {
      const xe = at(2), fe = F(xe);
      if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) {
      simplex[n] = xr; vals[n] = fr;
    } else {
      const inside = fr >= vals[n];
      const xc = inside ? at(-0.5) : at(0.5), fc = F(xc);
      if (fc < Math.min(fr, vals[n])) { simplex[n] = xc; vals[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k]));
          vals[i] = F(simplex[i]);
        }
      }
    }
    order();
  }
  return { x: simplex[0], f: vals[0], evals };
}

/** One fit on the unit box: LHS seeds plus any supplied starts, Nelder-Mead
 *  from the best, then a polish. `fixed` pins parameters (for profiling). */
function fitJob(env, storms, { fixed = {}, nSeeds = 0, nStarts = 1, starts = [], maxEval, seed }) {
  const { free, map, inv } = makeMap(fixed);
  if (!free.length) { const p = map([]); return { params: p, J: score(env, p, storms).J }; }
  // outside the box the map clamps; a small slope back toward it keeps the
  // simplex from wandering off across a flat face
  const f = u => {
    const uc = u.map(clamp01);
    return score(env, map(uc), storms).J + 0.01 * u.reduce((a, v, i) => a + Math.abs(v - uc[i]), 0);
  };
  const rng = mulberry32(seed || 1);
  const seeds = nSeeds ? lhs(nSeeds, free.length, rng).map(u => ({ u, v: f(u) })).sort((a, b) => a.v - b.v) : [];
  const from = seeds.slice(0, nStarts).map(s => s.u).concat(starts.map(p => inv(p)));
  const steps = free.map(() => 0.15);
  let best = null;
  for (const x0 of from) {
    let r = nelderMead(f, x0, steps, maxEval);
    r = nelderMead(f, r.x, steps.map(s => s * 0.25), Math.round(maxEval / 2));   // polish
    if (!best || r.f < best.f) best = r;
  }
  const u = best.x.map(clamp01), params = map(u);
  return { params, u, J: score(env, params, storms).J };
}

/** Constant C, antecedent moisture switched off (amcK = 0): a grid over the
 *  whole range, then golden section inside the best bracket. */
function fitConst(env, storms, grid) {
  const f = c => score(env, { runoffC: c, runoffMax: c, amcK: 0 }, storms).J;
  const g = grid.map(c => ({ c, J: f(c) }));
  let i = g.reduce((b, x, k) => (x.J < g[b].J ? k : b), 0);
  let a = g[Math.max(0, i - 1)].c, b = g[Math.min(g.length - 1, i + 1)].c;
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = b - phi * (b - a), x2 = a + phi * (b - a), f1 = f(x1), f2 = f(x2);
  while (b - a > 0.002) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - phi * (b - a); f1 = f(x1); }
    else { a = x1; x1 = x2; f1 = f2; x2 = a + phi * (b - a); f2 = f(x2); }
  }
  const cands = g.concat([{ c: x1, J: f1 }, { c: x2, J: f2 }]).sort((p, q) => p.J - q.J);
  return { c: cands[0].c, J: cands[0].J, grid: g };
}

// -------------------------------------------------------------- worker side

if (!isMainThread) {
  const env = await loadEnv();
  const pick = starts => env.storms.filter(s => starts.includes(s.start));
  parentPort.on('message', job => {
    const storms = pick(job.stormStarts);
    const r = job.kind === 'const' ? fitConst(env, storms, job.grid) : fitJob(env, storms, job);
    parentPort.postMessage(Object.assign({ tag: job.tag }, r));
  });
  parentPort.postMessage({ ready: true });
}

/** A pool of workers fed one job at a time, so a slow job does not hold up
 *  a whole pre-assigned bucket. */
function runWorkers(jobs, lanes) {
  return new Promise((resolve, reject) => {
    const queue = jobs.slice(), results = [];
    let live = Math.min(lanes, jobs.length);
    if (!live) return resolve(results);
    for (let i = 0, n = live; i < n; i++) {
      const w = new Worker(SELF);
      const feed = () => {
        if (queue.length) return w.postMessage(queue.shift());
        w.terminate();
        if (--live === 0) resolve(results);
      };
      w.on('message', m => { if (!m.ready) results.push(m); feed(); });
      w.on('error', reject);
    }
  });
}

// ------------------------------------------------------ structural diagnosis

/** Apply a temporary change to the build data (and/or the basin routing),
 *  score the defaults on it, and put everything back. */
function variant(env, mutate, opts = {}) {
  const { D, sim } = env;
  const saved = JSON.stringify({ sim: D.sim, routing: sim.BASIN_ROUTING,
    basins: D.basins.map(b => ({ relief: b.relief, area: b.areaSqMi.v })) });
  try {
    mutate && mutate(D, sim);
    const e2 = Object.assign({}, env, { model: new sim.SewerModel(D) });
    return score(e2, DEFAULTS, env.storms, opts);
  } finally {
    const s = JSON.parse(saved);
    for (const k of Object.keys(D.sim)) D.sim[k] = s.sim[k];
    for (const k of Object.keys(sim.BASIN_ROUTING)) sim.BASIN_ROUTING[k] = s.routing[k];
    D.basins.forEach((b, i) => { b.relief = s.basins[i].relief; b.areaSqMi.v = s.basins[i].area; });
  }
}

const summarise = (label, s, extra = {}) => Object.assign({
  label, J: r4(s.J), primary: r4(s.primary), secondary: r4(s.secondary), gmeanRatio: r4(s.gmean),
  byGroup: Object.fromEntries(Object.entries(s.byGroup).map(([g, v]) =>
    [g, { meanLog: r4(v.meanLog), factor: r4(Math.exp(v.meanLog)), rmsLog: r4(v.rmsLog) }])),
}, extra);

function printSummary(x) {
  const g = x.byGroup, sg = v => (v >= 0 ? '+' : '') + v.toFixed(3);
  console.log(`  ${x.label.padEnd(58)} J ${x.J.toFixed(3)}  gmean ${x.gmeanRatio.toFixed(3)}  |  mean log  C ${sg(g.CENTRAL.meanLog)} (${g.CENTRAL.factor.toFixed(2)}x)  N ${sg(g.NORTH.meanLog)} (${g.NORTH.factor.toFixed(2)}x)  S ${sg(g.SOUTH.meanLog)} (${g.SOUTH.factor.toFixed(2)}x)  |  rms C ${g.CENTRAL.rmsLog.toFixed(3)} N ${g.NORTH.rmsLog.toFixed(3)} S ${g.SOUTH.rmsLog.toFixed(3)}`);
}

function printPerStorm(title, per) {
  console.log(`\n${title}`);
  console.log('  storm        era      |  six-station mod / rec   x   |  CENTRAL mod / rec    x  |  NORTH mod / rec     x  |  SOUTH mod / rec     x');
  const f = v => String(Math.round(v)).padStart(6);
  for (const p of per) {
    const g = p.groups, x = k => ((g[k].mod + GROUP_FLOOR) / (g[k].rec + GROUP_FLOOR)).toFixed(2).padStart(5);
    console.log(`  ${p.start}${p.holdout ? '*' : ' '} ${p.era.padEnd(8)} | ${f(p.passedMG)} ${f(p.recordedMG)} ${p.ratio.toFixed(2).padStart(5)} | ${f(g.CENTRAL.mod)} ${f(g.CENTRAL.rec)} ${x('CENTRAL')} | ${f(g.NORTH.mod)} ${f(g.NORTH.rec)} ${x('NORTH')} | ${f(g.SOUTH.mod)} ${f(g.SOUTH.rec)} ${x('SOUTH')}`);
  }
}

function structural(env) {
  const { D, model, storms } = env;
  const out = { note: 'Each candidate is one isolated change to the build or the model, scored at the default parameters over all ten storms against the six logged stations. byGroup.meanLog is the mean over storms of log((model+25)/(recorded+25)) for the basin group; factor = exp(meanLog).' };

  // the accounting fix is only honest if the frames reproduce run()'s own sum
  const chk = storms.map(st => {
    const r = model.run(Object.assign({ hyeto: st, config: st.era }, FIXED, DEFAULTS));
    const a = passedFromFrames(model, D, r, st.leadHr || 0);
    return Math.max(...Object.keys(a).map(id => Math.abs(a[id] - r.summary.passedByStation[id])));
  });
  if (Math.max(...chk) > 1e-6) throw new Error('frame reconstruction of passedByStation disagrees with run()');

  const before = variant(env, d => { d.sim.plants['wrp-calumet'].avg = 354; }, { countFrom: 'run' });
  out.at64c9816 = summarise('as at 64c9816: Calumet dry-weather 354 MGD, whole-run counting', before,
    { perStorm: stripPer(before.per) });
  out.adopted = [
    { change: 'Calumet WRP dry-weather base, plants[\'wrp-calumet\'].avg: 354 -> 244 MGD',
      where: 'scripts/build_system3d.py FAC_SPEC; map-data/system3d.js rebuilt',
      source: '354 is the NPDES design average flow (doc12). 244 is the 2024 annual average treated flow in MWRD M&R Report 25-28 (doc11 source 21), the report and year the build already uses for Stickney\'s 685; see plantFlows for 2013-2024.' },
    { change: 'modelled station discharge counted from the storm\'s start date, not from the start of the lead-in week',
      where: 'assets/js/system3d/sim.js run(): summary.passedByStation and passedMG',
      source: 'scripts/build_storms.py sums MWRD\'s log from the start date to two days after the end date. MWRD logged discharge in the lead-in weeks of 2008-09-12 and 2017-10-14 too, on dates outside that window.' },
  ];
  const cands = [];
  cands.push(summarise('Calumet dry-weather base 354 -> 244 MGD (alone)',
    variant(env, null, { countFrom: 'run' }), { kind: 'adopted', change: 'plants.wrp-calumet.avg' }));
  cands.push(summarise('count the log window from the storm start (alone)',
    variant(env, d => { d.sim.plants['wrp-calumet'].avg = 354; }), { kind: 'adopted', change: 'sim.js passedByStation' }));
  const now = variant(env, null);
  cands.push(summarise('both: the build as committed here', now, { kind: 'adopted' }));
  for (const [v, why] of [[308, '2019 annual average treated flow, the highest of 2013-2024 (MWRD annual biosolids report for 2019)'],
                          [225, '2015 annual average treated flow, the lowest of 2013-2024 (M&R Report 16-05)']])
    cands.push(summarise(`Calumet dry-weather base ${v} MGD`, variant(env, d => { d.sim.plants['wrp-calumet'].avg = v; }),
      { kind: 'sensitivity', source: why }));
  cands.push(summarise('O\'Brien dry-weather base 230 -> 216 MGD (2024 annual average, same report)',
    variant(env, d => { d.sim.plants['wrp-obrien'].avg = 216; }), { kind: 'sensitivity' }));
  for (const f of [1.0, 0.9, 0.5, 0.3, 0.0])
    cands.push(summarise(`CENTRAL routing Mainstream ${f} / Des Plaines ${r4(1 - f)} (default 0.741 / 0.259)`,
      variant(env, (d, s) => { s.BASIN_ROUTING.CENTRAL = [['mainstream', f], ['desplaines', 1 - f]]; }),
      { kind: 'sensitivity', share: f }));
  cands.push(summarise('NORTH relief through North Branch only (Wilmette PS not an outlet)',
    variant(env, d => { d.basins.find(b => b.id === 'NORTH').relief = ['ps-north-branch']; }), { kind: 'sensitivity' }));
  // McCook's Des Plaines Inflow Tunnel reached substantial completion in Oct
  // 2021 (doc10), so in May 2020 the Des Plaines tunnel could not spill into
  // McCook -- but the 'today' build-out lets it. Only 2020-05-14 is affected.
  const base = variant(env, null, { keepRuns: true });
  const dp = variant(env, d => { d.sim.systems.desplaines.reservoir = null; }, { keepRuns: true });
  const lead20 = storms.find(s => s.start === '2020-05-14').leadHr;
  const dp20 = dp.per.find(p => p.start === '2020-05-14'), now20 = base.per.find(p => p.start === '2020-05-14');
  const first = p => { const f = p.run.frames.find(f => f.t >= lead20 && f.basins.CENTRAL.cso > 1); return f ? f.t : null; };
  cands.push(summarise('no Des Plaines tunnel -> McCook spill (the Des Plaines Inflow Tunnel was not built until Oct 2021)', dp,
    { kind: 'sensitivity', source: 'doc10: Des Plaines Inflow Tunnel awarded June 2016, substantial completion Oct 2021',
      may2020: { centralMG: [Math.round(now20.groups.CENTRAL.mod), Math.round(dp20.groups.CENTRAL.mod)],
                 northMG: [Math.round(now20.groups.NORTH.mod), Math.round(dp20.groups.NORTH.mod)],
                 recordedCentralMG: now20.groups.CENTRAL.rec, recordedNorthMG: now20.groups.NORTH.rec,
                 firstCentralOverflowHr: [first(now20), first(dp20)],
                 note: '[as built, without the link]. Not adopted: it needs a build-out state for Dec 2017 - Oct 2021 (McCook Stage 1 without the Des Plaines inflow), which the model does not have yet.' } }));
  out.candidates = cands;

  // looked at and set aside
  const rac = storms.map((st, i) => {
    const r = base.per[i].run;
    let rainIn = 0;
    for (const f of r.frames) if (f.t >= st.leadHr && f.t < st.hours + 24) rainIn += f.basins.CENTRAL.inHr * r.dtHr;
    const logged = (st.recordedCsoMG || {})['ps-racine'] || 0;
    return [st.start, Math.round(logged), r4(rainIn), r4(logged / (rainIn * 30 * 17.38))];
  });
  out.setAside = {
    thorntonTransitional: 'The Thornton Transitional Reservoir (3.1 BG, 2003-2022) is absent from the 2006 build-out, correctly: it held Thorn Creek flood water diverted at the creek (MWRD M&R "Thornton Transitional Flood Control Reservoir" annual reports; doc10), not Calumet TARP overflow.',
    racineArea: { note: 'doc07 gives Racine Avenue PS a 30 sq mi tributary area (36 in MWRD-adjacent sources) inside a 161 sq mi Central basin, which might suggest routing only part of the basin through it. But in several storms it logged more than all the rain on 30 sq mi, so in a storm it is fed from further afield; the model\'s routing of the whole basin\'s overflow through it is not contradicted. Columns: storm, Racine logged MG, Central basin rain in the log window (in), logged / (rain x 30 sq mi x 17.38 MG per inch-sq mi).', storms: rac },
    duplicateRows: 'data/mwrd-ps-cso-activity.csv carries six duplicated Westchester rows. One falls in a storm window: 2017-10-14 counts 14.337 MG twice (28.7 recorded instead of 14.3) -- 0.3% of that storm\'s Central total. Left for scripts/build_storms.py to de-duplicate.',
  };
  // "The annual average treated flow in <year> was <Y> MGD", MWRD M&R annual
  // biosolids management reports for 2013-2024 (sources/mwrd-mr-reports/,
  // and for 2024 sources/stickney-wrp/annual_biosolids_report_2024.pdf,
  // which is doc11's source 21). The 2015 report's OCR text gave Calumet's and
  // Kirie's figures only.
  const YRS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
  const series = a => Object.fromEntries(YRS.map((y, i) => [y, a[i]]).filter(([, v]) => v != null));
  out.plantFlows = {
    note: 'Design average flow (NPDES) against the annual average MWRD actually treated. Annual averages include wet-weather flow, so as dry-weather bases they read somewhat high -- alike for all three large plants. The build uses 2024 for Stickney and now Calumet: the same report and year.',
    stickney: { designAverage: 1200, model: D.sim.plants['wrp-stickney'].avg, verdict: 'the 2024 actual already (unchanged)',
                actual: series([676, 769, null, 680, 685, 775, 817, 696, 604, 665, 670, 685]) },
    calumet: { designAverage: 354, model: D.sim.plants['wrp-calumet'].avg, verdict: 'was the design average; now the 2024 actual. No year 2013-2024 came within 46 MGD of 354',
               actual: series([237, 278, 225, 253, 255, 247, 308, 264, 233, 236, 227, 244]) },
    obrien: { designAverage: 333, model: D.sim.plants['wrp-obrien'].avg, verdict: 'an actual already (MWRD fact sheet "current average", doc12); unchanged',
              actual: series([204, 250, null, 225, 234, 247, 257, 207, 204, 208, 211, 216]) },
    kirie: { designAverage: 52, model: D.sim.plants['wrp-kirie'].avg, verdict: 'tagged "assumed" in the build although these reports source it; not changed here, since it touches only the O\'Hare basin',
             actual: series([38.6, 31.1, 29.3, 37.8, 38.3, 47.02, 47.78, 35.3, 32.65, 36.12, 33.68, 34.36]) },
  };

  // per-station split inside each basin: the model's capacity shares vs the log
  const runs = storms.map(st => model.run(Object.assign({ hyeto: st, config: st.era }, FIXED, DEFAULTS)));
  const split = {};
  for (const b of Object.values(model.basins)) {
    const ids = (b.relief || []).filter(id => D.sim.relief[id]);
    if (!ids.length) continue;
    const rated = ids.reduce((a, id) => a + D.sim.relief[id].capMGD, 0);
    const m = ids.map(id => runs.reduce((a, r) => a + r.summary.passedByStation[id], 0));
    const c = ids.map(id => storms.reduce((a, st) => a + ((st.recordedCsoMG || {})[id] || 0), 0));
    const ct = c.reduce((a, v) => a + v, 0);
    split[b.id] = ids.map((id, i) => ({
      station: id, logged: D.sim.relief[id].logged !== false, ratedMGD: D.sim.relief[id].capMGD,
      capacityShare: r4(D.sim.relief[id].capMGD / rated), modelMG: Math.round(m[i]), loggedMG: Math.round(c[i]),
      loggedShare: ct > 0 ? r4(c[i] / ct) : null,
      stormsLogged: storms.filter(st => ((st.recordedCsoMG || {})[id] || 0) > 0).length,
    }));
  }
  out.reliefSplit = { note: 'The model splits a basin\'s discharge across its stations by rated capacity. Summed over the ten storms. No source gives a different split, so none is changed. The basin totals the objective scores do not depend on the split, except in the North, where the 37% sent to Wilmette PS is not in the log (see the candidate that removes Wilmette as an outlet).', basins: split };

  // O'Hare basin area against Majewski's logged fill events
  const oh = D.basins.find(b => b.id === 'OHARE');
  const ohare = [];
  for (const [a, src] of [[oh.areaSqMi.v, 'GIS: MWRD Combined_Sewer_Areas, Type CSA (the build)'],
                          [11, 'doc09: "drains an 11-square-mile combined-sewer area around O\'Hare"'],
                          [13.7, 'doc13: 1988 EPA/MSDGC evaluation, "13.7 square miles of combined-sewer area"']]) {
    const s = variant(env, d => { d.basins.find(b => b.id === 'OHARE').areaSqMi.v = a; });
    const logged = s.per.filter(p => p.majewskiFillLogged === true), none = s.per.filter(p => p.majewskiFillLogged === false);
    const may = s.per.find(p => p.start === '2020-05-14');
    ohare.push({ areaSqMi: a, source: src,
      hits: logged.filter(p => p.majewskiPeakMG > 1).length, logged: logged.length,
      falseAlarms: none.filter(p => p.majewskiPeakMG > 1).length, loggedNone: none.length,
      may2020PeakMG: Math.round(may.majewskiPeakMG), may2020RecordedMG: may.majewskiRecordedPeakMG,
      peaks: s.per.map(p => [p.start, Math.round(p.majewskiPeakMG), p.majewskiFillLogged]) });
  }
  out.ohare = { note: 'A fill event here is any stored volume above 1 MG: MWRD logs one "whenever the reservoir is used to store TARP combined sewage". The first attempt counted only fills above 50%, which is not MWRD\'s definition. The GIS layer separates combined (CSA) from separated (DSA) and unsewered (USA) polygons; the O\'Hare CSA total is 6.19 sq mi (DSA adds 1.39). Nothing establishes that the 11 and 13.7 sq mi figures describe the same polygons, so the build is left at 6.19.', variants: ohare };
  return out;
}

const stripPer = per => per.map(p => ({
  start: p.start, era: p.era, holdout: p.holdout,
  recordedMG: r4(p.recordedMG), passedMG: Math.round(p.passedMG), ratio: r4(p.ratio),
  csoMG: Math.round(p.csoMG), peakPooledMG: Math.round(p.peakPooledMG),
  majewskiFillLogged: p.majewskiFillLogged, majewskiPeakMG: Math.round(p.majewskiPeakMG),
  stations: p.stations,
  groups: Object.fromEntries(Object.entries(p.groups).map(([g, v]) =>
    [g, { modelMG: Math.round(v.mod), recordedMG: r4(v.rec), ratio: r4((v.mod + GROUP_FLOOR) / (v.rec + GROUP_FLOOR)) }])),
}));

// ---------------------------------------------------------- timing check

/** MWRD's CSO Event Synopsis Report gives every tide gate's open and close
 *  time (2016-04-01 on), so for 2017-10-14 and 2020-05-14 the model's CSO
 *  window per basin can be set beside the gates'. Raw pulls are cached by
 *  scripts/build_validation.py; without them this section is skipped. */
function timing(env, params) {
  const dir = process.env.CSO_DIR || path.join(process.env.STORM_SCRATCH || '', 'valext', 'cso');
  if (!process.env.STORM_SCRATCH && !process.env.CSO_DIR) return { skipped: 'set STORM_SCRATCH (as for scripts/build_validation.py) or CSO_DIR to the cached synopsis CSVs' };
  if (!fs.existsSync(dir)) return { skipped: `no cached synopsis CSVs at ${dir}` };
  const basinOf = plant => /Racine|Westchester|Stickney/.test(plant) ? 'CENTRAL'
    : /North Branch|OBrien/.test(plant) ? 'NORTH' : /Calumet|95th|122nd|125th/.test(plant) ? 'SOUTH'
    : /Kirie/.test(plant) ? 'OHARE' : null;             // "Lake Michigan" = the reversal gates
  const parse = s => { const m = s.trim().match(/^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+) (AM|PM)$/); if (!m) return null;
    let h = +m[4] % 12; if (m[7] === 'PM') h += 12; return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +m[6])); };
  const out = { source: 'MWRD CSO Event Synopsis Report, https://apps.mwrd.org/csoreports/ (per-gate open/close times; raw CSVs as cached by scripts/build_validation.py)',
    note: 'Times are local clock time on both sides (the storms\' gauges and MWRD\'s report are both America/Chicago). Model CSO = frames[].basins[b].cso > 1 MGD. Gate-hours = summed open duration of every tide gate whose plant maps to the basin; "Lake Michigan" gates (the reversal structures) are left out. The reaches are MWRD\'s; the plant-to-basin mapping is this script\'s.', storms: {} };
  for (const st of env.storms.filter(s => ['2017-10-14', '2020-05-14'].includes(s.start))) {
    const t0 = new Date(st.t0 + 'Z');
    const hr = d => (d - t0) / 3.6e6;
    const gates = { CENTRAL: [], NORTH: [], SOUTH: [], OHARE: [] };
    const d0 = new Date(Date.UTC(+st.start.slice(0, 4), +st.start.slice(5, 7) - 1, +st.start.slice(8, 10)));
    for (let k = -1; k <= 10; k++) {
      const d = new Date(d0.getTime() + k * 864e5);
      const f = path.join(dir, `${d.getUTCMonth() + 1}-${d.getUTCDate()}-${d.getUTCFullYear()}.csv`);
      if (!fs.existsSync(f)) continue;
      let mode = null;
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const r = line.match(/("[^"]*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '').replace(/^"|"$/g, ''));
        if (r[0] === 'TARP_CONNECTION') { mode = 'gate'; continue; }
        if (mode !== 'gate' || r.length < 7 || !r[5] || !r[6]) continue;
        const b = basinOf(r[4] || ''), a = parse(r[5]), z = parse(r[6]);
        if (b && a && z) gates[b].push([hr(a), hr(z)]);
      }
    }
    // the model's CSO window per basin: first and last step above 1 MGD, and
    // the volume-weighted centroid
    const modelTimes = rk => {
      const r = env.model.run(Object.assign({ hyeto: st, config: st.era }, FIXED, params, rk ? { routeK: rk } : {}));
      return Object.fromEntries(['CENTRAL', 'NORTH', 'SOUTH', 'OHARE'].map(b => {
        const on = r.frames.filter(f => f.t >= st.leadHr && f.basins[b].cso > 1);
        const mv = on.reduce((acc, f) => acc + f.basins[b].cso, 0);
        return [b, { start: on.length ? on[0].t : null, end: on.length ? on[on.length - 1].t : null,
                     centroid: mv > 0 ? r4(on.reduce((acc, f) => acc + f.basins[b].cso * f.t, 0) / mv) : null }];
      }));
    };
    const m = modelTimes(null);
    const RK = [0.5, 1, 1.5, 2.5, 4];
    const sweep = RK.map(rk => ({ routeK: rk, basins: modelTimes(rk) }));
    const rec = {};
    for (const b of ['CENTRAL', 'NORTH', 'SOUTH', 'OHARE']) {
      const inStorm = gates[b].filter(([a]) => a >= st.leadHr);         // the lead-in week had its own event
      const gh = inStorm.reduce((acc, [a, z]) => acc + (z - a), 0);
      // gate-hour centroid: when the basin's outfalls were, on balance, open
      const cen = gh > 0 ? inStorm.reduce((acc, [a, z]) => acc + (z - a) * (a + z) / 2, 0) / gh : null;
      rec[b] = {
        gates: inStorm.length, gateHours: r4(gh),
        firstOpenHr: inStorm.length ? r4(Math.min(...inStorm.map(g => g[0]))) : null,
        lastCloseHr: inStorm.length ? r4(Math.max(...inStorm.map(g => g[1]))) : null,
        gateCentroidHr: cen == null ? null : r4(cen),
        modelStartHr: m[b].start, modelEndHr: m[b].end, modelCentroidHr: m[b].centroid,
      };
      if (m[b].start != null && rec[b].firstOpenHr != null) {
        // how much of the logged gate time came before the model spilled at all
        rec[b].gateHoursBeforeModelStart = r4(inStorm.reduce((acc, [a, z]) => acc + Math.max(0, Math.min(z, m[b].start) - a), 0));
        rec[b].gatesOpenedBeforeModelStart = inStorm.filter(([a]) => a < m[b].start).length;
        rec[b].startLagHr = r4(m[b].start - rec[b].firstOpenHr);
        rec[b].centroidLagHr = r4(m[b].centroid - cen);
        // which routeK would put the model's centroid on the gates'? read off
        // the sweep by linear interpolation; null if no value in range does
        const lag = sweep.map(s => s.basins[b].centroid == null ? null : s.basins[b].centroid - cen);
        rec[b].centroidLagByRouteK = RK.map((rk, i) => [rk, lag[i] == null ? null : r4(lag[i])]);
        let implied = null;
        for (let i = 1; i < RK.length; i++) {
          if (lag[i - 1] == null || lag[i] == null) continue;
          if ((lag[i - 1] <= 0 && lag[i] >= 0) || (lag[i - 1] >= 0 && lag[i] <= 0)) {
            implied = lag[i] === lag[i - 1] ? RK[i] : r4(RK[i - 1] + (RK[i] - RK[i - 1]) * (0 - lag[i - 1]) / (lag[i] - lag[i - 1]));
            break;
          }
        }
        rec[b].impliedRouteK = implied;
      }
    }
    out.storms[st.start] = { t0: st.t0, leadHr: st.leadHr, basins: rec };
  }
  out.note += ' impliedRouteK is where the model\'s centroid lag crosses zero across routeK 0.5-4 h with everything else fixed (null: no value in that range closes it). It is reported, never adopted: two storms, and the model\'s overflow only starts once a tunnel is full, so its timing is not the routing\'s alone.';
  return out;
}

// ---------------------------------------------------------------- main side

async function main() {
  const quick = process.argv.includes('--quick');
  const outArg = process.argv.indexOf('--out');
  const outPath = path.resolve(ROOT, outArg > 0 ? process.argv[outArg + 1] : 'map-data/calibration.json');
  const env = await loadEnv();
  const { storms, D } = env;
  const all = storms.map(s => s.start);
  const cal = all.filter(s => !HOLDOUT.includes(s));
  const pick = ss => storms.filter(s => ss.includes(s.start));
  const lanes = Math.max(2, (await import('node:os')).cpus().length - 1);
  const logged = loggedStations(D);
  if (logged.slice().sort().join() !== Object.values(GROUPS).flat().sort().join())
    throw new Error(`logged stations ${logged} do not match the basin groups`);

  console.log(`calibration storms: ${cal.length}   hold-out: ${HOLDOUT.join(', ')}   lanes: ${lanes}${quick ? '   (QUICK budget)' : ''}`);
  console.log('held fixed, and why:');
  for (const [k, v] of Object.entries(FIXED)) console.log(`  ${k} = ${v}: ${FIXED_WHY[k]}`);

  // --- 1. structure --------------------------------------------------------
  const t0 = Date.now();
  const struct = structural(env);
  console.log(`\nstructural candidates, each alone, at the default parameters (${((Date.now() - t0) / 1000).toFixed(0)} s):`);
  printSummary(struct.at64c9816);
  for (const c of struct.candidates) {
    printSummary(c);
    if (c.may2020) console.log(`      May 2020 [as built, without]: Central ${c.may2020.centralMG.join(' / ')} MG (logged ${c.may2020.recordedCentralMG}), North ${c.may2020.northMG.join(' / ')} MG (logged ${c.may2020.recordedNorthMG}); first Central overflow at ${c.may2020.firstCentralOverflowHr.join(' / ')} h`);
  }
  console.log('\nRacine Avenue PS, logged volume / all the rain on its 30 sq mi: ' + struct.setAside.racineArea.storms.map(r => `${r[0]} ${r[3].toFixed(2)}`).join('  '));
  console.log('\nrelief split inside each basin, ten storms (capacity share / logged share):');
  for (const [b, rows] of Object.entries(struct.reliefSplit.basins))
    console.log(`  ${b.padEnd(8)} ` + rows.map(x => `${x.station} ${(100 * x.capacityShare).toFixed(0)}% / ${x.logged ? (100 * x.loggedShare).toFixed(1) + '%' : 'not logged'}`).join('   '));
  console.log('\nO\'Hare basin area vs Majewski fill events (MWRD: any storage is a fill event):');
  for (const v of struct.ohare.variants)
    console.log(`  ${String(v.areaSqMi).padStart(5)} sq mi  hits ${v.hits}/${v.logged}  false alarms ${v.falseAlarms}/${v.loggedNone}  May 2020 peak ${v.may2020PeakMG} MG (recorded ${v.may2020RecordedMG})   [${v.source}]`);

  // --- 2. the fit; alongside it, the one-constant-C variant (section 6) ---
  const B = quick ? { nSeeds: 6, maxEval: 40 } : { nSeeds: 12, maxEval: 160 };
  const t1 = Date.now();
  const jobs = [];
  const nJobs = quick ? 3 : 5;
  for (let i = 0; i < nJobs; i++) jobs.push({ tag: `fit:lhs${i}`, stormStarts: cal, nSeeds: B.nSeeds, nStarts: 1, maxEval: B.maxEval, seed: 1000 + i });
  jobs.push({ tag: 'fit:defaults', stormStarts: cal, starts: [DEFAULTS], maxEval: B.maxEval, seed: 999 });
  const cGrid = quick ? [0.3, 0.45, 0.6] : [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
  jobs.push({ tag: 'const:cal', kind: 'const', stormStarts: cal, grid: cGrid });
  for (const s of all) jobs.push({ tag: `const:${s}`, kind: 'const', stormStarts: all.filter(o => o !== s), grid: cGrid });
  const phaseA = await runWorkers(jobs, lanes);
  const untag = (list, pre) => list.filter(f => f.tag.startsWith(pre)).map(f => Object.assign(f, { tag: f.tag.slice(pre.length) }));
  const fits = untag(phaseA, 'fit:').sort((a, b) => a.J - b.J);
  const constFits = untag(phaseA, 'const:');
  const best = fits[0];
  console.log(`\nfit (${((Date.now() - t1) / 1000).toFixed(0)} s), best of ${fits.length} starts:`);
  for (const f of fits) console.log(`  ${f.tag.padEnd(9)} J ${f.J.toFixed(4)}  ${JSON.stringify(named(f.params))}`);
  const bounds = atBounds(best.params);

  const dCal = score(env, DEFAULTS, pick(cal)), sCal = score(env, best.params, pick(cal));
  const dAll = score(env, DEFAULTS, storms), sAll = score(env, best.params, storms);

  // --- 3. hold-out -----------------------------------------------------------
  const ho = s => s.per.filter(p => p.holdout);
  const holdout = {
    storms: HOLDOUT,
    fitted: { rmsLog: r4(rms(ho(sAll).map(p => p.logRatio))), ratios: ho(sAll).map(p => [p.start, r4(p.ratio)]) },
    defaults: { rmsLog: r4(rms(ho(dAll).map(p => p.logRatio))), ratios: ho(dAll).map(p => [p.start, r4(p.ratio)]) },
  };

  // --- 4 and 5 share one pool: leave-one-out folds and the profiles ---------------
  const t2 = Date.now();
  const looJobs = all.map((s, i) => ({ tag: `loo:${s}`, stormStarts: all.filter(o => o !== s), starts: [best.params, DEFAULTS],
    maxEval: quick ? 30 : 100, seed: 2000 + i }));
  // profiles: each parameter pinned across its whole range, the other two refitted
  const grids = quick
    ? { runoffC: [0.05, 0.3, 0.5, 0.6], runoffMax: [0.3, 0.5, 0.7, 0.9], amcK: [0.3, 2.5, 10] }
    : { runoffC: [0.05, 0.1, 0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6],
        runoffMax: [0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.9],
        amcK: [0.3, 0.5, 1, 2.5, 5, 10] };
  const profJobs = [];
  for (const [name, grid] of Object.entries(grids))
    grid.forEach(v => profJobs.push({ tag: `prof:${name}=${v}`, stormStarts: cal, fixed: { [name]: v },
      starts: [best.params], nSeeds: quick ? 2 : 3, nStarts: 1, maxEval: quick ? 25 : 70, seed: 3000 + profJobs.length }));
  const phaseB = await runWorkers(looJobs.concat(profJobs), lanes);
  const looFits = untag(phaseB, 'loo:'), profFits = untag(phaseB, 'prof:');
  console.log(`\nleave-one-out folds and profiles: ${((Date.now() - t2) / 1000).toFixed(0)} s`);
  const loo = looFits.map(f => {
    const held = score(env, f.params, pick([f.tag])).per[0];
    return { start: f.tag, params: named(f.params), atBounds: atBounds(f.params).map(b => `${b.param} ${b.at.split(' ')[0]}`),
             ratio: r4(held.ratio), logRatio: r4(held.logRatio) };
  }).sort((a, b) => all.indexOf(a.start) - all.indexOf(b.start));
  const looRms = rms(loo.map(l => l.logRatio)), looDefRms = rms(dAll.per.map(p => p.logRatio));
  console.log(`leave-one-out: RMS log ${looRms.toFixed(4)}  (defaults on the same ten: ${looDefRms.toFixed(4)})`);

  // --- 5. profiles ------------------------------------------------------------------
  const nCal = cal.length;
  const profiles = {};
  for (const [name, grid] of Object.entries(grids)) {
    // the optimum itself is a point on every profile
    const pts = grid.map(v => {
      const f = profFits.find(x => x.tag === `${name}=${v}`);
      return { value: v, J: r4(f.J), params: named(f.params) };
    }).concat([{ value: r4(best.params[name]), J: r4(best.J), params: named(best.params), optimum: true }])
      .sort((a, b) => a.value - b.value);
    const Jmin = Math.min(...pts.map(p => p.J));
    const iMin = pts.findIndex(p => p.J === Jmin);
    for (const p of pts) { p.dJ = r4(p.J - Jmin); p.dev = r4(2 * nCal * Math.log(p.J / Jmin)); }
    const lo = pts.slice(0, iMin), hi = pts.slice(iMin + 1);
    const inside = pts.filter(p => p.dev <= 3.84);
    profiles[name] = {
      points: pts,
      argmin: pts[iMin].value,
      interiorMinimum: iMin > 0 && iMin < pts.length - 1,
      riseBelow: lo.length ? r4(Math.max(...lo.map(p => p.dJ))) : 0,
      riseAbove: hi.length ? r4(Math.max(...hi.map(p => p.dJ))) : 0,
      approx95: [inside[0].value, inside[inside.length - 1].value],
      approx95Open: [inside[0] === pts[0], inside[inside.length - 1] === pts[pts.length - 1]],
    };
    profiles[name].realMinimum = profiles[name].interiorMinimum && profiles[name].riseBelow >= FLAT && profiles[name].riseAbove >= FLAT;
  }
  // a profile point that beats the fit means the fit stopped short
  const beaten = profFits.filter(f => f.J < best.J - 1e-4).map(f => ({ at: f.tag, J: r4(f.J), params: named(f.params) }));
  if (beaten.length) console.log(`\nWARNING: ${beaten.length} profile point(s) found a lower J than the fit: ${JSON.stringify(beaten)}`);
  console.log('\nprofiles, J with the other two refitted at each point (* = the fit):');
  for (const [name, p] of Object.entries(profiles)) {
    console.log(`  ${name.padEnd(9)} ` + p.points.map(x => `${x.value}${x.optimum ? '*' : ''}:${x.J.toFixed(3)}`).join('  '));
    console.log(`  ${''.padEnd(9)} min at ${p.argmin} (${p.interiorMinimum ? 'interior' : 'at the end of the range'}), rises ${p.riseBelow.toFixed(3)} below / ${p.riseAbove.toFixed(3)} above; approx. 95% interval ${p.approx95[0]}-${p.approx95[1]}${p.approx95Open[0] ? ' (open below)' : ''}${p.approx95Open[1] ? ' (open above)' : ''}; real minimum: ${p.realMinimum ? 'yes' : 'no'}`);
  }

  // --- 6. one constant C, moisture ramp off (fitted in phase A) ----------------------
  const cFit = constFits.find(f => f.tag === 'cal');
  const cParams = { runoffC: cFit.c, runoffMax: cFit.c, amcK: 0 };
  const cAll = score(env, cParams, storms);
  const cLoo = all.map(s => { const f = constFits.find(x => x.tag === s);
    const held = score(env, { runoffC: f.c, runoffMax: f.c, amcK: 0 }, pick([s])).per[0];
    return { start: s, c: r4(f.c), ratio: r4(held.ratio), logRatio: r4(held.logRatio) }; });
  const cJmin = Math.min(cFit.J, ...cFit.grid.map(g => g.J));
  const amcOff = {
    note: 'NOT a candidate for adoption under the rule above, and reported because the three-parameter fit collapses onto it: runoffMax = runoffC switches the antecedent-moisture ramp off. sim.js\'s own switch for that is amcK = 0.',
    c: r4(cFit.c), J: r4(cFit.J), gmeanRatio: r4(cAll.gmean),
    holdout: { rmsLog: r4(rms(ho(cAll).map(p => p.logRatio))), ratios: ho(cAll).map(p => [p.start, r4(p.ratio)]) },
    leaveOneOut: { rmsLog: r4(rms(cLoo.map(l => l.logRatio))), folds: cLoo },
    profile: cFit.grid.concat([{ c: cFit.c, J: cFit.J, optimum: true }]).sort((a, b) => a.c - b.c)
      .map(g => Object.assign({ c: r4(g.c), J: r4(g.J), dJ: r4(g.J - cJmin) }, g.optimum ? { optimum: true } : {})),
    byGroup: summarise('', cAll).byGroup,
  };
  console.log(`\nconstant C (moisture ramp off): C = ${amcOff.c}  J ${amcOff.J}  hold-out RMS log ${amcOff.holdout.rmsLog}  LOO RMS log ${amcOff.leaveOneOut.rmsLog}`);
  console.log('  profile ' + amcOff.profile.map(p => `${p.c}:${p.J.toFixed(3)}`).join('  '));

  // --- 7. tables --------------------------------------------------------------
  printPerStorm('before: the defaults on the build as committed here   (* = hold-out)', dAll.per);
  printPerStorm('after: the three-parameter fit', sAll.per);
  const byGroup = Object.fromEntries(Object.keys(GROUPS).map(g => [g, {
    meanLogBefore: r4(dAll.byGroup[g].meanLog), meanLogAfter: r4(sAll.byGroup[g].meanLog),
    rmsBefore: r4(dAll.byGroup[g].rmsLog), rmsAfter: r4(sAll.byGroup[g].rmsLog),
    meanLogAt64c9816: struct.at64c9816.byGroup[g].meanLog, rmsAt64c9816: struct.at64c9816.byGroup[g].rmsLog }]));
  console.log('\nresiduals by basin group, mean log(model/recorded) over ten storms:');
  for (const [g, v] of Object.entries(byGroup))
    console.log(`  ${g.padEnd(8)} at 64c9816 ${v.meanLogAt64c9816 >= 0 ? '+' : ''}${v.meanLogAt64c9816.toFixed(3)}   defaults now ${v.meanLogBefore >= 0 ? '+' : ''}${v.meanLogBefore.toFixed(3)}   fitted ${v.meanLogAfter >= 0 ? '+' : ''}${v.meanLogAfter.toFixed(3)}   (RMS ${v.rmsAt64c9816.toFixed(3)} -> ${v.rmsBefore.toFixed(3)} -> ${v.rmsAfter.toFixed(3)})`);
  const majewski = {
    definition: 'fill = any stored volume above 1 MG (MWRD logs a fill event whenever the reservoir stores combined sewage)',
    loggedFills: dAll.per.filter(p => p.majewskiFillLogged === true).length,
    hitsBefore: dAll.per.filter(p => p.majewskiFillLogged === true && p.majewskiPeakMG > 1).length,
    hitsAfter: sAll.per.filter(p => p.majewskiFillLogged === true && p.majewskiPeakMG > 1).length,
    falseAlarmsBefore: dAll.per.filter(p => p.majewskiFillLogged === false && p.majewskiPeakMG > 1).length,
    falseAlarmsAfter: sAll.per.filter(p => p.majewskiFillLogged === false && p.majewskiPeakMG > 1).length,
    peaks: dAll.per.map((p, i) => ({ start: p.start, logged: p.majewskiFillLogged, recordedMG: p.majewskiRecordedPeakMG,
      beforeMG: Math.round(p.majewskiPeakMG), afterMG: Math.round(sAll.per[i].majewskiPeakMG) })),
  };

  // --- 8. timing (optional) -----------------------------------------------------
  let tm;
  try { tm = timing(env, DEFAULTS); } catch (e) { tm = { skipped: `failed: ${e.message}` }; }
  if (tm.skipped) console.log(`\ntiming check skipped: ${tm.skipped}`);
  else {
    console.log('\ntiming, hours from t0 (defaults): model CSO window vs the tide gates MWRD logged');
    for (const [s, v] of Object.entries(tm.storms))
      for (const [b, x] of Object.entries(v.basins))
        console.log(`  ${s} ${b.padEnd(8)} gates ${String(x.gates).padStart(3)} (${x.gateHours.toFixed(0).padStart(4)} gate-h)  first open ${x.firstOpenHr ?? '-'}  centroid ${x.gateCentroidHr ?? '-'}  last close ${x.lastCloseHr ?? '-'}  |  model ${x.modelStartHr ?? '-'} .. ${x.modelEndHr ?? '-'}  centroid ${x.modelCentroidHr ?? '-'}  |  lag start ${x.startLagHr ?? '-'}  centroid ${x.centroidLagHr ?? '-'}` +
          (x.gateHoursBeforeModelStart != null ? `  |  ${(100 * x.gateHoursBeforeModelStart / x.gateHours).toFixed(0)}% of gate-hours before the model spills; routeK that closes the centroid lag: ${x.impliedRouteK ?? 'none in 0.5-4 h'}` : ''));
  }

  // --- 9. verdict -----------------------------------------------------------------
  const betterHoldout = holdout.fitted.rmsLog < holdout.defaults.rmsLog;
  const betterLoo = looRms < looDefRms;
  const noBounds = bounds.length === 0;
  const realMin = Object.values(profiles).every(p => p.realMinimum);
  const reasons = [];
  if (!betterHoldout) reasons.push(`hold-out gets worse: RMS log ${holdout.defaults.rmsLog} -> ${holdout.fitted.rmsLog}`);
  if (!betterLoo) reasons.push(`leave-one-out gets worse: RMS log ${r4(looDefRms)} -> ${r4(looRms)}`);
  for (const b of bounds) reasons.push(`${b.param} rests on its ${b.at} bound (${b.value})`);
  for (const [n, p] of Object.entries(profiles)) if (!p.realMinimum) {
    const span = Math.max(...p.points.map(x => x.dJ));
    reasons.push(span < FLAT
      ? `${n} is unidentified: its profile is flat, J varying by ${span} across ${p.points[0].value}-${p.points[p.points.length - 1].value}`
      : !p.interiorMinimum ? `${n}'s profile has its best at the end of its range (${p.argmin})`
      : `${n}'s profile rises only ${p.riseBelow} below and ${p.riseAbove} above its best`);
  }
  const adopted = betterHoldout && betterLoo && noBounds && realMin;
  const date = new Date().toISOString().slice(0, 10);
  const verdict = {
    adopted, betterHoldout, betterLoo, noParameterOnABound: noBounds, profilesShowRealMinimum: realMin, reasons,
    viewerNote: adopted
      ? `Calibrated on ${cal.length} storms ${date}; hold-out ${holdout.fitted.ratios.map(([, v]) => v.toFixed(2)).join(' and ')}x of MWRD's log.`
      : `Defaults are hand-set: a fit to ${cal.length} recorded storms (${date}) was declined because ${bounds.some(b => b.param === 'runoffMax' && b.at.startsWith('lower')) ? 'it switched the antecedent-moisture ramp off (runoffMax = runoffC) and left amcK unconstrained' : reasons[0]}. See map-data/calibration.json.`,
  };
  console.log(`\nfitted ${JSON.stringify(named(best.params))}   on a bound: ${bounds.length ? bounds.map(b => `${b.param} (${b.at.split(' ')[0]})`).join(', ') : 'none'}`);
  console.log(`J calibration ${dCal.J.toFixed(4)} -> ${sCal.J.toFixed(4)}   hold-out RMS log ${holdout.defaults.rmsLog} -> ${holdout.fitted.rmsLog}   LOO RMS log ${looDefRms.toFixed(4)} -> ${looRms.toFixed(4)}`);
  console.log(`ADOPTED: ${adopted ? 'yes' : 'no'}`);
  for (const r of reasons) console.log(`  - ${r}`);

  // --- 10. the record: keep the first attempt verbatim under `previous` -----------
  let previous = null;
  if (fs.existsSync(outPath)) {
    const old = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    previous = old.attempt >= 2 ? old.previous : old;
  }
  const rec = {
    generated: date, attempt: 2,
    script: 'scripts/calibrate.mjs',
    model: 'assets/js/system3d/sim.js SewerModel.run',
    what: 'Structural causes of the basin-by-basin residuals tested one at a time, then runoffC, runoffMax and amcK fitted to MWRD pumping-station discharge (six logged stations) with reliefFactor and routing held fixed. Areas, plant and pump capacities and storage volumes are sourced and are not fitted.',
    verdict,
    structural: struct,
    fixed: Object.fromEntries(Object.entries(FIXED).map(([k, v]) => [k, { value: v, why: FIXED_WHY[k] }])),
    bounds: { runoffC: BOUNDS.runoffC, runoffMax: ['runoffC', BOUNDS.runoffMax[1]], amcK: BOUNDS.amcK },
    objective: {
      primary: 'RMS over storms of log(modelled / recorded), six logged stations, counted over the log\'s own window (storm start to two days after it ends)',
      secondary: `RMS over (storm x basin group) of log((model+${GROUP_FLOOR})/(recorded+${GROUP_FLOOR})), groups ${JSON.stringify(GROUPS)}`,
      weightOnSecondary: W_STATION,
      notInObjective: 'Majewski fill events (the O\'Hare basin alone feeds it); reported as a diagnostic.',
    },
    storms: { all, calibration: cal, holdout: HOLDOUT,
              holdoutChosen: 'Chosen before fitting, and the same pair as the first attempt: one spring and one summer storm, neither the largest nor the smallest nor the known outlier.' },
    defaults: { params: named(DEFAULTS), J: r4(dCal.J), primary: r4(dCal.primary), secondary: r4(dCal.secondary),
                gmeanRatio: r4(dAll.gmean), rmsLogAll: r4(rms(dAll.per.map(p => p.logRatio))), perStorm: stripPer(dAll.per) },
    fitted: { params: named(best.params), atBounds: bounds, J: r4(sCal.J), primary: r4(sCal.primary), secondary: r4(sCal.secondary),
              gmeanRatio: r4(sAll.gmean), rmsLogAll: r4(rms(sAll.per.map(p => p.logRatio))), perStorm: stripPer(sAll.per),
              starts: fits.map(f => ({ tag: f.tag, J: r4(f.J), params: named(f.params) })) },
    holdout,
    leaveOneOut: { rmsLogFitted: r4(looRms), rmsLogDefaults: r4(looDefRms), folds: loo },
    profiles: Object.assign({ method: `Each parameter pinned at every grid value and the other two refitted on the ${nCal} calibration storms. dev = 2n ln(J/Jmin), n = ${nCal}: treating J as a residual standard deviation, dev <= 3.84 is a rough 95% interval. A "real minimum" is an interior minimum with J rising at least ${FLAT} on both sides.`,
      beatenByProfile: beaten }, profiles),
    amcOff,
    residualsByGroup: byGroup,
    majewski,
    timing: tm,
    previous,
  };
  fs.writeFileSync(outPath, JSON.stringify(rec, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, outPath)}`);
}

if (isMainThread) await main();
