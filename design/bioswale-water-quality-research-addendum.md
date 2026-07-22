---
title: Bioswale — Water-Quality, Media & Prior-Art Research Addendum
status: research synthesis (adversarially verified)
date: 2026-07-22
type: research-addendum
parent: design/sheet-pile-riverponic-bioswale-spec.md
method: 11-finder sweep + adversarial verification of removal-rate/media numbers + synthesis
---

# Water-Quality, Filtration, Media & Prior-Art Addendum

Companion to [sheet-pile-riverponic-bioswale-spec.md](sheet-pile-riverponic-bioswale-spec.md).
Deep-research sweep answering: how much does this actually improve water quality, how to
improve filtration, what's the prior art (are we reinventing the wheel), best media, and
deeper overwintering data. **Key discipline: nearly every impressive removal % in the
literature comes from systems with hours-to-days residence — our single pass is ~7–15 min.
Adversarial verification flagged which numbers transfer (mostly they don't).**

## BLUF

An honest **DO-polishing + habitat + demonstration** structure. At ~7–15 min single-pass HRT
it **cannot** produce measurable river-column nutrient change; literature that says otherwise
runs at HRTs 100–3,000× longer. The direct comparator — Wild Mile's own 90 m² floating mat on
the *same* North Branch Canal — achieved only **~6.9% NO3-N / ~6.0% PO4 local** reduction and
**no detectable DO change** over 5 years (Chukwudi, Peterson & Nicodemus 2025, Urban Sci.
9(11):482). That is our *upper* bound; our trickle contacts 2–3 orders of magnitude less water.

## 1 · Overwintering (exposed crowns)

- **Hard exposed-crown freeze-kill data for wetland macrophytes does not exist as a coherent
  literature** — a genuine gap, not a search miss. Cold-climate FTW work outside Vermont is
  about winter *nutrient performance under ice*, not plant survival.
- Anchor dataset (Vermont FTW, Tharp/Westhelle/Hurley 2019): *Schoenoplectus tabernaemontani*
  **>95%** overwinter plug survival; *Carex comosa* **>90%** (best all-around); *Juncus effusus*
  intermediate; ***Pontederia cordata* too cold-sensitive → drop it.**
- Mechanism (high confidence): hardiness order is **roots < crown < renewal buds**; soil's
  thermal buffer is exactly what an exposed crown loses (1 cm burial → −4 °C vs 7 cm → −1 °C on
  the same day). *Spartina pectinata* rhizome LT50 −23 to −24 °C (autumn) is a directional
  ceiling, not proof exposed crowns survive in situ. Cooling *rate* swings LT50 ~10 °C.
- **Design implication:** drain-and-go-dormant (Nov–Mar) is right; do NOT rely on crowns
  surviving *exposed and wet*. Lean on **substrate insulation** as the dominant lever, and
  consider a **removable winter insulating cover** or dropping modules to a protected sump
  rather than leaving crowns in drained channels to desiccating sub-freezing wind. Every
  genus-specific kill temperature is LOW confidence — present as such.

## 2 · Realistic water-quality improvement (honest, per-pass)

**Real & fast (minutes-scale):**
- **DO from the cascade — the one genuinely defensible benefit.** Gameson r = 1 + 0.5·a·b·h;
  for 0.5–1.8 m fall, r ≈ 1.3–2.2 (deficit cut to ~45–77% in one pass; ~0.3 m fall ≈ 1 mg/L).
  **Honest: <1–2 mg/L added per pass, and ~0 when water is already near saturation** — valuable
  at dawn/post-CSO hypoxia, negligible on a saturated afternoon. Never quote a fixed mg/L
  without stating influent DO/temp.
- **Metal sorption on fresh media (finite, declines as sites fill):** Zn ~30–60%, Pb ~15–45%,
  Cu ~10–35% (Cu weakest, maybe ~0 on fresh media). NOT the 85–97% bioretention headline
  numbers (those are 450–900 mm organic beds, hours of ponding).
- **TSS via filtration:** ~40–65%; turbidity ~15–40% per pass (through-media subset of Bhurtyal
  & Ahmari 2025; the negative-turbidity cases were open-channel resuspension we avoid).

**NOT real at this footprint (do not claim):**
- **Measurable river-column N/P change** — throughput ~2,300–3,000 gal/day vs tens of millions;
  ratio ~1:10,000.
- **Denitrification / nitrate removal** — thin aerated trickle has no anoxic zone; per-pass TN
  removal ~0.03–0.13% (k–C* at 7–15 min); plus a nitrate-*export* risk.
- **PAH/oil biodegradation** — needs days; single pass captures only sorbable/particulate
  (~20–50% of free oil on fresh media; dissolved/BTEX passes through).

**Per day:** a rounding error vs river flow — a local eddy DO/clarity bump. **Per season:** metal/P
sorption exhausts without media renewal; plant uptake is <5–15% of removal system-wide. Winter
dormancy zeroes ~40–50% of the year.

## 3 · How to improve filtration — RANKED

1. **RECIRCULATION** *(highest leverage)* — route 50–100% of outflow back to a head tank on a
   timer instead of once-through-to-river. The **only** way to buy contact time without new
   footprint/weight; the pump already lifts. k–C* is exponential in cumulative t.
   **Requires adding a small closed reservoir/loop — the current open river→river design cannot
   benefit until you add one.**
2. **REACTIVE / ADSORPTIVE MEDIA** — iron-enhanced sand for P; Fe/Mg-modified biochar. Drop-in at
   150 mm, minimal weight. **Plain biochar removes P poorly (can even release it)** — P polishing
   depends on adding an iron sorbent.
3. **TIDAL FILL-AND-DRAIN dosing** — pulse flood-then-drain via timer/float-siphon on the weirs;
   the drain phase pulls air in (nitrification + O2) and **cuts pump duty ~70%** (helps the PV
   budget). Native fit to the cascade geometry; combines with #1.

*Lower:* #4 anoxic woodchip sump for nitrate (powerful but worst structural fit — permanent
ponding conflicts with drain-down); #5 zeolite for ammonium (fast ion exchange, saturates,
NaCl regen at drain-down); #6 structural HRT (can't close a 100–1,000× gap); #7 Juncus
weighting for uptake (free, but minority pathway).

**Top three: recirculation, reactive P media, tidal dosing** — all cheap, lightweight, drain
for winter, and combine.

## 4 · Case studies & prior art — reinventing the wheel?

**No — every component is documented, but the specific combination (pumped, wall-mounted in dry
freeboard, river-source, seasonally drained) has NO built, monitored precedent. Built + monitored,
it would be a first.**

- **Wild Mile / Urban Rivers FTWs** — direct precedent & model; ~6–7% local nutrient reduction.
- **SOM 2019 sheet-pile wall planters** — conceptual only; never built or measured.
- **Green/living walls for greywater** — closest literal architecture. Transferable lesson:
  **discrete stacked channels >> thin continuous felt walls (TN 48–93% vs 8–26%) — validates our
  3-channel geometry.** (Greywater is 10–100× stronger, so their % won't transfer.)
- **RAS / nitrifying trickling filters** — **best hydraulic match** (their optimal HRT is 3–10
  min ≈ ours). **Adopt their framing: report areal loading rate (g/m²/day), not % removal.**
- **Tidal-flow wetlands** — established answer to shallow-system O2 limits; borrow fill-contact-
  drain-rest logic + ~70% energy savings.
- **National Aquarium Baltimore FTW** — 11 yrs, still publishes no quantified N/P removal; the
  director's "postage stamp" framing is the honest register.
- **Patents** — floating-raft (US7314562B2), vertical hydroponic biofilter (US8181391B1,
  US9380751B2), stormwater biofiltration (US20090014372A1) exist separately; the wall-mounted +
  pumped + river combo has no direct match (informal, not an FTO clearance).

## 5 · Best media — decisive

**Recommended ~150 mm blend (by volume):**
- **~50% biochar** (low/med pyrolysis ~350–500 °C, light ~300–500 kg/m³) — biofilm, NH4+ CEC,
  metals. **NOT phosphorus** (can release P).
- **~15–20% clinoptilolite zeolite** in a discrete layer — the one media fast enough for
  minutes-scale ammonium (ion exchange ~1.5–2.5 mg N/g); heaviest (~600–700 kg/m³) so keep it a
  minority; NaCl regen at drain-down.
- **~20–25% pumice or LECA** — light structural/drainage aggregate; conductivity + root anchorage.
- **Coir mat top layer** (not bulk) — TSS, root support, metal sorption, slow carbon.
- **Reactive P option (decisive):** blend **iron-coated / iron-enhanced sand or iron filings**
  (~0.9–2.9 mg P/g; ~5 mg P per g Fe) — best fit for river discharge (neutral pH, non-toxic,
  multi-year life). Single most important media choice if P is a target.

**Reject:** steel/blast-furnace **slag** (pH 10–12 caustic shock — disqualifying without a
downstream buffering wetland we don't have); **Al-based WTR / alum** (fish-toxic dissolved Al
below pH ~6.5); **sand/gravel/expanded shale** as primary (too heavy, 1,600–2,100 kg/m³);
**GAC** (5–10× cost, no advantage here).

**Weight:** wet blend ~500–700 kg/m³ over 150 mm ≈ **75–105 kg/m² of channel + water + biomass +
ice/snow — verify against bracket/wall capacity (ties to the top-hung load work).**

## 6 · Honest ceiling & reframe

**Genuinely good for:** (1) DO polishing in the discharge eddy (North Branch is 303(d)-listed for
low DO — but MWRD fixes that with *mechanical* SEPA aeration, telling you engineered aeration, not
planted trickle, moves DO at compliance scale); (2) habitat/microhabitat; (3) public
engagement/education — the legitimate "postage stamp" mission; (4) local TSS/fresh-media metal/P
capture (real, finite, hyperlocal).

**Not:** a measurable river-water-quality intervention. The river's N/P/DO problems are
watershed/wastewater-scale (three MWRD plants ~1.0 mg/L P ≈ 20× the 0.05 target; nutrients
*rising*; IL projected to miss 2025 targets). ~1:10,000 throughput can't register.

**Single most important change if water quality (not habitat) is the goal:** convert single-pass
open (river→trickle→river) to a **recirculating closed loop with a holding reservoir, and scale by
replication.** Recirculation is the only lever that attacks the binding constraint (contact time);
everything else multiplies a near-zero per-pass number until the loop exists. Even optimized, one
unit is a demonstration; real impact needs "hundreds" of units — at which point the value is
**proving a replicable, low-power, wall-mountable module, which is the genuinely novel,
publishable contribution here.** Frame the pilot as "characterize a new module type honestly,"
not "clean the river."

*Cross-cutting caveat: essentially all literature removal figures come from hours-to-days HRT
and/or wastewater-strength influent. This 7–15 min dilute single pass is a regime no study
directly tested. Treat every % as an optimistic ceiling; adopt areal-rate framing; validate with
bench/pilot testing before publishing any performance claim.*
