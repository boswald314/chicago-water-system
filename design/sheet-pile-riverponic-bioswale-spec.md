---
title: Passive Solar Riverponic Bioswale — Design Spec
status: concept design — for PE review
revision: A
date: 2026-07-22
type: original-design-synthesis
related-sources:
  - sources/floating-wetlands/   # Wild Mile / Bubbly Creek / BioMatrix / Awad 2025 cost study
  - timeline-data/north-branch-restoration-timeline.js
  - sources/river-restoration/2019-city-chicago-wild-mile-framework-vision-som.pdf
artifact: https://claude.ai/code/artifact/37912a0e-9d47-401b-ade7-98706d386d61
---

# Passive Solar Riverponic Bioswale — Design Spec

A modular, wall-hung treatment channel that lifts Chicago River water with a small solar
pump, trickles it through a stacked, meandering planted terrace mounted on an existing
sheet-pile wall, and returns it aerated to the river. Sized to **hang from the cap**,
**overwinter in place**, and **tile** into a continuous run.

> **This is a concept design / research synthesis, NOT a stamped engineering calculation.**
> Loads and costs are order-of-magnitude for scoping. Every load path, the media density,
> cap geometry, and winter survival require site verification before construction.

**Visual spec sheet (all figures):** <https://claude.ai/code/artifact/37912a0e-9d47-401b-ade7-98706d386d61>
(source preserved in `design/sheet-pile-riverponic-bioswale-spec.html`)

Design basis: generic PZ-class Z/U sheet-pile wall, 6–8 ft freeboard. Module = one 4 ft
channel segment, tileable. Build tier: marine-durable, 10–20 yr.

---

## 01 · Concept & operating principle

Screened intake → PV pump lifts ~6–10 ft to the top row → gravity trickle through a
switchbacking series of shallow planted channels → aeration cascade → oxygenated re-entry.
The planters live **entirely in the dry freeboard above the ice/normal-water line** — the
move that lets a rigid wall-mounted assembly avoid the ice-thrust load case that forces
Wild Mile's wetlands to float. Treatment is habitat-grade polishing (nutrient/metal uptake
+ dissolved oxygen), not municipal-scale removal; the honest value is ecological edge and a
living demonstrator.

## 02 · Module geometry

- Flow runs **back and forth along the length of the wall** (elevation), dropping row to row.
- Each shelf projects only a short distance off the face (section); **capped at 12 in** — see §03.
- Channels **meander in/out through the corrugation** (plan): +40–60% flow length & edge,
  and the mounts nest into the pile troughs.
- Bay ~8–12 ft along the wall; **3 rows** in 6–8 ft freeboard (~2 ft drop each); slope 1–2%
  within a run with grade at 5–15 cm notched weirs; total path ~24–36 ft.

## 03 · Attachment — top-hung cap-saddle hanger

Hooks over the wall cap: weight → vertical bearing on the cap; the small overturning moment
is a hook-tension/toe-bearing couple over a long front leg. **No friction clamp, no
penetrating waler.** Precedent: Tractel parapet clamp (non-penetrating top+face grip),
rated 1,500 lb — far above these loads.

| Load per 4-ft module · 12 in projection · leg h = 0.55 m | Service (q≈2.5 kPa) | Design (q≈3.5 kPa) |
|---|--:|--:|
| Vertical hang load into cap, W | 209 lbf | 293 lbf |
| Hook ⇄ toe couple, H (±15%) | 85 lbf | 118 lbf |
| Toe face-bearing pressure | 3.6 psi | 5.1 psi |
| Cumulative cap line load (3–4 rows) | ~130–290 lb/ft of wall | |

Rules: max projection **12 in** (9–12 band); 18 in only with h = 0.75 m on a concrete cap;
past 18 in revert to clamp/waler. Apply ~2–3× hardware factor. Keeper is a **250–500 lbf**
anti-uplift member, not a gravity support.

Cap condition → detail: concrete coping (preferred, cast-in keeper strike) · steel wale
(hook the channel, mid band) · **bare pile tops = not acceptable, add a cap rail first**.

## 04 · Mounting kit & BOM

Structure separated from vessel; a small kit of repeated, mostly-catalog parts. **All-FRP/
HDPE eliminates the galvanic couple** against the carbon-steel pile. Only the saddle bracket
is bespoke — a flat-cut, single-bend plate (waterjet, no tooling), one SKU per pile profile.

| Part | Real product | Unit price |
|---|---|--:|
| Channel (vessel) | NDS Dura Slope 6″ HDPE (pilot: Spee-D 4″) | $184 / seg ($48) |
| Rail | Fiberglass SST strut channel | $8.98 / ft |
| Clip | FG HD channel nut + FG hex bolt | ~$8 / set |
| Brace | Fibergrate Dynaform / Strongwell Extren FRP | ~$12 / ft |
| Saddle bracket *(bespoke)* | G-10 / 316 flat-cut, SendCutSend (no tooling) | ~$15–18 / part |

| Config | Per module (4 ft) | Per linear ft | 24 ft pilot |
|---|--:|--:|--:|
| All-FRP · 6″ Dura Slope (production) | ~$413 | ~$103 | ~$2,480 |
| All-FRP · 4″ Spee-D (cheapest pilot) | ~$225 | ~$56 | ~$1,350 |
| Hybrid 316 load path | ~$460 | ~$115 | ~$2,760 |

Use the **6″ Dura Slope even for the pilot** — deeper media improves winter survival AND
adds wind-uplift ballast. Marine-grade FRP brackets are a custom waterjet cut (not
instant-quote); use G-10/316 for the pilot.

## 05 · Planting schedule — winter-hardy, zoned

2-zone container rule (Illinois Extension): pick species crown-hardy to **USDA zone 3–4**,
not 5b/6a. Wet-treatment sedges/rush on lower rows; tough shallow-media accents on the drier
upper row.

- **Lower / treatment:** *Carex comosa* (z3–10, best FTW winter survivor), *Schoenoplectus
  tabernaemontani* (z3–9, co-best), *Carex stricta* (z3–8), *Juncus effusus* (z3–9).
- **Upper / accents:** *Sedum* spp. (z3–4), *Allium cernuum* (z3–8), *Carex lurida* (z4–9).
- **Avoid:** *Pontederia cordata* (too cold-sensitive despite nursery z3 label), *Saururus
  cernuus* (thin margin), *Sagittaria* (tuber-overwintering strategy), tall forbs *Hibiscus*
  / Joe Pye (wind-sail + not shallow-media hardy).

Plugs 12–18″ o.c. (Possibility Place, Prairie Moon, Pizzo). The hanging-root "riverponic"
curtain is a **summer feature**; the overwintering unit is the crown in the media.

**Correction logged:** the archive's Bubbly Creek line calling *Juncus effusus* the
"independently cold-hardiest species in overwintering trials" is unsourced narrative — the
Lake Champlain FTW winter trial found *Carex comosa* and *Schoenoplectus* out-survived it.

## 06 · Solar pump schedule

Design flow 6–8 L/min (~1.6–2 gpm); TDH ~11–12 ft. Pump: brushless DC, ≥2 gpm @ 12 ft,
~20–40 W, 12 V (submersible or booster + foot valve; keep a spare). PV: 100 W. Controller:
linear current booster + dry-run cutoff, PV-direct (no battery). Intake: CuNi/316 wedge-wire
≥1–2 ft below low water. Delivery: ½–¾″ tubing → slotted top-row header. Output ~1,700 L /
clear day; subsystem ~$360–880.

**PV chosen over the Fresnel thermal-vacuum pump:** the thermal pump is real (Savery/
pulsometer lineage) but ~0.1–0.3% efficient, direct-beam-only, needs 2-axis tracking. PV +
micro-pump delivers 15–50× more water per m², any weather, freeze-drainable. Thermal pump
survives only as an optional kinetic demonstrator.

## 07 · Overwintering & operations — stays up

Never removed. Plants die back to the crown, which overwinters insulated **in the media**
(green-roof / container model) and resprouts in spring. Bare hanging roots do not survive —
crown-in-media is the survival unit.

- Media ~150 mm LECA + moderate biochar + coir; ends autumn **moist-but-drained**; channel
  **self-drains empty** before hard freeze (no ice block).
- Fall: coir/wood-chip mulch cap over crowns (freeze-thaw heave + wind desiccation).
- Pump: drain / blow out lines. That + mulching are the only winter tasks.

| Survival expectation | Crown survival | Spring gap-fill |
|---|--:|--:|
| Established (2nd winter on) | 85–95% | ~5–15% / yr |
| First winter (heaving on new crowns) | 70–85% | ~15–30% |

## 08 · Open items — for structural review & pilot

**Structural (PE stamp):** site wind (ASCE 7 Hazard Tool) + true moment about the hook —
**wind uplift, not gravity, governs**; verify real saturated media density (if 700–1,000
kg/m³, less ballast → size keeper for full net uplift); field-verify cap geometry per reach;
bare pile tops must be capped first.

**Pilot winter:** exact assembly untested and harsher than a floating raft (no under-ice
thermal blanket). Run 1–2 real panels one Chicago winter; log crown-depth vs air temp; score
spring resprout before certifying "no removal".

**Permitting:** USACE §10/§404 (likely NWP 27, ~45-day) · IEPA §401 · IDNR OWR · MWRD WMO ·
CDOT · City DPD (River Corridor Design Guidelines) · **adjacent wall-owner consent (schedule
driver)**. Bubbly Creek CERCLA sediment context for contaminated reaches.

## 09 · Precedents & sources

- **Wild Mile / Urban Rivers** — BioMatrix riverponic modules, helical-anchor + elastic-rode
  floating design; levelized cost $1,324–2,537/m² (Awad et al. 2025). [`sources/floating-wetlands/`]
- **Wild Mile Framework Vision** (SOM 2019) — proposes sheet-pile "wall planters" as light
  geotextile pockets; no structural analysis (engineering explicitly deferred).
  [`sources/river-restoration/2019-city-chicago-wild-mile-framework-vision-som.pdf`]
- **Tractel parapet clamp** — non-penetrating, 1,500 lb; cap-saddle precedent.
- **MSU shallow green-roof trial** (Monterusso et al. 2005) & **Lake Champlain Sea Grant FTW
  winter trial** — overwintering + species basis.
- **Illinois Extension** — 2-zone container hardiness rule.
- **Vendors** — NDS, Unistrut/Atkore fiberglass strut, Fibergrate/Strongwell, SendCutSend.

---

*Provenance: synthesized across a sequence of multi-agent research + modeling runs (pump
feasibility, mounting/hydraulics/plants/cost, top-hung statics with adversarial verification,
overwintering horticulture). Numbers cross-checked but scoping-grade; see §08.*
