---
title: Bioswale — Tidal Fill-and-Drain & Nitrogen-Removal Methods Addendum
status: research synthesis
date: 2026-07-22
type: research-addendum
parent: design/sheet-pile-riverponic-bioswale-spec.md
method: 6-finder sweep (tidal-flow wetlands, IWS denitrification, woodchip bioreactors, recirculating VFCW, intermittent dosing, greywater living walls) + synthesis
---

# Tidal Fill-and-Drain & Nitrogen Removal — Addendum

Answers: is recirculation the only way to create an anoxic zone for N removal (no — tidal
cycling does it), and how to spec the weir-gated pulsing. Companion to
[sheet-pile-riverponic-bioswale-spec.md](sheet-pile-riverponic-bioswale-spec.md) §03/§09.
**Scale caveat: all rates are directional transfers from larger systems (hours–days HRT,
tens of cm saturation); none from a 150 mm, 6–8 L/min, wall-hung, seasonal film. Targets to
TEST, not specs to hit.**

## Mechanism (well-documented, not speculative)

- **DRAIN = nitrification.** Falling water level pulls air into the pores by negative-pressure
  "hydrodynamic air pumping" (biofilm re-aerates in ~30 s; bed sits ~21% O₂). Adsorbed NH₄⁺ →
  NO₃⁻. Passive O₂ transfer **450–473 g O₂/m²/day** — no blower, ~half the power of aerated
  wetlands. This is why it fits a PV-powered wall unit.
- **FLOOD = denitrification.** Pores go anoxic; NOₓ⁻ from the last drain is reduced to N₂ —
  **only if organic carbon is present.** This is the half a plain trickle lacks.

## Rates (reference systems; expect a down-scaling haircut)

| Metric | Reported | Our honest expectation |
|---|---|---|
| TN removal, tidal | 43–84% (2-stage to 93%); conventional CW only 30–50% | **15–40% microbial alone; 40–60% with carbon cell + tuned flood** |
| NH₄-N removal | 55–99% | **60–90% — the dependable win** |
| Areal TN | 7.5–8.3 g N/m²/day | test |
| Cold-climate | NH₄ 93–96% winter-stable; biochar/Fe TFCW TN ~79% at 8–17 °C | winter = designed-off (drained) |

## Cycle to spec

- **3–6 cycles/day** (literature 4–24); common point **2 h flood / 6 h drain, 3×/day**.
- **Flood duration is THE denitrification knob** (3 h→5 h flood = +11 pts TIN) → make it
  **field-adjustable at the weir gates**, not hard-set.
- **Drain long enough to de-water + re-aerate** (LECA's permeability helps).
- **Dose small and often** (fewer doses/day cost 20–30%); a **passive dosing siphon** raises
  pulse frequency without extra PV draw.

## The make-or-break: carbon in the flood phase

- Chicago River water is **carbon-poor**; denitrification needs **C:N (COD/N) ≈ 4–5**. A purely
  mineral bed will **nitrify then EXPORT nitrate** — net-worse than nothing (bad optics).
- Fix: make the **lowest switchback channel a weir-gated, carbon-amended HOLDING cell** —
  biochar/coir-rich (lighter, already in the palette; biochar green-wall pilot hit 75% TN),
  hardwood-woodchip fallback (hardwood ≈10× softwood). **No permanent sump** — it floods/drains
  on cycle; the anoxic zone exists in *time*, not *space*.
- Size a **deliberate holding volume** there for residence time; locally deepen to 200–300 mm
  if the wall can bear it (our 150 mm bed is ⅓ the 450–600 mm IWS reference — buy back margin
  with time + depth).

## Recirculation vs tidal — use tidal, reject recirculation

Both alternate oxidized/reduced states; recirculation does it *in space* (continuous 3:1–12:1
pumping, extra pump/loop/weight), tidal does it *in time* (one fill-stroke/cycle, gravity drain).
**Tidal wins decisively on power (PV), weight (wall-hung), and winter drain-down.** The instinct
to explicitly refuse: "run more water through it" — cycle timing is the lever, not multi-pass flow.

## Also critical

- **Plant them.** In the closest analog (greywater living walls) microbial N&D was only **0–15%**
  of N removed — plant uptake dominated. Vegetation is the hedge and often the dominant pathway.
- **Winter = zero N removal by design** (drained; denitrification collapses to 10–20% near 5 °C
  anyway). Spring biofilm restart has no precedent — budget a ramp.
- **Pilot/instrument** (DO + nitrate before/after each cycle) — no literature at this scale.

## Deltas for rev C (fold with the pending scaling analysis)

1. Reframe the carbon cell from "optional" to **required-if-N-is-a-goal**, biochar/coir-preferred.
2. Add **field-adjustable weir flood-duration** + **passive dosing siphon** to the operating spec.
3. State honest **TN 40–60% warm-season target (verify by pilot); NH₄ 60–90%; winter 0%**.
4. Note **vegetation may be the dominant N pathway**; deepen the lowest holding cell if wall allows.
