#!/usr/bin/env node
/* One-parameter runoff calibration for the 3D model (assets/js/system3d/sim.js).
 *
 *   node scripts/fit_runoff.mjs            fit, report, and write map-data/calibration.json
 *   node scripts/fit_runoff.mjs --dry-run  fit and report only
 *
 * Fits a constant volumetric runoff coefficient C (the antecedent-moisture ramp
 * switched off, amcK 0) against MWRD's six-station pumping-station discharge log
 * for the ten recorded storms in map-data/storms.json. 2013-04-15 and 2014-08-21
 * are held out, chosen before any fitting; the other eight are fitted. A 10-fold
 * leave-one-out refit shows how much the answer leans on any one storm.
 *
 * Objective, the same form as scripts/calibrate.mjs (the six-knob and three-knob
 * attempts, both declined and kept in calibration.json as `previous`):
 *   J = RMS_storms log(passed / recorded)
 *     + 0.35 * RMS_(storm x basin group) log((model + 25) / (recorded + 25))
 * Basin groups: CENTRAL = Racine + Westchester, NORTH = North Branch,
 * SOUTH = 95th + 122nd + 125th. Relief factor and routing stay at their defaults:
 * a volume metric cannot see timing, and the log cannot see gravity outfalls.
 *
 * Adopted only if: hold-out AND leave-one-out both improve on the hand-set
 * values, the fitted C is not on a bound, and its profile has a real minimum.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = {};
eval(fs.readFileSync(path.join(ROOT, 'map-data/system3d.js'), 'utf8').replace('window.SYS3D =', 'globalThis.__D ='));
const D = globalThis.__D;
const storms = JSON.parse(fs.readFileSync(path.join(ROOT, 'map-data/storms.json'), 'utf8')).storms;
const validation = JSON.parse(fs.readFileSync(path.join(ROOT, 'map-data/storm-validation.json'), 'utf8')).storms;
const { SewerModel } = await import(path.join(ROOT, 'assets/js/system3d/sim.js'));
const model = new SewerModel(D);

const GROUPS = { CENTRAL: ['ps-racine', 'ps-westchester'], NORTH: ['ps-north-branch'], SOUTH: ['ps-95th', 'ps-122nd', 'ps-125th'] };
const HOLD = ['2013-04-15', '2014-08-21'];
const BOUNDS = [0.05, 0.60];
const HAND_SET = { runoffC: 0.32, runoffMax: 0.62, amcK: 2.5 };       // what this calibration replaces
const optsC = C => ({ runoffC: +C.toFixed(4), amcK: 0 });

const cache = new Map();
function evalStorm(st, opts) {
  const key = st.start + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);
  const s = model.run(Object.assign({ hyeto: st, config: st.era }, opts)).summary;
  const sum = (ids, o) => ids.reduce((a, i) => a + (o[i] || 0), 0);
  const r = {
    lr: Math.log(Math.max(s.passedMG, 1e-6) / Math.max(st.recordedTotalMG, 1)),
    gl: Object.values(GROUPS).map(ids => Math.log((sum(ids, s.passedByStation) + 25) / (sum(ids, st.recordedCsoMG) + 25))),
    groups: Object.fromEntries(Object.entries(GROUPS).map(([g, ids]) => [g, { model: +sum(ids, s.passedByStation).toFixed(1), recorded: +sum(ids, st.recordedCsoMG).toFixed(1) }])),
    passedMG: s.passedMG, csoMG: s.csoMG, rainIn: s.rainIn,
    majewskiFill: (s.peakResFill['res-majewski'] || 0) > 0.001,
  };
  cache.set(key, r);
  return r;
}
const rms = a => Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length);
const J = (set, o) => { const ev = set.map(st => evalStorm(st, o)); return rms(ev.map(e => e.lr)) + 0.35 * rms(ev.flatMap(e => e.gl)); };
function fit(set) {
  let best = null;
  for (let C = BOUNDS[0]; C <= BOUNDS[1] + 1e-9; C += 0.025) { const j = J(set, optsC(C)); if (!best || j < best.j) best = { C, j }; }
  let a = Math.max(BOUNDS[0], best.C - 0.025), b = Math.min(BOUNDS[1], best.C + 0.025);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a);
  for (let i = 0; i < 18; i++) { if (J(set, optsC(c)) < J(set, optsC(d))) b = d; else a = c; c = b - g * (b - a); d = a + g * (b - a); }
  const C = (a + b) / 2;
  return { C, j: J(set, optsC(C)) };
}
const rank = a => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = []; idx.forEach(([, i], k) => { r[i] = k + 1; }); return r; };
const spearman = (a, b) => { const ra = rank(a), rb = rank(b), n = a.length; return 1 - 6 * ra.reduce((s, r, i) => s + (r - rb[i]) ** 2, 0) / (n * (n * n - 1)); };

const cal = storms.filter(s => !HOLD.includes(s.start)), hold = storms.filter(s => HOLD.includes(s.start));
const f = fit(cal);
const C = +f.C.toFixed(2);                     // what ships: the slider moves in steps of 0.01
const profile = [];
for (let c = 0.40; c <= 0.60 + 1e-9; c += 0.025) profile.push([+c.toFixed(3), +J(cal, optsC(c)).toFixed(4)]);
const onBound = f.C - BOUNDS[0] < 0.01 || BOUNDS[1] - f.C < 0.01;
const realMin = profile[0][1] > f.j && profile[profile.length - 1][1] > f.j;
const holdRms = o => rms(hold.map(st => evalStorm(st, o).lr));
const loo = storms.map(st => { const fi = fit(storms.filter(x => x !== st)); return { storm: st.start, C: +fi.C.toFixed(3), lrFit: evalStorm(st, optsC(fi.C)).lr, lrHand: evalStorm(st, HAND_SET).lr }; });
const looFit = rms(loo.map(l => l.lrFit)), looHand = rms(loo.map(l => l.lrHand));
const verdict = {
  adopted: holdRms(optsC(C)) < holdRms(HAND_SET) && looFit < looHand && !onBound && realMin,
  betterHoldout: holdRms(optsC(C)) < holdRms(HAND_SET), betterLoo: looFit < looHand, onBound, realMinimum: realMin,
};
const indep = o => {
  const ev = storms.map(st => evalStorm(st, o));
  const rev = storms.map(st => ((validation[st.start] || {}).tarp || {}).reversal ? validation[st.start].tarp.reversal.totalMG || 0 : 0);
  const obs = storms.map(st => (((st.observed || {}).reservoirs || {})['res-majewski'] || {}).fillEvent);
  return {
    spearmanCsoVsLakeReversal: +spearman(ev.map(e => e.csoMG), rev).toFixed(3),
    spearmanRainVsLakeReversal: +spearman(ev.map(e => e.rainIn), rev).toFixed(3),
    majewskiFillEvents: { hit: obs.filter((x, i) => x === true && ev[i].majewskiFill).length, missed: obs.filter((x, i) => x === true && !ev[i].majewskiFill).length,
                          falseAlarm: obs.filter((x, i) => x === false && ev[i].majewskiFill).length, correctNoFill: obs.filter((x, i) => x === false && !ev[i].majewskiFill).length },
  };
};
const gm = o => Math.exp(storms.reduce((a, st) => a + evalStorm(st, o).lr, 0) / storms.length);
verdict.viewerNote = verdict.adopted
  ? `Runoff coefficient ${C} fitted ${new Date().toISOString().slice(0, 10)} to MWRD's log for 8 recorded storms; on the 2 held out beforehand the error fell from ${holdRms(HAND_SET).toFixed(2)} to ${holdRms(optsC(C)).toFixed(2)} (RMS log ratio).`
  : `Defaults are hand-set: a one-parameter refit (${new Date().toISOString().slice(0, 10)}) was declined -- see map-data/calibration.json.`;

const report = {
  generated: new Date().toISOString().slice(0, 10), attempt: 3, script: 'scripts/fit_runoff.mjs', verdict,
  what: 'Constant volumetric runoff coefficient (antecedent ramp off) fitted to MWRD six-station discharge for 8 storms; 2 held out; 10-fold leave-one-out.',
  objective: 'RMS_storms log(passed/recorded) + 0.35 * RMS_(storm x basin group) log((m+25)/(r+25))',
  fixed: { reliefFactor: 1.5, routeN: 2, routeK: 1.5, why: 'a volume total cannot see timing, and the log cannot see gravity outfalls' },
  handSet: HAND_SET, fitted: { runoffC: C, runoffCExact: +f.C.toFixed(4), amcK: 0, bounds: BOUNDS, J: +f.j.toFixed(4), JHandSet: +J(cal, HAND_SET).toFixed(4) },
  profile, holdout: { storms: HOLD, rmsHandSet: +holdRms(HAND_SET).toFixed(4), rmsFitted: +holdRms(optsC(C)).toFixed(4),
    ratios: hold.map(st => ({ storm: st.start, handSet: +Math.exp(evalStorm(st, HAND_SET).lr).toFixed(3), fitted: +Math.exp(evalStorm(st, optsC(C)).lr).toFixed(3) })) },
  leaveOneOut: { rmsHandSet: +looHand.toFixed(4), rmsFitted: +looFit.toFixed(4), folds: loo.map(l => ({ storm: l.storm, C: l.C, ratio: +Math.exp(l.lrFit).toFixed(3) })) },
  allTen: { gmeanHandSet: +gm(HAND_SET).toFixed(3), gmeanFitted: +gm(optsC(C)).toFixed(3),
    storms: storms.map(st => ({ storm: st.start, era: st.era, recordedMG: st.recordedTotalMG, handSet: +Math.exp(evalStorm(st, HAND_SET).lr).toFixed(3), fitted: +Math.exp(evalStorm(st, optsC(C)).lr).toFixed(3), groups: evalStorm(st, optsC(C)).groups })) },
  independentChecks: { note: 'not used in fitting', handSet: indep(HAND_SET), fitted: indep(optsC(C)) },
};
console.log(`C ${f.C.toFixed(4)} -> ships ${C}   J ${report.fitted.JHandSet} -> ${report.fitted.J}   on bound ${onBound}   real minimum ${realMin}`);
console.log(`hold-out RMS log ${report.holdout.rmsHandSet} -> ${report.holdout.rmsFitted}   LOO ${report.leaveOneOut.rmsHandSet} -> ${report.leaveOneOut.rmsFitted}   fold C ${Math.min(...loo.map(l => l.C))}-${Math.max(...loo.map(l => l.C))}`);
console.log(`gmean all ten ${report.allTen.gmeanHandSet} -> ${report.allTen.gmeanFitted}   independent: ${JSON.stringify(report.independentChecks.fitted)}`);
console.log('ADOPTED:', verdict.adopted, '--', verdict.viewerNote);
if (!process.argv.includes('--dry-run')) {
  const out = path.join(ROOT, 'map-data/calibration.json');
  const previous = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  if (previous && previous.attempt === 3) report.previous = previous.previous; else report.previous = previous;
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log('wrote', path.relative(ROOT, out));
}
