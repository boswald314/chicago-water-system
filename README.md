# Chicago Sewers & Water System — Research Archive

**Live site: <https://boswald314.github.io/chicago-water-system/>** — interactive flow map,
rendered documents, and image galleries (images served from the companion
[chicago-water-images](https://github.com/boswald314/chicago-water-images) repo).

A complete map of how water moves through Chicago: Lake Michigan → intake cribs → purification
plants → pumping stations → 5 million taps → combined sewers → interceptors & pumping stations →
TARP "Deep Tunnel" & reservoirs → seven treatment plants → the reversed river system → the
Mississippi. Covers the full MWRD service area (all of Cook County), the City drinking-water
system, construction history from 1855 to the present, and every capacity figure that could be
pinned to a source.

Compiled July 2026 from city/agency sources first (MWRD, Chicago Dept. of Water Management,
Sanitary District annual reports, HABS/HAER, USACE, EPA), filled in with archives, journalism,
and local-history sources. Every factual claim in the documents carries a numbered citation.

## Start here

| File | What it is |
|---|---|
| **[00-SYSTEM-OVERVIEW.md](00-SYSTEM-OVERVIEW.md)** | The whole system in one readable document — facility tables, "follow a drop of water" narratives, construction eras, ownership boundaries |
| **[index.html](index.html)** | Interactive flow diagram (the site homepage) — click any facility for details, toggle *extreme-storm mode* to see CSOs and lake reversals; lines scale with documented capacity, plant/reservoir boxes with design flow/storage |
| **[SOURCES.md](SOURCES.md)** | Master bibliography of every source used, by tier, with which docs cite it |
| **[images/INDEX.md](images/INDEX.md)** | Catalog of all ~810 archival images with captions, dates, and provenance links |

## The detail documents (`docs/`)

Each is fully cited, with a facilities/capacities table, construction narrative,
upgrade timeline, and open questions. Docs 01–14 were adversarially fact-checked against
their cited sources (369 claims verified, 63 corrections applied) and then
cross-checked against each other for consistency; docs 15 and 16 were researched and
cited to the same standard but added in later passes and not yet run through that audit.
Doc 16 is also different in kind from the rest: a dated (July 2026) snapshot of active
construction and contracts rather than a finished-history narrative.

| Doc | Covers |
|---|---|
| [01 — Early sewerage history](docs/01-early-sewerage-history.md) | Chesbrough's 1855 plan (first comprehensive US sewer system), raising the city, the 1885 storm myth, creation of the Sanitary District |
| [02 — River reversal & canals](docs/02-river-reversal-canals.md) | Sanitary & Ship Canal (1892–1900), the Jan 2, 1900 reversal, Cal-Sag & North Shore channels, locks, Lockport, the 3,200-cfs diversion decree |
| [03 — Intake cribs](docs/03-intake-cribs.md) | All nine cribs ever built (1865–1935), lake tunnels, the 1909 crib fire, which two are still active |
| [04 — Water purification plants](docs/04-water-purification-plants.md) | Jardine (world's largest conventional filtration plant) & Sawyer, treatment history from 1912 chlorination onward |
| [05 — Water pumping & distribution](docs/05-water-pumping-distribution.md) | The 12 pumping stations (1854–present), steam→electric conversions, 65 mi of tunnels, ~4,400 mi of mains, suburban wholesale |
| [06 — City sewer network](docs/06-city-sewer-network.md) | The ~4,400 mi of city-owned combined sewers, construction eras, catch basins, the DWM/MWRD ownership boundary, 184 city CSO outfalls |
| [07 — MWRD interceptors & pumping stations](docs/07-mwrd-interceptors-pumping-stations.md) | 560 mi of interceptors, all 23 MWRD pumping stations with capacities and rehab history |
| [08 — ★ North Branch (Lawrence Ave) Pumping Station](docs/08-north-branch-pumping-station.md) | **The deep dive that started this project** — 1928–30 construction, its two hydraulic roles, TARP-era operation, every documented rehab |
| [09 — TARP Deep Tunnel](docs/09-tarp-deep-tunnel.md) | The 1972 plan, all four tunnel systems (110 mi, 8–33 ft dia., 150–300 ft down), drop shafts, how a storm moves through it |
| [10 — TARP reservoirs](docs/10-tarp-reservoirs.md) | Majewski (1998), Thornton Composite (2015, 7.9 BG), McCook (2017–~2032, 10 BG), quarry mining, quantified benefits |
| [11 — Stickney WRP](docs/11-stickney-wrp.md) | The world's largest treatment plant (1930/1939), 1.44 BGD peak, biosolids from Imhoff tanks to Fulton County, phosphorus recovery |
| [12 — Calumet & O'Brien WRPs](docs/12-calumet-obrien-wrp.md) | The 1922 and 1928 plants, 2016 disinfection additions (chlorination / world's-largest UV), current expansions |
| [13 — Suburban WRPs](docs/13-suburban-wrps.md) | Kirie, Egan, Hanover Park, Lemont — capacities, service areas, the suburban solids chain |
| [14 — CSOs, outfalls & discharges](docs/14-cso-outfalls-discharges.md) | Where everything discharges, every river→lake reversal year, the "does Deep Tunnel work?" debate, green infrastructure |
| [15 — The Calumet-region lakes](docs/15-calumet-lakes-transformation.md) | Lake Calumet's harbor dredging and slag filling, Wolf Lake's dikes, vanished Hyde Lake, and where the Cal-Sag spoil went |
| [16 — Current capital projects (2026 snapshot)](docs/16-current-capital-projects.md) | **A dated snapshot, not a finished history** — McCook Reservoir Stage 2, O'Brien's $409M Battery E (MWRD's largest contract ever), North Branch PS rehab, Thornton odor control, Stickney/Calumet/Kirie contracts, CAMP interceptor rehab, DWM water main & lead-line pace, Central Park PS electrification, the Chicago–Grand Prairie pipeline, Brandon Road, Chicago Harbor Lock |

## Images (`images/`)

~810 images organized **by subject, then era** (e.g. `cribs/1850-1899/`,
`tarp-tunnels/2000-present/`). Highlights: 1890s glass-negative photos of the canal
excavation, 1925–1960 Chicago Sewers Collection construction photos, HAER documentation
of the locks and pumping stations, 1928–1930 North Branch Pumping Station construction
photos, Jardine construction aerials (1962–65), and TBM/reservoir photos from the TARP era.

Every image's provenance (source page, date, rights) is in [images/INDEX.md](images/INDEX.md);
the per-agent download logs are in `images/_catalogs/`.

Subjects: `cribs` · `purification-plants` · `water-pumping-stations` · `sewer-construction` ·
`canals-river-reversal` · `mwrd-pumping-stations` · `tarp-tunnels` · `tarp-reservoirs` ·
`treatment-plants-{stickney,calumet,obrien,suburban}` · `waterways-locks` · `maps-diagrams`

## Primary documents (`sources/`)

~180 documents (2.5 GB) downloaded for offline reference, organized by topic. Beyond the agency
fact sheets and HAER reports: Sanitary District annual reports and board proceedings (1900–1922),
Brown's 1894 *Drainage Channel and Waterway*, nine volumes of the Journal of the Western Society
of Engineers (1896–1914) with the Chicago papers pinpointed by page, ISWS Bulletin 23 (1927),
the 1976–77 TARP environmental impact statements, the 1988 EPA TARP evaluation, GAO's 1979
six-volume Chicago flooding case study, USACE diversion-accounting reports back to 1981, the
1990 CUP O'Hare design memorandum, and the Supreme Court opinions behind the diversion cap.
Listed with descriptions at the end of [SOURCES.md](SOURCES.md).

## Method & caveats

- Built by parallel research agents (July 2026), each doc then independently fact-checked
  against its cited sources, then cross-audited for consistency between documents.
- Where authoritative sources genuinely disagree (e.g. TARP mileage 109.4 vs 110.4,
  Stickney's 1930 vs 1931 opening, Dunne Crib 1909 vs 1911), the documents present **both
  figures with attribution** rather than silently picking one — see each doc's *Open questions*.
- To view the map locally, open [index.html](index.html) directly in any browser (no server
  needed) — its links automatically fall back to the raw `.md` files and image folders when
  opened from disk. The published site serves rendered pages and galleries instead.
- `images/` (its own repo, [chicago-water-images](https://github.com/boswald314/chicago-water-images))
  and `sources/` are not part of this repo: ~54 rights-restricted images and the ~2.8 GB of
  source documents stay local-only. See [ATTRIBUTION.md](ATTRIBUTION.md) for the rights policy.
