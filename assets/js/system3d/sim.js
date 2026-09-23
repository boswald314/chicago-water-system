/* Chicago combined-sewer / TARP mass-balance model.
 *
 * This is a MASS BALANCE, not a hydraulic model. It conserves volume across
 * sourced storage capacities and sourced pump/plant capacities. It does not
 * solve for head, velocity, air entrainment, surge or tunnel routing time.
 * Every capacity it uses comes from window.SYS3D.sim, which the build script
 * populates from this archive's cited documents.
 */

export const UNITS = {
  // 1 in/hr falling on 1 sq mi = 645.33 cfs = 417.0 MGD
  MGD_PER_IN_HR_SQMI: 417.0,
  CFS_PER_MGD: 1.547,
};

/* System build-out states. A storm in 2008 met a very different system than
 * the same storm meets today, so the model has to know which one to run. */
export const CONFIGS = [
  { id: 'pre', year: 1975, label: 'Pre-TARP (1975)',
    tunnels: {}, reservoirs: {},
    note: 'Combined sewers, intercepting sewers and the relief pumping stations only. Everything the plants could not take went straight into the river.' },
  { id: 'tunnels', year: 2006, label: 'Tunnels complete (2006)',
    tunnels: { mainstream: 1, desplaines: 1, calumet: 1, udp: 1 },
    reservoirs: { 'res-majewski': 1 },
    note: 'All 110 miles of Phase I tunnel in service (2,320 MG) but only Majewski Reservoir built. This is the system the September 2008 storms met.' },
  { id: 'r2015', year: 2015, label: 'Thornton online (2015)',
    tunnels: { mainstream: 1, desplaines: 1, calumet: 1, udp: 1 },
    reservoirs: { 'res-majewski': 1, 'res-thornton': 1 },
    note: 'Thornton Composite Reservoir gives the Calumet system 4.8 BG of CSO storage. No CSO has been recorded in its service area since 2020.' },
  { id: 'today', year: 2026, label: 'Today (2026)', dflt: true,
    tunnels: { mainstream: 1, desplaines: 1, calumet: 1, udp: 1 },
    reservoirs: { 'res-majewski': 1, 'res-thornton': 1, 'res-mccook': 1 },
    note: 'McCook Stage 1 (3.5 BG) added in December 2017. Total in-service storage about 10.97 BG.' },
  { id: 'design', year: 2032, label: 'Design complete (2032)',
    tunnels: { mainstream: 1, desplaines: 1, calumet: 1, udp: 1 },
    reservoirs: { 'res-majewski': 1, 'res-thornton': 1, 'res-mccook': 2 },
    note: 'McCook Stage 2 brings McCook to its full 10 BG. Consent-decree target 31 Dec 2029, revised to 31 Dec 2032.' },
];

/* Which tunnel system each basin's wet-weather excess goes down. The CENTRAL
 * split between Mainstream and Des Plaines is apportioned by tunnel storage —
 * an assumption, flagged in the model-notes panel. */
export const BASIN_ROUTING = {
  NORTH:   [['mainstream', 1.0]],
  CENTRAL: [['mainstream', 0.741], ['desplaines', 0.259]],
  SOUTH:   [['calumet', 1.0]],
  OHARE:   [['udp', 1.0]],
  LEMONT:  [],
};

/* Storm shape. Real storms peak; a flat hyetograph understates the peak rate
 * the system has to swallow, so the default is a centre-peaked triangle. */
export function intensity(shape, tHr, totalIn, durHr) {
  if (durHr <= 0 || totalIn <= 0 || tHr < 0 || tHr > durHr) return 0;
  if (shape === 'uniform') return totalIn / durHr;
  const f = tHr / durHr;                     // triangular, peak at mid-storm
  return (totalIn / durHr) * 2 * (f < 0.5 ? 2 * f : 2 * (1 - f));
}

export class SewerModel {
  constructor(data) {
    this.d = data.sim;
    this.basins = {};
    for (const b of data.basins) this.basins[b.id] = b;
  }

  /** Run the whole storm up front and return every frame, so the timeline can
   *  be scrubbed and charted without re-simulating. */
  run(opts) {
    const o = Object.assign({
      inches: 2.0, hours: 24, shape: 'peaked', runoffC: 0.32,
      config: 'today', dtHr: 0.25, tailHr: 264, pumpLimit: 'plant',
    }, opts);
    const cfg = CONFIGS.find(c => c.id === o.config) || CONFIGS[3];
    const D = this.d;

    // --- capacities for this build-out state -----------------------------
    const tunCap = {}, resCap = {};
    for (const [sid, s] of Object.entries(D.systems)) {
      tunCap[sid] = (cfg.tunnels[sid] ? s.storageMG : 0);
    }
    for (const [rid, r] of Object.entries(D.reservoirs)) {
      const stage = cfg.reservoirs[rid] || 0;
      resCap[rid] = stage === 0 ? 0 : (stage === 2 ? r.capFullMG : r.capMG);
    }
    // Thornton's 7.9 BG total includes 3.1 BG of Thorn Creek flood storage;
    // only the 4.8 BG CSO share is available to TARP, which is r.capMG.

    const tunVol = {}, resVol = {};
    for (const sid of Object.keys(D.systems)) tunVol[sid] = 0;
    for (const rid of Object.keys(D.reservoirs)) resVol[rid] = 0;

    const csoCum = {};                              // per basin, MG
    const csoByStation = {};
    for (const bid of Object.keys(this.basins)) csoCum[bid] = 0;
    for (const rid of Object.keys(D.relief)) csoByStation[rid] = 0;

    let excessCum = 0, capturedCum = 0, treatedCum = 0;
    const frames = [];
    // long storms need a long tail to watch the drawdown; coarser steps keep
    // a ten-day storm to a few thousand frames
    const total = Math.max(o.hours + Math.max(o.tailHr, o.hours * 1.2), 72);
    if (total > 600) o.dtHr = 0.5;
    if (total > 1500) o.dtHr = 1.0;

    for (let t = 0; t <= total + 1e-9; t += o.dtHr) {
      const inHr = intensity(o.shape, t, o.inches, o.hours);
      const fr = {
        t, inHr, basins: {}, systems: {}, reservoirs: {}, plants: {},
        csoRate: 0, csoCum: 0, pumpedRate: 0,
      };

      // Plant load starts with each basin's intercepted dry+wet flow. Egan and
      // Hanover Park serve separate-sewer suburbs that are not in MWRD's
      // combined-sewer basins, so no basin routes to them -- but they are still
      // treating their own sanitary flow, and drawing them at zero would be a
      // lie about the system rather than a gap in the model.
      const plantLoad = {};
      for (const [pid, pl] of Object.entries(D.plants))
        plantLoad[pid] = pl.basin ? 0 : pl.avg;

      // --- 1. generation and interception ------------------------------
      const excess = {};
      for (const [bid, b] of Object.entries(this.basins)) {
        const A = b.areaSqMi.v;
        const plant = D.plants[b.plant];
        if (!plant) { excess[bid] = 0; continue; }
        const dwf = plant.avg;
        const runoff = o.runoffC * inHr * A * UNITS.MGD_PER_IN_HR_SQMI;
        const gen = dwf + runoff;
        const cap = plant.dmf;                        // interceptor capture limit
        const intercepted = Math.min(gen, cap);
        const ex = gen - intercepted;
        plantLoad[b.plant] += intercepted;
        excess[bid] = ex;
        excessCum += ex * o.dtHr / 24;
        fr.basins[bid] = { gen, intercepted, excess: ex, runoff, dwf, inHr };
      }

      // --- 2. excess down the drop shafts into the tunnels ---------------
      const inflow = {};
      for (const sid of Object.keys(D.systems)) inflow[sid] = 0;
      const unrouted = {};
      for (const [bid, ex] of Object.entries(excess)) {
        const routes = BASIN_ROUTING[bid] || [];
        if (!routes.length) { unrouted[bid] = ex; continue; }
        let placed = 0;
        for (const [sid, share] of routes) {
          if (tunCap[sid] > 0) { inflow[sid] += ex * share; placed += ex * share; }
        }
        unrouted[bid] = ex - placed;                  // no tunnel built yet
      }

      // --- 3. tunnel fill, spill to reservoir, overflow to the river -----
      const overflow = {};
      for (const sid of Object.keys(D.systems)) overflow[sid] = 0;
      for (const [sid, s] of Object.entries(D.systems)) {
        let q = inflow[sid] * o.dtHr / 24;            // MG this step
        if (tunCap[sid] <= 0) { overflow[sid] += q * 24 / o.dtHr; continue; }
        const room = tunCap[sid] - tunVol[sid];
        const into = Math.min(q, room);
        tunVol[sid] += into;
        q -= into;
        if (q > 0) {                                  // tunnel full -> reservoir
          const rid = s.reservoir;
          const rroom = (resCap[rid] || 0) - (resVol[rid] || 0);
          const intoRes = Math.min(q, Math.max(0, rroom));
          if (rid) resVol[rid] += intoRes;
          q -= intoRes;
        }
        if (q > 0) overflow[sid] += q * 24 / o.dtHr;  // back to MGD
      }

      // --- 4. dewatering: pumps lift stored flow back to a plant ---------
      const pumped = {};
      for (const [sid, s] of Object.entries(D.systems)) {
        pumped[sid] = 0;
        if (tunCap[sid] <= 0) continue;
        const pump = D.pumps[s.pump];
        const plant = D.plants[s.plant];
        if (!pump || !plant) continue;
        // The pumps' nameplate capacity is rarely the binding constraint: the
        // receiving plant has to have room for the returned flow on top of the
        // dry-weather sewage already arriving through the interceptors.
        const spare = Math.max(0, plant.dmf - plantLoad[s.plant]);
        let rate = o.pumpLimit === 'nameplate'
          ? pump.capMGD : Math.min(pump.capMGD, spare);
        let vol = rate * o.dtHr / 24;
        const fromTun = Math.min(vol, tunVol[sid]);
        tunVol[sid] -= fromTun;
        vol -= fromTun;
        const rid = s.reservoir;
        const fromRes = rid ? Math.min(vol, resVol[rid] || 0) : 0;
        if (rid) resVol[rid] -= fromRes;
        const moved = fromTun + fromRes;
        pumped[sid] = moved * 24 / o.dtHr;
        plantLoad[s.plant] += pumped[sid];
        capturedCum += moved;
      }

      // --- 5. CSO accounting -------------------------------------------
      let csoRate = 0;
      for (const [bid, b] of Object.entries(this.basins)) {
        let r = unrouted[bid] || 0;
        for (const [sid, share] of (BASIN_ROUTING[bid] || [])) {
          const sysIn = Object.entries(excess).reduce((a, [ob, oe]) => {
            const rt = (BASIN_ROUTING[ob] || []).find(x => x[0] === sid);
            return a + (rt ? oe * rt[1] : 0);
          }, 0);
          if (sysIn > 0) r += overflow[sid] * (excess[bid] * share) / sysIn;
        }
        csoCum[bid] += r * o.dtHr / 24;
        csoRate += r;
        fr.basins[bid].cso = r;
        const relief = (b.relief || []).map(id => D.relief[id]).filter(Boolean);
        const tot = relief.reduce((a, x) => a + x.capMGD, 0) || 1;
        for (const x of relief) csoByStation[x.id] += r * (x.capMGD / tot) * o.dtHr / 24;
      }

      for (const [sid, s] of Object.entries(D.systems)) {
        fr.systems[sid] = {
          volMG: tunVol[sid], capMG: tunCap[sid],
          fill: tunCap[sid] ? tunVol[sid] / tunCap[sid] : 0,
          inflow: inflow[sid], pumped: pumped[sid], overflow: overflow[sid],
        };
        fr.pumpedRate += pumped[sid];
      }
      for (const rid of Object.keys(D.reservoirs)) {
        fr.reservoirs[rid] = {
          volMG: resVol[rid], capMG: resCap[rid],
          fill: resCap[rid] ? resVol[rid] / resCap[rid] : 0,
        };
      }
      for (const [pid, p] of Object.entries(D.plants)) {
        fr.plants[pid] = { flow: plantLoad[pid], dmf: p.dmf, daf: p.daf,
                           util: plantLoad[pid] / p.dmf };
        treatedCum += plantLoad[pid] * o.dtHr / 24;
      }
      fr.csoRate = csoRate;
      fr.csoCum = Object.values(csoCum).reduce((a, b) => a + b, 0);
      fr.csoByStation = Object.assign({}, csoByStation);
      frames.push(fr);
    }

    const csoTotal = Object.values(csoCum).reduce((a, b) => a + b, 0);
    return {
      opts: o, config: cfg, frames, dtHr: o.dtHr, totalHr: total,
      summary: {
        rainIn: o.inches, durHr: o.hours,
        rainVolMG: this.rainVolume(o.inches),
        excessMG: excessCum,
        csoMG: csoTotal,
        csoByBasin: Object.assign({}, csoCum),
        csoByStation: Object.assign({}, csoByStation),
        treatedMG: treatedCum,
        capturePct: excessCum > 0 ? 100 * (1 - csoTotal / excessCum) : 100,
        peakTunnelFill: Object.fromEntries(Object.keys(D.systems).map(sid =>
          [sid, Math.max(...frames.map(f => f.systems[sid].fill))])),
        boundBy: Object.fromEntries(Object.entries(D.systems).map(([sid, s]) => {
          const pump = D.pumps[s.pump], plant = D.plants[s.plant];
          if (!pump || !plant) return [sid, null];
          return [sid, (plant.dmf - plant.avg) < pump.capMGD ? 'plant' : 'pump'];
        })),
        peakResFill: Object.fromEntries(Object.keys(D.reservoirs).map(rid =>
          [rid, Math.max(...frames.map(f => f.reservoirs[rid].fill))])),
        emptyHr: this.emptyTime(frames),
      },
    };
  }

  /** Total rain landing on the combined-sewer area, for context.
   *  1 inch over 1 square mile = 17.38 million gallons. */
  rainVolume(inches) {
    let a = 0;
    for (const b of Object.values(this.basins)) a += b.areaSqMi.v;
    return inches * a * 17.38;
  }

  /** Hours from the start of the storm until every tunnel and reservoir is
   *  back under 1% full -- measured after the system has actually filled. */
  emptyTime(frames) {
    let wetSeen = false;
    for (const f of frames) {
      const wet = Object.values(f.systems).some(s => s.fill > 0.01) ||
                  Object.values(f.reservoirs).some(r => r.fill > 0.01);
      if (wet) { wetSeen = true; continue; }
      if (wetSeen) return f.t;
    }
    return wetSeen ? null : 0;
  }
}
