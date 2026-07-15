# MWRD GIS layers — sources, coverage, and licensing

Downloaded 2026-07-14 from MWRD's public ArcGIS Online organizational account
(`MWRDGC`, org ID `R2OqRHzOVTbwcOgY`) and one Enterprise-federated server
(`utility.arcgis.com`) linked from `geohub.mwrd.org`. Enumerated by paging
`https://www.arcgis.com/sharing/rest/search?q=owner:MWRDGC` (250 items total,
3 pages) rather than by crawling the Hub site UI, since the Hub site itself
renders client-side and doesn't expose a plain dataset listing to fetch tools.
Every layer below returned HTTP 200 unauthenticated (`access: public`) at
query time, so all can be re-fetched by the same URL pattern:
`<FeatureServer_or_MapServer_layer_url>/query?where=1=1&outFields=*&f=geojson&outSR=4326`
(add `&resultOffset=N` to paginate if a query hits `exceededTransferLimit` —
none of these did).

**Licensing**: no ArcGIS item in this account carries an explicit
`licenseInfo` (checked via `/sharing/rest/content/items/<id>?f=json` for
every layer saved here — all came back `null` or empty, one exception below).
`CSO Monitoring Areas` has `accessInformation: MWRDGC` (i.e., attribute to
MWRD). geohub.mwrd.org's Terms of Use page is JS-rendered and didn't yield
readable text to WebFetch; it wasn't hand-browsed. Treat these as public,
unauthenticated open data with no stated redistribution license — attribute
"MWRD GeoHub" and link back to the item pages given below if republishing.

---

## Priority layers (directly relevant to TARP/CSO infrastructure)

### `cso-outfall-points.geojson` — CSO_Points
- **Item**: https://www.arcgis.com/home/item.html?id=7e6f111a69d84972993ef52ad986dc80
- **Service**: `https://services.arcgis.com/R2OqRHzOVTbwcOgY/arcgis/rest/services/CSO_Points/FeatureServer/0`
- **Geometry**: Point | **Features**: 441 | **Last edited**: 2025-12-30 (per service `editingInfo`)
- **Fields**: `OWNER`, `OUTFALL_CITY`, `WATERWAY_REACH`, `TARP_CONNECTION`, `LOCATION`, `M_OR_U` (Monitored/Unmonitored), `GLOBALID`
- **What it is**: every permitted combined-sewer-overflow outfall in the
  MWRD service area (city of Chicago plus ~50 suburban owners — Evanston,
  Maywood, Brookfield, Riverside, Skokie, etc., see owner breakdown below).
  273 monitored, 168 unmonitored.
- **Why it matters for TARP**: the `TARP_CONNECTION` field carries MWRD's own
  drop-shaft/tide-gate/collecting-structure identifiers — e.g.
  `DS-M90 & DS-M91 (NBPS)` at "North Branch P.S. (E)" (OBJECTID 291,
  -87.6737/41.9573 area — the North Branch Pumping Station outfall the
  archive already documents in doc 08), `Indirect (DS-M90)` at "Grace St (W)"
  (OBJECTID 48). Prefix breakdown across all 441 features: 245 `DS-*` (drop
  shaft), 75 `I-*`/`I` numbered interceptor connections, 54 `CDS-*`
  (Calumet drop shaft), 23 `TG-*` (tide gate), 11 `UDP-*` (Upper Des
  Plaines/O'Hare system), 7 `CI-*` (Calumet interceptor), 2 `CSSC-*` (direct
  Sanitary & Ship Canal connections at Lemont WRP and Stephen St), plus a few
  named structures (`Wilmette Gate`, `Chicago River Controlling Works`,
  `OBrien Lock and Dam`, `18E-PS`).
- **Caveat**: these are surface CSO *outfall* points (where a local combined
  sewer discharges to a waterway, or the collecting-structure diversion
  chamber at that outfall), not the underground drop-shaft shaft-bottom
  coordinate 150-300 ft below. For most `DS-*`/`CDS-*`/`TG-*` codes the
  outfall and the shaft are steps of the same structure at essentially the
  same street location (per the collecting-structure description in
  `sources/tarp-deep-tunnel/1976-epa-draft-eis-tarp-calumet-tunnel-system.pdf`
  pp.232-234: "consists of a diversion unit at the overflow point and a
  connecting pipe to the entrance chamber of the drop shaft... located near
  curbs or low points of major public thoroughfares"), so this is the best
  available public proxy for drop-shaft street location, just not a
  shaft-centerline survey point.
- **Cross-check available in archive**: `sources/court-consent-decrees/2011-epa-doj-mwrd-consent-decree.pdf`
  pp.97-100+ contains a table pairing `DS-*`/`TG-*` codes to street
  cross-references (e.g. "Western Ave (S) DS-M21", "Rockwell St (N) DS-M20",
  "California Ave (S) DS-M19") — use this to sanity-check individual
  GIS points against the documented street location before trusting a code.

### `flood-control-tarp-reservoirs.geojson` — "Flood Control and TARP Reservoirs" (layer "Reservoirs")
- **Item**: https://www.arcgis.com/home/item.html?id=6868b3cafb8f489e8790399f14f6bbee
  (title "Flood Control and TARP Reservoirs")
- **Service**: `https://utility.arcgis.com/usrsvcs/servers/6868b3cafb8f489e8790399f14f6bbee/rest/services/Stormwater_Planning/Stormwater_Planning_and_Projects/MapServer/1`
  — served from an Enterprise server federated into the MWRDGC org (not
  `services.arcgis.com`); works unauthenticated.
- **Geometry**: Point | **Features**: 37 (34 `Type=Flood Control Reservoir`, 3 `Type=TARP`)
- **Fields**: `City`, `Name`, `Year_Built`, `Type`, `watershedcode`, `watershed`, `storage_acft`, `storage_gal`, `Latitude`, `Longitude`
- **The 3 TARP reservoirs** (the ones relevant to this project):
  - Thornton Composite — 41.582253, -87.619819 — Thornton, built 2016, 24,244 ac-ft (7.9 BG)
  - Gloria Alitto Majewski — 42.016997, -87.944623 — Elk Grove Township, built 1998, 1,178 ac-ft
  - McCook — 41.779002, -87.833370 — Bedford Park, built 2017 (Stage 1), 10,740 ac-ft
  - A sibling item `MWRD Flood Control Reservoirs` (id `15521249e8e040f5b6f33b6920e7082c`)
    exists in the same account but its service (`.../rest/services/Flood_Control_Reservoirs/FeatureServer`)
    returned HTTP 403 `GWM_0003` (no permission) even though the item metadata
    says `access: public` — likely a stale/superseded duplicate; skipped in
    favor of this working layer.
- **Note on `Latitude`/`Longitude` fields vs. `geometry`**: the two don't
  always match to the last decimal (sub-10m rounding differences, e.g.
  reservoir #1 has `Latitude: 41.75385451` vs geometry
  `41.75386233273135`) — use `geometry`, not the attribute fields, as the
  authoritative coordinate.

### `combined-sewer-areas.geojson` — Combined_Sewer_Areas
- **Item**: https://www.arcgis.com/home/item.html?id=ed07c9babf994342a2f6fa5a6b7ab431
- **Service**: `https://services.arcgis.com/R2OqRHzOVTbwcOgY/arcgis/rest/services/Combined_Sewer_Areas/FeatureServer/0`
- **Geometry**: Polygon | **Features**: 54
- **Fields**: `Type`, `Area_AC`, `Notes`, `Date_Added`, `Permit_Reference`, `Basin`, `Plant`
- Municipal-scale polygons delineating where combined (vs. separate)
  sewers exist, tagged to a treatment plant/basin. Useful context for which
  TARP subsystem serves a given CSO point, not itself tunnel/shaft geometry.

### `cso-monitoring-areas.geojson` — CSO_Monitoring_Areas
- **Item**: https://www.arcgis.com/home/item.html?id=07a47b1938594663988d09b1ebfa7e7b
- **Service**: `https://services.arcgis.com/R2OqRHzOVTbwcOgY/arcgis/rest/services/CSO_Monitoring_Areas/FeatureServer/0`
- **Geometry**: Polygon | **Features**: 3 (`CSO_Area` = North, Stickney/Mainstream, Calumet — matches the
  3 CSO Monitoring hub pages linked from geohub.mwrd.org/pages/cso)
- **Fields**: `CSO_Area`, `Shape__Area`, `Shape__Length`

---

## Supporting layers (facility locations, saved for cross-checking existing map-data)

### `water-reclamation-plants.geojson` — Water_Reclamation_Plants
- **Item**: https://www.arcgis.com/home/item.html?id=ebfc1a316dba468eb4bb472e602bcf84
- **Service**: `https://services.arcgis.com/R2OqRHzOVTbwcOgY/arcgis/rest/services/Water_Reclamation_Plants/FeatureServer/0`
- **Geometry**: Point | **Features**: 7 (all 7 WRPs, with street address + phone)
- A near-duplicate item `Water_Reclamation_Facilities` (id
  `6c7db247a737412db14f4404a38d322c`, same 7 coordinates, fewer fields — just
  `NAME`/`TYPE`) exists in the same account; not saved separately since this
  layer is a strict superset.
- **Cross-check against existing `map-data/facilities.json`** (haversine distance,
  existing marker vs. this MWRD point):
  - Lemont WRP: 23 m (matches)
  - Kirie WRP: 61 m (matches)
  - O'Brien WRP: 248 m (close)
  - Hanover Park WRP: 146 m (close)
  - Calumet WRP: 712 m (existing marker likely off)
  - Stickney WRP: 1,389 m (existing marker likely off)
  - **Egan WRP: 5,850 m** — existing `facilities.json` has (42.0722, -88.0439);
    MWRD's point + address (550 S Meacham Rd, Schaumburg, IL 60193) is
    (42.019754, -88.038322). The existing marker sits ~5.9 km north of the
    actual plant, near Streamwood/Hanover Park rather than Schaumburg — this
    is very likely one of the errors flagged by the user.

### `mwrd-sepa-stations.geojson` — MWRD_SEPA_Station
- **Item**: https://www.arcgis.com/home/item.html?id=73064fddd49249c886a3b19896ad359e
- **Service**: `https://services.arcgis.com/R2OqRHzOVTbwcOgY/arcgis/rest/services/MWRD_SEPA_Station/FeatureServer/0`
- **Geometry**: Point | **Features**: 6
- **Fields**: `name`, `description`, `icon_color`, `pic_url`, `thumb_url`
- Sidestream Elevated Pool Aeration stations — not TARP infrastructure but
  saved since it was already enumerated; low priority.

### `mwrd-waterways.geojson` — "MWRD Waterways"
- **Item**: https://www.arcgis.com/home/item.html?id=3d035149ba124b94a6beb5c0431333f3
- **Service**: `https://services.arcgis.com/R2OqRHzOVTbwcOgY/arcgis/rest/services/MWRD%20Waterways/FeatureServer/0`
  (note the literal space in the service name — must be percent-encoded `%20` in the URL)
- **Geometry**: Polyline | **Features**: 273 | **File size**: ~10 MB (large — surface
  hydrography detail, not simplified)
- **Fields**: `WATERWAY_NAME`, `FROM_FC`, `Shape__Length`
- MWRD's own surface-waterway centerlines (rivers, creeks, ditches, the
  Sanitary & Ship Canal, Cal-Sag Channel, North Shore Channel, etc.) — no
  TARP tunnel names appear in it (checked all 273 `WATERWAY_NAME` values).
  Saved as a **better substitute for the OpenStreetMap surface-corridor
  tracing** the existing `tunnels.json` approximations openly say they used
  as a stand-in for real tunnel alignment (TARP tunnels run 150-300 ft below
  these same surface corridors) — an MWRD-sourced corridor is a strictly
  better proxy than OSM for that specific approximation technique, though it
  is still NOT a tunnel centerline and should not be presented as one.

---

## Checked and rejected / not found

- **No TARP tunnel centerline layer exists in MWRD's public GIS.** Full
  enumeration of all 250 items owned by `MWRDGC` on ArcGIS Online (searched
  `owner:MWRDGC`, 3 pages) turned up no tunnel, drop-shaft-structure (as
  distinct from the CSO outfall proxy above), air-vent, or intercepting-sewer
  alignment layer of any kind.
- **No such layer on Chicago's own open-data portal.** `data.cityofchicago.org`
  catalog API searches for `sewer`, `TARP`, `tunnel`, `MWRD`, `storm`,
  `interceptor` restricted to `domains=data.cityofchicago.org` returned
  nothing infrastructure-related (the unrestricted federated-catalog search
  returns hundreds of false positives from unrelated cities' Socrata
  portals — e.g. NYC MTA "Bridges & Tunnels" datasets — domain restriction is
  required to get real Chicago results, and even then there's nothing).
- **No such layer on Cook County's GIS hub** (`hub-cookcountyil.opendata.arcgis.com`;
  checked via ArcGIS Online `owner:Cook_County_GIS` + keyword search, zero
  results for "sewer" or "TARP").
- **Illinois Geospatial Data Clearinghouse** (`clearinghouse.isgs.illinois.edu`)
  is a statewide land-cover/imagery hub, not a utility-infrastructure
  repository — not pursued further after confirming its scope via search.
- **`MWRD Flood Control Reservoirs`** (id `15521249e8e040f5b6f33b6920e7082c`) —
  item exists and claims public access but its `FeatureServer` returns HTTP
  403; superseded by the working `Flood Control and TARP Reservoirs` layer
  saved above.
- **`tarp_tunnels` web map** (ArcGIS Online id `7fa36972b8ee43a6a14377c558528ad7`,
  owner `santsasa`, created 2017) — a **personal, non-MWRD** web map with two
  embedded polyline feature collections named `Mainstream_DeepTunnel` (341
  vertices) and `Calumet_DeepTunnel` (235 vertices) that, on the surface,
  look like exactly what this task is hunting for. **Deliberately not
  adopted or saved.** The item has no description, no source citation, no
  metadata establishing how it was digitized, and isn't owned by MWRD's
  organizational account — there's no way to verify its accuracy against a
  primary source, and treating an anonymous hobbyist's 9-year-old sketch as
  "authoritative" would repeat the exact problem this task exists to fix.
  Flagging its existence (item id above) in case a future pass wants to
  eyeball it as a *hypothesis* to check against the archive's EIS
  route-description text — not as a coordinate source.
- **`TARP_GIS.pdf`** (`https://mwrd.org/sites/default/files/documents/TARP_GIS.pdf`,
  linked from search results) — turned out to be a 2019 MWRD internship
  job posting for a "TARP/GIS Intern," not a data document. Notable only
  for confirming MWRD's internal system is called **IMGIS** ("Infrastructure
  Management GIS") and does track structure-level detail (manholes, tide
  gates, presumably drop shafts) from as-built drawings — but this system is
  not exposed on `geohub.mwrd.org` or the public ArcGIS Online account.

## Bottom-line finding

MWRD does not publish tunnel centerlines, drop-shaft/connecting-structure
points, air-vent/control-structure points, or intercepting-sewer alignments
as open GIS data anywhere searched (their own GeoHub, ArcGIS Online, Chicago's
open-data portal, Cook County's open-data portal). This is very plausibly
deliberate — critical wastewater-conveyance infrastructure — and matches the
pattern that their own internal detailed system (IMGIS) is referenced only
in an internship posting, never exposed publicly. The **closest authoritative
public proxy for drop-shaft locations is `cso-outfall-points.geojson`**
(`TARP_CONNECTION` field), and the **TARP reservoirs now have exact,
MWRD-sourced coordinates** in `flood-control-tarp-reservoirs.geojson`, which
should directly replace the corresponding points in `map-data/facilities.json`
(see distance deltas above — Thornton Composite is 654 m off, McCook Stage 1
is 1,201 m off from the current archive coordinates). No tunnel *centerline*
correction is possible from public sources; the existing `tunnels.json`
approximations (which openly document their own use of surface-corridor
stand-ins) remain the best available short of an actual as-built exhibit
from an MWRD EIS/contract document already in `sources/tarp-deep-tunnel/`.
