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
    for (const b of data.basins) {
      this.basins[b.id] = b;
      // centroid of the outline rings, for reading a gauge field
      let sx = 0, sz = 0, n = 0;
      for (const ring of (b.outline || [])) for (const p of ring) { sx += p[0]; sz += p[1]; n++; }
      b.cx = n ? sx / n : 0; b.cz = n ? sz / n : 0;
    }
    // what the relief pumping stations in each basin are rated to pass to the
    // river; gravity outfalls add some, so a factor above 1 (assumed)
    this.reliefCap = {};
    for (const [bid, b] of Object.entries(this.basins)) {
      const cap = (b.relief || []).map(id => this.d.relief[id]).filter(Boolean).reduce((a, x) => a + x.capMGD, 0);
      this.reliefCap[bid] = cap > 0 ? cap * 1.5 : 1e9;
    }
  }

  /** A storm's hyetographs, one array per gauge, in gauge order.
   *
   *  Gauges read once a day carry no hourly series of their own: storms.json
   *  gives them a measured event total and the id of the nearest gauge that
   *  does have a hyetograph, and the series is that gauge's shape scaled to
   *  this gauge's total. Writing those arrays out would be a megabyte of
   *  redundancy, so they are expanded here, once per storm. */
  series(hy) {
    const cache = this._sr || (this._sr = new Map());
    if (cache.has(hy)) return cache.get(hy);
    const by = {};
    for (const g of hy.gauges) if (g.hourly) by[g.id] = g.hourly;
    const out = hy.gauges.map(g => {
      if (g.hourly) return g.hourly;
      const shape = by[g.shapeFrom];
      if (!shape) return [];
      const sum = shape.reduce((a, x) => a + x, 0);
      const k = sum > 0 ? g.totalIn / sum : 0;
      return shape.map(x => x * k);
    });
    cache.set(hy, out);
    return out;
  }

  /** Per-basin gauge weights for a recorded storm: the AREA average of the
   *  inverse-distance field over the basin, not its value at one point.
   *
   *  Normalised IDW is linear in the gauge values -- rain(p,t) is
   *  sum_g w_g(p) v_g(t) / sum_g w_g(p) -- so averaging it over the basin's
   *  sample points collapses to a single weight per gauge, computed once per
   *  storm, and each step is then a dot product. A basin with no sample grid
   *  falls back to its centroid, which is the old behaviour. */
  gaugeWeights(b, hy) {
    const cache = this._gw || (this._gw = new Map());
    let byBasin = cache.get(hy);
    if (!byBasin) cache.set(hy, byBasin = {});
    if (byBasin[b.id]) return byBasin[b.id];
    const gs = hy.gauges;
    const pts = (b.samples && b.samples.length) ? b.samples : [[b.cx, b.cz]];
    const w = new Float64Array(gs.length), wi = new Float64Array(gs.length);
    for (const p of pts) {
      let wsum = 0;
      for (let i = 0; i < gs.length; i++) {
        const d2 = Math.max(1e6, (gs[i].x - p[0]) ** 2 + (gs[i].z - p[1]) ** 2);
        wi[i] = 1 / d2; wsum += wi[i];
      }
      if (wsum) for (let i = 0; i < gs.length; i++) w[i] += wi[i] / wsum;
    }
    for (let i = 0; i < gs.length; i++) w[i] /= pts.length;
    return (byBasin[b.id] = w);
  }

  /** Rain over a basin's area at hour t: a recorded storm's gauge field
   *  area-averaged over the basin, or the synthetic hyetograph. */
  rainAt(b, o, t) {
    if (!o.hyeto) return intensity(o.shape, t, o.inches, o.hours);
    const h = Math.floor(t), f = t - h;
    const gs = this.series(o.hyeto), w = this.gaugeWeights(b, o.hyeto);
    let v = 0;
    for (let i = 0; i < gs.length; i++) {
      const a = gs[i][h] || 0, bq = gs[i][h + 1] || 0;
      v += w[i] * (a + (bq - a) * f);
    }
    return v;
  }

  /** Run the whole storm up front and return every frame, so the timeline can
   *  be scrubbed and charted without re-simulating. */
  run(opts) {
    const o = Object.assign({
      inches: 2.0, hours: 24, shape: 'peaked', runoffC: 0.32,
      config: 'today', dtHr: 0.25, tailHr: 264, pumpLimit: 'plant',
      // Antecedent moisture: the volumetric runoff coefficient rises toward
      // runoffMax as the ground saturates, on the rain of the previous 72 h
      // (an NRCS-AMC-style adjustment; the 0.32 base is the calibrated
      // single-day value). Set amcK to 0 to switch it off.
      runoffMax: 0.62, amcK: 2.5,
    }, opts);
    const cfg = CONFIGS.find(c => c.id === o.config) || CONFIGS[3];
    const D = this.d;
    if (o.hyeto) { o.hours = o.hyeto.hours; o.inches = 0; }

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
    const rain72 = [];                              // (t, inches) area-weighted, for antecedent moisture
    const passedByStation = {};
    for (const rid of Object.keys(D.relief)) passedByStation[rid] = 0;
    const pooled = {};                              // MG standing in the streets, per basin
    for (const bid of Object.keys(this.basins)) pooled[bid] = 0;
    let rainCum = 0;
    const frames = [];
    // long storms need a long tail to watch the drawdown; coarser steps keep
    // a ten-day storm to a few thousand frames
    const total = Math.max(o.hours + Math.max(o.tailHr, o.hours * 1.2), 72);
    if (total > 600) o.dtHr = 0.5;
    if (total > 1500) o.dtHr = 1.0;

    for (let t = 0; t <= total + 1e-9; t += o.dtHr) {
      // rain is read per basin so a storm can be heavier on one side of town
      const rainB = {};
      let areaSum = 0, inHrW = 0;
      for (const [bid, b] of Object.entries(this.basins)) {
        rainB[bid] = this.rainAt(b, o, t);
        inHrW += rainB[bid] * b.areaSqMi.v; areaSum += b.areaSqMi.v;
      }
      const inHr = areaSum ? inHrW / areaSum : 0;
      rainCum += inHr * o.dtHr;
      rain72.push([t, inHr * o.dtHr]);
      while (rain72.length && rain72[0][0] < t - 72) rain72.shift();
      const ant = rain72.reduce((a, x) => a + x[1], 0);
      const cEff = o.amcK > 0 ? o.runoffC + (o.runoffMax - o.runoffC) * (1 - Math.exp(-ant / o.amcK)) : o.runoffC;
      const fr = {
        t, inHr, basins: {}, systems: {}, reservoirs: {}, plants: {},
        csoRate: 0, csoCum: 0, pumpedRate: 0, pooledMG: 0,
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
        const runoff = cEff * rainB[bid] * A * UNITS.MGD_PER_IN_HR_SQMI;
        const gen = dwf + runoff;
        const cap = plant.dmf;                        // interceptor capture limit
        const intercepted = Math.min(gen, cap);
        const ex = gen - intercepted;
        plantLoad[b.plant] += intercepted;
        excess[bid] = ex;
        excessCum += ex * o.dtHr / 24;
        fr.basins[bid] = { gen, intercepted, excess: ex, runoff, dwf, inHr: rainB[bid], cEff };
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
        // the river takes what the outfalls can pass; the surplus surcharges the
        // collection system and stands in the streets until there is room again
        const cap = this.reliefCap[bid];
        const passed = Math.min(r, cap);
        const backup = r - passed;
        pooled[bid] += backup * o.dtHr / 24;
        // standing water drains back through the outfalls once they have room;
        // it still reaches the river, just later -- which is what the stations
        // log as discharge the day after the rain
        let drainRate = 0;
        if (r < cap && pooled[bid] > 0) {
          const drain = Math.min(pooled[bid], (cap - r) * o.dtHr / 24);
          pooled[bid] -= drain;
          drainRate = drain * 24 / o.dtHr;
        }
        csoCum[bid] += r * o.dtHr / 24;
        csoRate += r;
        fr.basins[bid].cso = r;
        fr.basins[bid].csoPassed = passed + drainRate;
        fr.basins[bid].backup = backup;
        fr.basins[bid].pooledMG = pooled[bid];
        fr.pooledMG += pooled[bid];
        fr.basins[bid]._drainRate = drainRate;
        const relief = (b.relief || []).map(id => D.relief[id]).filter(Boolean);
        const tot = relief.reduce((a, x) => a + x.capMGD, 0) || 1;
        for (const x of relief) {
          csoByStation[x.id] += r * (x.capMGD / tot) * o.dtHr / 24;
          // what MWRD's log can see: the station actually passing flow, capped
          // at its rating, plus its share of the backed-up water draining out later
          passedByStation[x.id] += (Math.min(r * (x.capMGD / tot), x.capMGD) + fr.basins[bid]._drainRate * (x.capMGD / tot)) * o.dtHr / 24;
        }
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
      leadHr: o.hyeto ? (o.hyeto.leadHr || 0) : 0,
      summary: {
        rainIn: o.hyeto ? rainCum : o.inches, durHr: o.hours,
        rainVolMG: this.rainVolume(o.hyeto ? rainCum : o.inches),
        peakPooledMG: Math.max(...frames.map(f => f.pooledMG)),
        peakPooledByBasin: Object.fromEntries(Object.keys(this.basins).map(bid =>
          [bid, Math.max(...frames.map(f => (f.basins[bid] || {}).pooledMG || 0))])),
        excessMG: excessCum,
        csoMG: csoTotal,
        csoByBasin: Object.assign({}, csoCum),
        csoByStation: Object.assign({}, csoByStation),
        passedByStation,
        passedMG: Object.values(passedByStation).reduce((a, b) => a + b, 0),
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
