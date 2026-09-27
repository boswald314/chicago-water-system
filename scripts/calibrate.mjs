#!/usr/bin/env node
/* Fit the assumed hydrology parameters of assets/js/system3d/sim.js against
 * MWRD's recorded pumping-station discharge for the ten storms in
 * map-data/storms.json.
 *
 *   node scripts/calibrate.mjs [--quick] [--out map-data/calibration.json]
 *
 * WHAT IS FITTED, and only this: runoffC, runoffMax, amcK, routeK,
 * reliefFactor and the integer routeN. Areas, plant and pump capacities,
 * reservoir and tunnel storage and the basin-to-tunnel routing are sourced
 * numbers and are never touched.
 *
 * OBJECTIVE
 *   primary   RMS over storms of log(modelled passed / recorded passed).
 *             Log space so that 2x too much and half too little cost the
 *             same; the recorded totals span 1.7-7.5 BG, so an absolute
 *             residual would be a fit to September 2008 alone.
 *   secondary RMS over (storm x station group) of the same log residual,
 *             weighted W_STATION. The two big groups -- Racine (+Westchester)
 *             on the Central basin and North Branch (+Wilmette) on the North
 *             -- carry ~85% of the logged volume, so a fit on the system
 *             total alone can be right for the wrong reason: too much North
 *             cancelling too little Central. Stations are aggregated to the
 *             basin they drain because the split between stations inside a
 *             basin is the model's own capacity-share assumption, not a
 *             measurement, and should not be scored as if it were data.
 *             A 25 MG floor keeps a group that logged nothing finite.
 *
 * Deliberately NOT in the objective: a penalty for missing a Majewski fill
 * event. Majewski is fed by the O'Hare/UDP basin alone; a global runoff
 * coefficient cannot fill it without drowning the other four basins, so
 * putting it in the objective would buy a basin-specific fix with a
 * system-wide error. It is reported as a diagnostic instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');

/* Held out BEFORE fitting, and not on the basis of fit: one spring storm and
 * one summer storm, neither the largest (2020-05-14) nor the smallest
 * (2009-06-16) nor the known outlier (2010-07-23). */
const HOLDOUT = ['2013-04-15', '2014-08-21'];

const BOUNDS = [
  ['runoffC',      0.15, 0.60],
  ['dMax',         0.00, 0.75],   // runoffMax = min(0.9, runoffC + dMax)
  ['amcK',         0.50, 8.00],
  ['routeK',       0.50, 6.00],
  ['reliefFactor', 1.00, 4.00],
];
const ROUTE_N = [1, 2, 3];
const DEFAULT_X = [0.32, 0.30, 2.5, 1.5, 1.5];
const DEFAULT_N = 2;

const GROUPS = {
  CENTRAL: ['ps-racine', 'ps-westchester'],
  NORTH:   ['ps-north-branch', 'ps-wilmette'],
  SOUTH:   ['ps-95th', 'ps-122nd', 'ps-125th'],
};

/* summary.passedMG sums SEVEN stations, but MWRD's discharge log
 * (data/mwrd-ps-cso-activity.csv, and CSO_STATION in scripts/build_storms.py)
 * carries SIX: Wilmette PS is not in it. Wilmette is the North Shore Channel
 * controlling works -- lake-diversion screw pumps and reversal gates at the
 * head of the channel -- not a combined-sewer relief station, so it has no CSO
 * row to compare against. The model nonetheless gives the North basin
 * 1115 + 646 MGD of relief capacity and sends 646/1761 = 37% of the North's
 * discharge down it, which lands in passedMG with nothing on the other side of
 * the comparison. The fit below uses passedMG as specified, and then repeats
 * itself over the six logged stations alone to show what that costs. */
const LOGGED_STATIONS = ['ps-racine', 'ps-north-branch', 'ps-95th', 'ps-122nd', 'ps-125th', 'ps-westchester'];
const STATION_SETS = {
  passedMG: null,                 // every station, i.e. summary.passedMG as it stands
  loggedSix: LOGGED_STATIONS,
};
const GROUP_FLOOR = 25;      // MG, so a group that logged nothing stays finite
const W_STATION = 0.35;

const clampX = x => x.map((v, i) => Math.min(BOUNDS[i][2], Math.max(BOUNDS[i][1], v)));
const toOpts = (x, routeN) => ({
  runoffC: x[0], runoffMax: Math.min(0.9, x[0] + x[1]),
  amcK: x[2], routeK: x[3], routeN, reliefFactor: x[4],
});
const named = (x, routeN) => {
  const o = toOpts(x, routeN);
  return { runoffC: r4(o.runoffC), runoffMax: r4(o.runoffMax), amcK: r4(o.amcK),
           routeN, routeK: r4(o.routeK), reliefFactor: r4(o.reliefFactor) };
};
const r4 = v => Math.round(v * 10000) / 10000;
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(a.length, 1));

// ---------------------------------------------------------------- model env

async function loadEnv() {
  global.window = {};
  const src = fs.readFileSync(path.join(ROOT, 'map-data/system3d.js'), 'utf8')
    .replace('window.SYS3D =', 'global.__D =');
  (0, eval)(src);
  const D = global.__D;
  const storms = JSON.parse(fs.readFileSync(path.join(ROOT, 'map-data/storms.json'), 'utf8')).storms;
  const sim = await import(path.join(ROOT, 'assets/js/system3d/sim.js'));
  return { D, storms, model: new sim.SewerModel(D) };
}

/** Run one parameter set over a list of storms and score it. `only` restricts
 *  which stations count as modelled discharge; null means all of them. */
function score(model, x, routeN, storms, only = null) {
  const keep = id => !only || only.includes(id);
  const per = [];
  for (const st of storms) {
    const r = model.run(Object.assign({ hyeto: st, config: st.era }, toOpts(x, routeN)));
    const s = r.summary;
    const passedMG = only
      ? only.reduce((a, id) => a + (s.passedByStation[id] || 0), 0)
      : s.passedMG;
    const groups = {};
    for (const [g, all] of Object.entries(GROUPS)) {
      const ids = all.filter(keep);
      if (!ids.length) continue;
      const mod = ids.reduce((a, id) => a + (s.passedByStation[id] || 0), 0);
      const rec = ids.reduce((a, id) => a + ((st.recordedCsoMG || {})[id] || 0), 0);
      groups[g] = { mod, rec, logRatio: Math.log((mod + GROUP_FLOOR) / (rec + GROUP_FLOOR)) };
    }
    const maj = (((st.observed || {}).reservoirs || {})['res-majewski']) || {};
    per.push({
      start: st.start, era: st.era, holdout: HOLDOUT.includes(st.start),
      passedMG, recordedMG: st.recordedTotalMG,
      ratio: passedMG / Math.max(st.recordedTotalMG, 1),
      logRatio: Math.log(Math.max(passedMG, 1) / Math.max(st.recordedTotalMG, 1)),
      groups, csoMG: s.csoMG, peakPooledMG: s.peakPooledMG,
      majewskiFillLogged: !!maj.fillEvent,
      majewskiPeakFill: s.peakResFill['res-majewski'] || 0,
      stations: Object.fromEntries(Object.entries(s.passedByStation).map(([k, v]) => [k, Math.round(v)])),
    });
  }
  const primary = rms(per.map(p => p.logRatio));
  const gl = [];
  for (const p of per) for (const g of Object.values(p.groups)) gl.push(g.logRatio);
  const secondary = rms(gl);
  return { J: primary + W_STATION * secondary, primary, secondary, per };
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

/** Latin hypercube over the free dimensions. */
function lhs(n, dims, rng) {
  const cols = dims.map(() => {
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    return p;
  });
  return Array.from({ length: n }, (_, i) => dims.map((d, k) => {
    const [, lo, hi] = BOUNDS[d];
    return lo + (hi - lo) * (cols[k][i] + rng()) / n;
  }));
}

/** Nelder-Mead on a box, by projection. f takes a free-dim vector. */
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
    const spread = Math.abs(vals[n] - vals[0]);
    if (spread < 1e-9) break;
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

/** One fit: LHS seeds + Nelder-Mead from the best of them and from any
 *  supplied starts. `fixed` pins parameters by index (for profiling). */
function fitJob(model, storms, { routeN, fixed = {}, nSeeds, nStarts, starts = [], maxEval, seed, only = null }) {
  const free = BOUNDS.map((_, i) => i).filter(i => !(i in fixed));
  const full = fx => { const x = DEFAULT_X.slice(); for (const [i, v] of Object.entries(fixed)) x[+i] = v;
                       free.forEach((d, k) => { x[d] = fx[k]; }); return clampX(x); };
  const f = fx => score(model, full(fx), routeN, storms, only).J;
  const rng = mulberry32(seed);
  const seeds = lhs(nSeeds, free, rng).map(fx => ({ fx, v: f(fx) })).sort((a, b) => a.v - b.v);
  const from = seeds.slice(0, nStarts).map(s => s.fx)
    .concat(starts.map(x => free.map(d => Math.min(BOUNDS[d][2], Math.max(BOUNDS[d][1], x[d])))));
  const steps = free.map(d => 0.12 * (BOUNDS[d][2] - BOUNDS[d][1]));
  let best = null;
  for (const x0 of from) {
    let r = nelderMead(f, x0, steps, maxEval);
    r = nelderMead(f, r.x, steps.map(s => s * 0.25), Math.round(maxEval / 2));   // polish
    if (!best || r.f < best.f) best = r;
  }
  return { routeN, x: full(best.x), J: best.f };
}

// -------------------------------------------------------------- worker side

if (!isMainThread) {
  const env = await loadEnv();
  const pick = starts => env.storms.filter(s => starts.includes(s.start));
  const out = workerData.jobs.map(job => {
    const r = fitJob(env.model, pick(job.stormStarts), job);
    return Object.assign({ tag: job.tag }, r);
  });
  parentPort.postMessage(out);
}

function runWorkers(jobs, lanes) {
  const buckets = Array.from({ length: Math.min(lanes, jobs.length) }, () => []);
  jobs.forEach((j, i) => buckets[i % buckets.length].push(j));
  return Promise.all(buckets.map(bucket => new Promise((res, rej) => {
    const w = new Worker(SELF, { workerData: { jobs: bucket } });
    w.on('message', m => { res(m); w.terminate(); });
    w.on('error', rej);
  }))).then(rs => rs.flat());
}

// ---------------------------------------------------------------- main side

async function main() {
  const quick = process.argv.includes('--quick');
  const outArg = process.argv.indexOf('--out');
  const outPath = path.resolve(ROOT, outArg > 0 ? process.argv[outArg + 1] : 'map-data/calibration.json');

  const env = await loadEnv();
  const { model, storms } = env;
  const all = storms.map(s => s.start);
  const cal = all.filter(s => !HOLDOUT.includes(s));
  const pick = ss => storms.filter(s => ss.includes(s.start));
  const lanes = Math.max(2, (await import('node:os')).cpus().length - 1);

  const budget = quick ? { nSeeds: 16, nStarts: 2, maxEval: 120 } : { nSeeds: 56, nStarts: 3, maxEval: 400 };

  console.log(`calibration storms: ${cal.length}   hold-out: ${HOLDOUT.join(', ')}   lanes: ${lanes}`);

  // --- 1. global fit, one job per routeN, for each station set -------------
  const t0 = Date.now();
  const jobs = [];
  for (const [set, only] of Object.entries(STATION_SETS))
    for (const n of ROUTE_N)
      jobs.push(Object.assign({ tag: `${set}/n${n}`, set, only, routeN: n, stormStarts: cal, seed: 1000 + n }, budget));
  const allFits = await runWorkers(jobs, lanes);
  const fits = allFits.filter(f => f.tag.startsWith('passedMG/')).sort((a, b) => a.J - b.J);
  const best = fits[0];
  console.log(`\nrouteN sweep (${((Date.now() - t0) / 1000).toFixed(0)} s):`);
  for (const f of allFits.sort((a, b) => a.tag.localeCompare(b.tag)))
    console.log(`  ${f.tag.padEnd(14)} J=${f.J.toFixed(4)}  ${JSON.stringify(named(f.x, f.routeN))}`);

  const fitted = named(best.x, best.routeN);
  const sCal = score(model, best.x, best.routeN, pick(cal));
  const sAll = score(model, best.x, best.routeN, storms);
  const dCal = score(model, DEFAULT_X, DEFAULT_N, pick(cal));
  const dAll = score(model, DEFAULT_X, DEFAULT_N, storms);

  // --- 2. hold-out ---------------------------------------------------------
  const hoFit = sAll.per.filter(p => p.holdout);
  const hoDef = dAll.per.filter(p => p.holdout);
  const holdout = {
    storms: HOLDOUT,
    fitted: { rmsLog: rms(hoFit.map(p => p.logRatio)), ratios: hoFit.map(p => [p.start, r4(p.ratio)]) },
    defaults: { rmsLog: rms(hoDef.map(p => p.logRatio)), ratios: hoDef.map(p => [p.start, r4(p.ratio)]) },
  };

  // --- 3. leave-one-out ----------------------------------------------------
  const t1 = Date.now();
  const looJobs = all.map((s, i) => Object.assign({
    tag: s, routeN: best.routeN, stormStarts: all.filter(o => o !== s),
    seed: 2000 + i, starts: [best.x],
  }, quick ? { nSeeds: 8, nStarts: 1, maxEval: 90 } : { nSeeds: 24, nStarts: 2, maxEval: 260 }));
  const looFits = await runWorkers(looJobs, lanes);
  const loo = looFits.map(f => {
    const held = score(model, f.x, f.routeN, pick([f.tag])).per[0];
    return { start: f.tag, x: named(f.x, f.routeN), ratio: r4(held.ratio), logRatio: held.logRatio };
  }).sort((a, b) => all.indexOf(a.start) - all.indexOf(b.start));
  const looRms = rms(loo.map(l => l.logRatio));
  const looDefRms = rms(dAll.per.map(p => p.logRatio));
  console.log(`\nleave-one-out (${((Date.now() - t1) / 1000).toFixed(0)} s): RMS log ${looRms.toFixed(4)}  (defaults on the same ten: ${looDefRms.toFixed(4)})`);

  // --- 4. sensitivity: +-25% on each parameter, refit nothing --------------
  const sens = BOUNDS.map(([name, lo, hi], i) => {
    const row = { param: name, value: r4(best.x[i]), lo, hi };
    for (const [key, k] of [['minus25', 0.75], ['plus25', 1.25]]) {
      const x = best.x.slice(); x[i] = Math.min(hi, Math.max(lo, best.x[i] * k));
      row[key] = { value: r4(x[i]), J: r4(score(model, x, best.routeN, pick(cal)).J) };
      row[key].dJ = r4(row[key].J - sCal.J);
      row[key].clipped = Math.abs(x[i] - best.x[i] * k) > 1e-9;
    }
    return row;
  });
  for (const n of ROUTE_N) if (n !== best.routeN)
    sens.push({ param: 'routeN', value: best.routeN, alt: n,
                J: r4(score(model, best.x, n, pick(cal)).J),
                dJ: r4(score(model, best.x, n, pick(cal)).J - sCal.J) });

  // --- 5. conditioning: numerical Hessian in scaled units ------------------
  // x is rescaled to the unit box first, so "how curved" is comparable across
  // parameters with different units.
  const u = best.x.map((v, i) => (v - BOUNDS[i][1]) / (BOUNDS[i][2] - BOUNDS[i][1]));
  const fu = uu => score(model, clampX(uu.map((v, i) => BOUNDS[i][1] + v * (BOUNDS[i][2] - BOUNDS[i][1]))), best.routeN, pick(cal)).J;
  const h = 0.03, f0 = fu(u), N = 5;
  const H = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    const up = u.slice(), dn = u.slice(); up[i] += h; dn[i] -= h;
    H[i][i] = (fu(up) - 2 * f0 + fu(dn)) / (h * h);
  }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const pp = u.slice(), pm = u.slice(), mp = u.slice(), mm = u.slice();
    pp[i] += h; pp[j] += h; pm[i] += h; pm[j] -= h; mp[i] -= h; mp[j] += h; mm[i] -= h; mm[j] -= h;
    H[i][j] = H[j][i] = (fu(pp) - fu(pm) - fu(mp) + fu(mm)) / (4 * h * h);
  }
  // A parameter the optimiser pushed onto a bound is not a fitted value; the
  // curvature along it is meaningless, because the box, not the data, stopped
  // it. Flag those before reading anything into the Hessian.
  const atBounds = BOUNDS.map(([name, lo, hi], i) => {
    const span = hi - lo;
    return { param: name, value: r4(best.x[i]),
             at: best.x[i] <= lo + 0.005 * span ? 'lower' : best.x[i] >= hi - 0.005 * span ? 'upper' : null };
  }).filter(b => b.at);
  const eig = jacobiEig(H);
  const evs = eig.values.map((v, i) => ({ value: r4(v), vector: eig.vectors[i].map(r4) }))
    .sort((a, b) => b.value - a.value);
  const pos = evs.filter(e => e.value > 0).map(e => e.value);
  const conditioning = {
    note: 'Hessian of J at the optimum, parameters rescaled to their unit box. A near-zero eigenvalue is a direction the data does not constrain. Where a parameter sits on a bound the curvature along it is an artefact of the box, not of the data.',
    order: BOUNDS.map(b => b[0]),
    eigen: evs,
    conditionNumber: pos.length ? r4(Math.max(...pos) / Math.min(...pos)) : null,
    atBounds,
  };

  // --- 6. the runoffC / reliefFactor trade-off, profiled -------------------
  const t2 = Date.now();
  // the full range of runoffC, not a neighbourhood of the optimum: the point
  // is to see how wide the valley is, and 0.32 is the value being replaced
  const grid = [0.15, 0.20, 0.25, 0.32, 0.40, 0.50, 0.60];
  const profJobs = grid.map((v, i) => Object.assign({
    tag: String(v), routeN: best.routeN, stormStarts: cal, fixed: { 0: v },
    seed: 3000 + i, starts: [best.x],
  }, quick ? { nSeeds: 8, nStarts: 1, maxEval: 90 } : { nSeeds: 20, nStarts: 2, maxEval: 220 }));
  const profFits = await runWorkers(profJobs, lanes);
  const profile = profFits.map(f => ({
    runoffC: +f.tag, reliefFactor: r4(f.x[4]), runoffMax: r4(Math.min(0.9, f.x[0] + f.x[1])),
    amcK: r4(f.x[2]), routeK: r4(f.x[3]), J: r4(f.J), dJ: r4(f.J - sCal.J),
  })).sort((a, b) => a.runoffC - b.runoffC);
  console.log(`\nrunoffC profile (${((Date.now() - t2) / 1000).toFixed(0)} s), other parameters re-optimised at each point:`);
  for (const p of profile) console.log(`  runoffC=${p.runoffC.toFixed(3)}  reliefFactor=${p.reliefFactor.toFixed(2)}  runoffMax=${p.runoffMax.toFixed(3)}  J=${p.J.toFixed(4)}  dJ=${p.dJ >= 0 ? '+' : ''}${p.dJ.toFixed(4)}`);

  // --- 7. per-storm table --------------------------------------------------
  console.log('\nstorm       era       recorded   before  ratio     after  ratio    Majewski (logged/model peak)');
  for (let i = 0; i < storms.length; i++) {
    const d = dAll.per[i], f = sAll.per[i];
    console.log(`${d.start}${d.holdout ? ' *' : '  '} ${d.era.padEnd(8)} ${String(Math.round(d.recordedMG)).padStart(8)} ` +
      `${String(Math.round(d.passedMG)).padStart(8)} ${d.ratio.toFixed(2).padStart(6)} ` +
      `${String(Math.round(f.passedMG)).padStart(9)} ${f.ratio.toFixed(2).padStart(6)}    ` +
      `${f.majewskiFillLogged ? 'FILL' : ' -- '} / ${(100 * d.majewskiPeakFill).toFixed(0)}% -> ${(100 * f.majewskiPeakFill).toFixed(0)}%`);
  }
  console.log('  * = hold-out, not used in the fit');
  console.log(`\nfitted ${JSON.stringify(fitted)}`);
  console.log(`J  calibration: ${dCal.J.toFixed(4)} -> ${sCal.J.toFixed(4)}   (primary ${dCal.primary.toFixed(4)} -> ${sCal.primary.toFixed(4)}, station ${dCal.secondary.toFixed(4)} -> ${sCal.secondary.toFixed(4)})`);
  console.log(`hold-out RMS log: ${holdout.defaults.rmsLog.toFixed(4)} -> ${holdout.fitted.rmsLog.toFixed(4)}   ratios ${JSON.stringify(holdout.fitted.ratios)}`);
  console.log(`LOO RMS log:      ${looDefRms.toFixed(4)} -> ${looRms.toFixed(4)}`);

  // --- 8. basin structure of the residuals ---------------------------------
  const byGroup = Object.fromEntries(Object.keys(GROUPS).map(g => {
    const b = dAll.per.map(p => p.groups[g].logRatio), a = sAll.per.map(p => p.groups[g].logRatio);
    return [g, { meanLogBefore: r4(b.reduce((s, v) => s + v, 0) / b.length),
                 meanLogAfter: r4(a.reduce((s, v) => s + v, 0) / a.length),
                 rmsBefore: r4(rms(b)), rmsAfter: r4(rms(a)) }];
  }));
  const majewski = {
    loggedFills: sAll.per.filter(p => p.majewskiFillLogged).length,
    modelFillsBefore: dAll.per.filter(p => p.majewskiFillLogged && p.majewskiPeakFill > 0.5).length,
    modelFillsAfter: sAll.per.filter(p => p.majewskiFillLogged && p.majewskiPeakFill > 0.5).length,
    peaks: sAll.per.map(p => ({ start: p.start, logged: p.majewskiFillLogged,
                                before: r4(dAll.per.find(d => d.start === p.start).majewskiPeakFill),
                                after: r4(p.majewskiPeakFill) })),
  };
  // --- 8b. what the seventh station costs ----------------------------------
  const six = allFits.filter(f => f.tag.startsWith('loggedSix/')).sort((a, b) => a.J - b.J)[0];
  const sixCal = score(model, six.x, six.routeN, pick(cal), LOGGED_STATIONS);
  const sixAll = score(model, six.x, six.routeN, storms, LOGGED_STATIONS);
  const sixDefAll = score(model, DEFAULT_X, DEFAULT_N, storms, LOGGED_STATIONS);
  const sixHo = sixAll.per.filter(p => p.holdout);
  const wilmetteShare = sAll.per.map(p => p.stations['ps-wilmette'] / p.passedMG);
  const stationSets = {
    note: 'summary.passedMG sums seven stations; MWRD logs six. Wilmette PS is the North Shore Channel lake-diversion controlling works, not a CSO relief station, and has no row in data/mwrd-ps-cso-activity.csv -- but the model routes 646/1761 = 37% of the North basin\'s discharge through it and counts it as passed. This is a structural mismatch in the comparison, not a parameter, and it is reported here rather than fixed.',
    wilmetteShareOfPassedMG: { mean: r4(wilmetteShare.reduce((a, v) => a + v, 0) / wilmetteShare.length),
                               min: r4(Math.min(...wilmetteShare)), max: r4(Math.max(...wilmetteShare)) },
    loggedSixFit: {
      params: named(six.x, six.routeN), J: r4(sixCal.J), primary: r4(sixCal.primary), secondary: r4(sixCal.secondary),
      holdoutRmsLog: r4(rms(sixHo.map(p => p.logRatio))),
      defaultsHoldoutRmsLog: r4(rms(sixDefAll.per.filter(p => p.holdout).map(p => p.logRatio))),
      gmeanRatioDefaults: r4(Math.exp(sixDefAll.per.reduce((s, p) => s + p.logRatio, 0) / 10)),
      gmeanRatioFitted: r4(Math.exp(sixAll.per.reduce((s, p) => s + p.logRatio, 0) / 10)),
      ratios: sixAll.per.map(p => [p.start, r4(p.ratio)]),
    },
  };
  console.log(`\nWilmette PS is ${(100 * stationSets.wilmetteShareOfPassedMG.mean).toFixed(0)}% of passedMG on average but has no row in MWRD's log.`);
  console.log(`  over the six logged stations only: defaults gmean ${stationSets.loggedSixFit.gmeanRatioDefaults.toFixed(3)} (vs ${r4(Math.exp(dAll.per.reduce((s, p) => s + p.logRatio, 0) / 10)).toFixed(3)} on all seven); best fit ${JSON.stringify(stationSets.loggedSixFit.params)} J=${sixCal.J.toFixed(4)}, hold-out RMS log ${stationSets.loggedSixFit.defaultsHoldoutRmsLog.toFixed(4)} -> ${stationSets.loggedSixFit.holdoutRmsLog.toFixed(4)}`);

  console.log('\nresiduals by station group (mean log(model/recorded)):');
  for (const [g, v] of Object.entries(byGroup))
    console.log(`  ${g.padEnd(8)} before ${v.meanLogBefore >= 0 ? '+' : ''}${v.meanLogBefore.toFixed(3)}  after ${v.meanLogAfter >= 0 ? '+' : ''}${v.meanLogAfter.toFixed(3)}   (RMS ${v.rmsBefore.toFixed(3)} -> ${v.rmsAfter.toFixed(3)})`);
  console.log(`Majewski fill events logged ${majewski.loggedFills}; model reaches >50% on ${majewski.modelFillsBefore} before, ${majewski.modelFillsAfter} after.`);
  console.log('\nsensitivity (J on the calibration set, nothing refitted):');
  for (const s of sens) {
    if (s.param === 'routeN') { console.log(`  routeN ${s.value} -> ${s.alt}   J ${s.J.toFixed(4)} (${s.dJ >= 0 ? '+' : ''}${s.dJ.toFixed(4)})`); continue; }
    console.log(`  ${s.param.padEnd(13)} ${String(s.value).padStart(7)}   -25% -> ${s.minus25.value} J ${s.minus25.J.toFixed(4)} (${s.minus25.dJ >= 0 ? '+' : ''}${s.minus25.dJ.toFixed(4)})${s.minus25.clipped ? ' [clipped]' : ''}   +25% -> ${s.plus25.value} J ${s.plus25.J.toFixed(4)} (${s.plus25.dJ >= 0 ? '+' : ''}${s.plus25.dJ.toFixed(4)})${s.plus25.clipped ? ' [clipped]' : ''}`);
  }
  console.log(`\nHessian eigenvalues (unit box): ${conditioning.eigen.map(e => e.value.toFixed(3)).join(', ')}   condition number ${conditioning.conditionNumber}`);
  console.log(`parameters resting on a bound: ${atBounds.length ? atBounds.map(b => `${b.param}=${b.value} (${b.at})`).join(', ') : 'none'}`);
  const flat = profile.filter(p => p.dJ <= 0.02);
  if (flat.length > 1)
    console.log(`ridge: J stays within +0.02 of its best over runoffC ${flat[0].runoffC} - ${flat[flat.length - 1].runoffC} (${(flat[flat.length - 1].runoffC / flat[0].runoffC).toFixed(2)}x), reliefFactor ${flat.map(p => p.reliefFactor).join('/')}`);
  const spread = k => { const v = loo.map(l => l.x[k]).sort((a, b) => a - b); return `${v[0]} - ${v[v.length - 1]}`; };
  console.log(`LOO fold spread: runoffC ${spread('runoffC')}, runoffMax ${spread('runoffMax')}, amcK ${spread('amcK')}, routeK ${spread('routeK')}, reliefFactor ${spread('reliefFactor')}`);

  // --- 9. verdict ----------------------------------------------------------
  // Adopt the fit only if it generalises -- better on the two storms held out
  // before fitting AND better under leave-one-out -- and only if the optimiser
  // actually found a minimum rather than being stopped by the edge of the box.
  const betterHoldout = holdout.fitted.rmsLog < holdout.defaults.rmsLog;
  const betterLoo = looRms < looDefRms;
  const onRidge = atBounds.length > 0 || flat.length > 1;
  const reasons = [];
  if (!betterHoldout) reasons.push(`hold-out gets worse: RMS log ${r4(holdout.defaults.rmsLog)} -> ${r4(holdout.fitted.rmsLog)}`);
  if (!betterLoo) reasons.push(`leave-one-out gets worse: RMS log ${r4(looDefRms)} -> ${r4(looRms)}`);
  if (atBounds.length) reasons.push(`${atBounds.length} of ${BOUNDS.length} parameters rest on a bound (${atBounds.map(b => `${b.param} ${b.at}`).join(', ')}): the box stopped the search, not the data`);
  if (flat.length > 1) reasons.push(`runoffC is unidentified over ${flat[0].runoffC}-${flat[flat.length - 1].runoffC} at a cost of under 0.02 in J`);
  const verdict = {
    adopted: betterHoldout && betterLoo && !onRidge,
    betterHoldout, betterLoo, onRidge, reasons,
    viewerNote: (betterHoldout && betterLoo && !onRidge)
      ? `Calibrated on ${cal.length} storms; hold-out ratios ${holdout.fitted.ratios.map(([s, v]) => `${s} ${v.toFixed(2)}`).join(', ')}.`
      : `Tested against ${all.length} recorded storms ${new Date().toISOString().slice(0, 10)}; the fit did not generalise and the defaults were left alone. See map-data/calibration.json.`,
  };
  console.log(`\nADOPTED: ${verdict.adopted ? 'yes' : 'no'}`);
  for (const r of reasons) console.log(`  - ${r}`);

  // --- 10. write the record ------------------------------------------------
  const strip = per => per.map(p => ({
    start: p.start, era: p.era, holdout: p.holdout,
    recordedMG: r4(p.recordedMG), passedMG: Math.round(p.passedMG), ratio: r4(p.ratio),
    csoMG: Math.round(p.csoMG), peakPooledMG: Math.round(p.peakPooledMG),
    majewskiFillLogged: p.majewskiFillLogged, majewskiPeakFill: r4(p.majewskiPeakFill),
    stations: p.stations,
    groups: Object.fromEntries(Object.entries(p.groups).map(([g, v]) =>
      [g, { modelMG: Math.round(v.mod), recordedMG: r4(v.rec), ratio: r4((v.mod + GROUP_FLOOR) / (v.rec + GROUP_FLOOR)) }])),
  }));
  const rec = {
    generated: new Date().toISOString().slice(0, 10),
    script: 'scripts/calibrate.mjs',
    model: 'assets/js/system3d/sim.js SewerModel.run',
    what: 'Assumed hydrology parameters fitted to MWRD pumping-station discharge for ten recorded storms. Areas, plant/pump capacities and storage volumes are sourced and were not touched.',
    verdict,
    objective: {
      primary: 'RMS over storms of log(summary.passedMG / storm.recordedTotalMG)',
      secondary: `RMS over (storm x station group) of log((model+${GROUP_FLOOR})/(recorded+${GROUP_FLOOR})), groups ${JSON.stringify(GROUPS)}`,
      weightOnSecondary: W_STATION,
      notInObjective: 'Majewski fill events: a basin-specific shortfall a global runoff fit cannot address, reported as a diagnostic only.',
    },
    storms: { all, calibration: cal, holdout: HOLDOUT,
              holdoutChosen: 'Chosen before fitting: one spring and one summer storm, neither the largest nor the smallest nor the known outlier.' },
    defaults: { params: named(DEFAULT_X, DEFAULT_N), J: r4(dCal.J), primary: r4(dCal.primary), secondary: r4(dCal.secondary),
                gmeanRatio: r4(Math.exp(dAll.per.reduce((s, p) => s + p.logRatio, 0) / dAll.per.length)),
                rmsLogAll: r4(rms(dAll.per.map(p => p.logRatio))), perStorm: strip(dAll.per) },
    fitted: { params: fitted, J: r4(sCal.J), primary: r4(sCal.primary), secondary: r4(sCal.secondary),
              gmeanRatio: r4(Math.exp(sAll.per.reduce((s, p) => s + p.logRatio, 0) / sAll.per.length)),
              rmsLogAll: r4(rms(sAll.per.map(p => p.logRatio))), perStorm: strip(sAll.per) },
    routeNSweep: allFits.map(f => ({ stationSet: f.tag.split('/')[0], routeN: f.routeN, J: r4(f.J), params: named(f.x, f.routeN) })),
    stationSets,
    holdout, leaveOneOut: { rmsLogFitted: r4(looRms), rmsLogDefaults: r4(looDefRms), folds: loo },
    sensitivity: sens, conditioning, runoffCProfile: profile,
    residualsByGroup: byGroup, majewski,
  };
  fs.writeFileSync(outPath, JSON.stringify(rec, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, outPath)}`);
}

/** Symmetric eigendecomposition, cyclic Jacobi. Five parameters; this is
 *  faster to read than to pull a dependency for. */
function jacobiEig(A0) {
  const n = A0.length;
  const A = A0.map(r => r.slice());
  let V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: A.map((r, i) => r[i]), vectors: A.map((_, i) => V.map(r => r[i])) };
}

if (isMainThread) await main();
