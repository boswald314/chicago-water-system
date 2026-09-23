#!/usr/bin/env python3
"""Build map-data/system3d.js (window.SYS3D) for the 3D sewer-system model page.

Takes the archive's existing sourced GIS/JSON (facilities, TARP alignments, drop
shafts, CSO outfall points, combined-sewer-area polygons, recorded CSO events)
and projects it into a local east-north-up metre frame, then attaches the
engineering dimensions (pipe diameters, tank sizes, pump counts, storage
volumes) taken from the archive's own cited documents.

Provenance convention: every engineering number is emitted as
    {"v": <value>, "u": <unit>, "s": <source tag>}
where <source tag> is a docs/NN key (sourced), "derived" (computed here from
sourced inputs -- the computation is named in the note), or "assumed" (typical
engineering practice, NOT sourced; the viewer renders these differently).

Run from anywhere: python3 scripts/build_system3d.py
"""
import json, math, os, csv, collections, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MD = os.path.join(ROOT, 'map-data')

# ---------------------------------------------------------------- projection
# Local tangent plane, metres. x = east, z = south (three.js: y is up, so a
# north bearing points toward -z). Origin chosen near the centroid of the
# combined-sewer service area.
LAT0, LNG0 = 41.85, -87.75
M_PER_DEG_LAT = 111132.0
M_PER_DEG_LNG = 111320.0 * math.cos(math.radians(LAT0))

def proj(lat, lng):
    return (round((lng - LNG0) * M_PER_DEG_LNG, 1),
            round(-(lat - LAT0) * M_PER_DEG_LAT, 1))

FT = 0.3048
MG_TO_CUFT = 133680.556 / 1000.0   # 1 MG = 133,680.556 cu ft
def mg_to_m3(mg):  return mg * 3785.411784
def acres_to_m2(a): return a * 4046.8564224

def S(v, u, s, note=None):
    d = {'v': v, 'u': u, 's': s}
    if note: d['n'] = note
    return d

def load(p, default=None):
    f = os.path.join(MD, p)
    if not os.path.exists(f):
        return default
    return json.load(open(f))

# ------------------------------------------------------------ source registry
SOURCES = {
    'doc06': ['City of Chicago sewer network', 'docs/06-city-sewer-network.html'],
    'doc07': ['MWRD interceptors & pumping stations', 'docs/07-mwrd-interceptors-pumping-stations.html'],
    'doc09': ['TARP Phase I: the Deep Tunnel', 'docs/09-tarp-deep-tunnel.html'],
    'doc10': ['TARP Phase II reservoirs', 'docs/10-tarp-reservoirs.html'],
    'doc11': ['Stickney WRP', 'docs/11-stickney-wrp.html'],
    'doc12': ['Calumet & O’Brien WRPs', 'docs/12-calumet-obrien-wrp.html'],
    'doc13': ['Suburban WRPs', 'docs/13-suburban-wrps.html'],
    'doc14': ['CSO outfalls & discharges', 'docs/14-cso-outfalls-discharges.html'],
    'gis':   ['MWRD public ArcGIS layers', 'map-data/gis/SOURCES.md'],
    'csv':   ['MWRD pumping-station CSO activity log', 'data/index.html'],
    'derived': ['computed in scripts/build_system3d.py from sourced inputs', None],
    'assumed': ['typical engineering practice — NOT sourced', None],
}

# ============================================================ TARP tunnel spec
# Diameter and depth ranges are sourced per system (doc09/doc07). Individual
# segment diameters are NOT published, so each feature below carries the
# upstream/downstream diameter it is drawn between; the viewer interpolates
# along the feature and labels the result "interpolated".
# f0/f1 place each feature on its system's normalised upstream->downstream axis
# (parallel branches share a range). The viewer uses the same axis for flow.
TUNNEL_SPEC = {
    'tarp-mainstream-nsc-leg': dict(system='mainstream', f0=0.00, f1=0.45, zUp=240, zDn=262, order=0),
    'tarp-mainstream-north-branch-leg': dict(system='mainstream', f0=0.00, f1=0.45, zUp=240, zDn=262, order=0),
    'tarp-mainstream-river-leg': dict(system='mainstream', f0=0.45, f1=0.60, zUp=262, zDn=275, order=1),
    'tarp-mainstream-main-leg': dict(system='mainstream', f0=0.60, f1=1.00, zUp=275, zDn=300, order=2),
    'tarp-des-plaines-13a-spur': dict(system='desplaines', f0=0.00, f1=0.20, zUp=160, zDn=190, order=0),
    'tarp_des_plaines': dict(system='desplaines', f0=0.10, f1=1.00, zUp=170, zDn=300, order=1),
    'tarp-calumet-torrence-leg': dict(system='calumet', f0=0.00, f1=0.35, zUp=160, zDn=200, order=0),
    'tarp-calumet-little-calumet-leg': dict(system='calumet', f0=0.00, f1=0.35, zUp=160, zDn=200, order=0),
    'tarp_calumet': dict(system='calumet', f0=0.35, f1=1.00, zUp=200, zDn=300, order=1),
    'tarp_upper_des_plaines_ohare': dict(system='udp', f0=0.0, f1=1.0, zUp=150, zDn=200, order=0,
                                         segs=[(9, 0.0, 0.06), (16, 0.06, 0.36), (20, 0.36, 1.0)]),
}

# each system's downstream terminus -- used to orient every polyline
DOWNSTREAM = {'mainstream': (41.7795, -87.8398), 'desplaines': (41.7790, -87.8334),
              'calumet': (41.6664, -87.5980), 'udp': (42.0173, -87.9447)}

SYSTEMS = {
    'mainstream': dict(
        name='Mainstream Tunnel System', color='#c98a2e',
        lengthMi=S(40.5, 'mi', 'doc09'), storageMG=S(1200, 'MG', 'doc09'),
        diaFt=S([8, 33], 'ft', 'doc09', 'MWRD’s facility page gives 13–33 ft; the 1972-plan-derived 8 ft low end is used here'),
        depthFt=S([240, 300], 'ft', 'doc09'),
        route='Wilmette Pumping Station south to the Mainstream Pumping Station, Hodgkins',
        pump='ps-mainstream', reservoir='res-mccook', plant='wrp-stickney', basins=['NORTH', 'CENTRAL']),
    'desplaines': dict(
        name='Des Plaines Tunnel System', color='#b5762a',
        lengthMi=S(26.6, 'mi', 'doc07', '25.6 mi in MWRD’s 2017 report; 26.6 mi in the 2024–25 reports'),
        storageMG=S(420, 'MG', 'doc07', '405–420 MG across report years'),
        diaFt=S([10, 33], 'ft', 'doc07'), depthFt=S([150, 300], 'ft', 'doc09'),
        route='Des Plaines River corridor, converging on McCook Reservoir and the Mainstream Pumping Station',
        pump='ps-mainstream', reservoir='res-mccook', plant='wrp-stickney', basins=['CENTRAL']),
    'calumet': dict(
        name='Calumet Tunnel System', color='#7fae3f',
        lengthMi=S(36.7, 'mi', 'doc09'), storageMG=S(630, 'MG', 'doc09'),
        diaFt=S([9, 30], 'ft', 'doc09'), depthFt=S([150, 300], 'ft', 'doc09'),
        route='Cal-Sag Channel and Little Calumet River to the Indiana state line, converging on the Calumet TARP Pumping Station',
        pump='ps-calumet-tarp', reservoir='res-thornton', plant='wrp-calumet', basins=['SOUTH']),
    'udp': dict(
        name='Upper Des Plaines (O’Hare) Tunnel System', color='#4aa3c4',
        lengthMi=S(6.6, 'mi', 'doc09'), storageMG=S(70, 'MG', 'doc09'),
        diaFt=S([9, 20], 'ft', 'doc09', '20 ft for 4.2 mi, 16 ft for 2.0 mi, 9 ft for the remainder'),
        depthFt=S([150, 200], 'ft', 'doc09'),
        route='Arlington Heights / Mount Prospect / Des Plaines, north and east of O’Hare, by gravity to Majewski Reservoir',
        pump='ps-ohare-udp', reservoir='res-majewski', plant='wrp-kirie', basins=['OHARE'],
        gravity=True),
}

# =============================================================== facility spec
# Every dimension below traces to the archive document named in its 's' tag.
FAC_SPEC = {
    # ---- water reclamation plants -----------------------------------------
    'wrp-stickney': dict(
        kind='wrp', label='Stickney WRP', short='Stickney',
        daf=S(1200, 'MGD', 'doc11'), dmf=S(1440, 'MGD', 'doc11'),
        avg=S(685, 'MGD', 'doc11', '2024 annual average'),
        acres=S(413, 'acre', 'doc11', 'MWRD’s own fact sheet; a secondary source says 570 acres'),
        basin='CENTRAL', doc='doc11',
        note='The largest wastewater treatment plant in the world by design capacity. Receives dry-weather flow through the intercepting sewers and Racine Avenue PS, plus everything the Mainstream Pumping Station lifts out of the Deep Tunnel and McCook Reservoir.',
        units=[
            dict(id='grit', label='Aerated grit tanks', n=S(6, 'tanks', 'doc11'), train='water', stage=1,
                 shape='box', L=S(132, 'ft', 'doc11'), W=S(40, 'ft', 'assumed'), D=S(14, 'ft', 'assumed'),
                 note='Grit \u2014 sand, grit and eggshell \u2014 settles out here so it cannot wear out '
                      'the pumps and pipework downstream. Air keeps the organic matter in suspension.'),
            dict(id='primary', label='Primary settling tanks', n=S(9, 'tanks', 'doc11'), train='water', stage=2,
                 shape='cyl', dia=S(160, 'ft', 'doc11'), D=S(14, 'ft', 'assumed'),
                 note='Nine 160-ft circular tanks built 2013–2018 under Contract 04-128-3P, replacing Imhoff Batteries A and B.'),
            dict(id='imhoff', label='Imhoff tanks, Battery C (original)', n=S(36, 'tanks', 'doc11', 'Battery C share of ~108 tanks across three batteries'),
                 train='water', stage=2,
                 shape='box', L=S(120, 'ft', 'assumed'), W=S(20, 'ft', 'assumed'), D=S(30, 'ft', 'assumed'),
                 note='Batteries A and B were demolished by 2018; Battery C is slated for retirement under the 2009 master plan.'),
            dict(id='aeration', label='Activated-sludge aeration tanks', acres=S(36, 'acre', 'doc11'),
                 train='water', stage=3,
                 shape='basin-array', D=S(15, 'ft', 'assumed'), lanes=S(4, 'passes', 'assumed'),
                 note='Air blown through 36 acres of tank keeps a cultivated population of '
                      'microorganisms eating the dissolved and suspended organic load. 10,000 hp '
                      'blowers at 13 kV supply the air.'),
            dict(id='final', label='Final settling tanks', n=S(96, 'tanks', 'doc11', 'single-source figure, unverified elsewhere'),
                 train='water', stage=4,
                 shape='cyl', dia=S(125, 'ft', 'assumed'), D=S(12, 'ft', 'assumed'),
                 note='The activated sludge settles back out; most of it is returned to the head of '
                      'the aeration tanks, and the clarified water goes to the canal.'),
            dict(id='digest', label='Anaerobic digesters', n=S(12, 'digesters', 'assumed'),
                 train='solids', stage=5,
                 shape='cyl', dia=S(110, 'ft', 'assumed'), D=S(35, 'ft', 'assumed'),
                 note='Digests Stickney’s own solids plus imported solids from Egan, Kirie, O’Brien and Lemont.'),
        ],
        extras=[dict(label='Main lift pumps', v='3,600 hp motors each, ~55 ft lift from sewer level to plant grade', s='doc11'),
                dict(label='Air blowers', v='10,000 hp motors at 13 kV', s='doc11'),
                dict(label='Nutrient Recovery Facility', v='3 Ostara Pearl 10K reactors, ~9,000 t/yr Crystal Green', s='doc11')]),
    'wrp-calumet': dict(
        kind='wrp', label='Calumet WRP', short='Calumet',
        daf=S(354, 'MGD', 'doc12'), dmf=S(430, 'MGD', 'doc12'),
        avg=S(354, 'MGD', 'doc12', 'MWRD labels 354 MGD the "average" volume; the NPDES permit defines it as design average flow'),
        acres=S(275.4, 'acre', 'doc12', 'MWRD’s 2025 fact sheet; its locations page says 470 acres'),
        basin='SOUTH', doc='doc12',
        note='Receives South-basin dry-weather flow and everything the Calumet TARP Pumping Station lifts out of the Calumet tunnel and Thornton Composite Reservoir.',
        units=[
            dict(id='grit', label='Grit facilities', n=S(4, 'tanks', 'assumed'), shape='box',
                 L=S(110, 'ft', 'assumed'), W=S(35, 'ft', 'assumed'), D=S(14, 'ft', 'assumed')),
            dict(id='primary', label='Primary settling tanks', n=S(8, 'tanks', 'assumed'), shape='cyl',
                 dia=S(140, 'ft', 'assumed'), D=S(14, 'ft', 'assumed')),
            dict(id='aeration', label='Aeration batteries (incl. new Battery D)', acres=S(14, 'acre', 'derived',
                 'scaled from Stickney’s sourced 36 acres by the ratio of design average flows (354/1200)'),
                 shape='basin-array', D=S(15, 'ft', 'assumed'), lanes=S(4, 'passes', 'assumed')),
            dict(id='final', label='Final settling tanks', n=S(28, 'tanks', 'assumed'), shape='cyl',
                 dia=S(125, 'ft', 'assumed'), D=S(12, 'ft', 'assumed')),
        ],
        extras=[dict(label='Disinfection', v='Sodium hypochlorite / sodium bisulfite retrofit of the chlorine contact chamber, in service 2016', s='doc12'),
                dict(label='2009 master plan', v='New 600-MGD high-level influent pumping station, two 75,000-SCFM blowers, Battery D; $507.2M', s='doc12')]),
    'wrp-obrien': dict(
        kind='wrp', label='O’Brien WRP', short='O’Brien',
        daf=S(333, 'MGD', 'doc12'), dmf=S(450, 'MGD', 'doc12'), avg=S(230, 'MGD', 'doc12'),
        acres=S(97, 'acre', 'doc12'), basin='NORTH', doc='doc12',
        note='Treats North-basin dry-weather flow. Its wet-weather overflow does NOT come back here — it goes down the Mainstream tunnel and is pumped 25 miles away at Hodgkins to Stickney.',
        units=[
            dict(id='grit', label='Grit facilities', n=S(4, 'tanks', 'assumed'), shape='box',
                 L=S(110, 'ft', 'assumed'), W=S(35, 'ft', 'assumed'), D=S(14, 'ft', 'assumed')),
            dict(id='primary', label='Primary settling tanks', n=S(8, 'tanks', 'assumed'), shape='cyl',
                 dia=S(130, 'ft', 'assumed'), D=S(14, 'ft', 'assumed')),
            dict(id='aeration', label='Aeration batteries A–E', acres=S(10, 'acre', 'derived',
                 'scaled from Stickney’s sourced 36 acres by design average flow (333/1200)'),
                 shape='basin-array', D=S(15, 'ft', 'assumed'), lanes=S(4, 'passes', 'assumed')),
            dict(id='final', label='Final settling tanks', n=S(24, 'tanks', 'assumed'), shape='cyl',
                 dia=S(120, 'ft', 'assumed'), D=S(12, 'ft', 'assumed')),
            dict(id='uv', label='UV disinfection facility', n=S(1, 'facility', 'doc12'), shape='box',
                 L=S(300, 'ft', 'assumed'), W=S(120, 'ft', 'assumed'), D=S(12, 'ft', 'assumed'),
                 note='896 low-pressure high-output UV lamps treating up to 450 MGD — the largest wastewater UV facility in the U.S. Opened March 2016, $61.7M.'),
        ]),
    'wrp-kirie': dict(kind='wrp', label='Kirie WRP', short='Kirie', daf=S(52, 'MGD', 'doc13'),
        dmf=S(110, 'MGD', 'doc13'), avg=S(40, 'MGD', 'assumed'), acres=S(108, 'acre', 'doc13'),
        basin='OHARE', doc='doc13', compact=True,
        note='Takes Majewski Reservoir’s stored flow back for treatment; discharges to Higgins Creek.'),
    'wrp-egan': dict(kind='wrp', label='Egan WRP', short='Egan', daf=S(30, 'MGD', 'doc13'),
        dmf=S(50, 'MGD', 'doc13'), avg=S(24, 'MGD', 'assumed'), acres=S(275.4, 'acre', 'doc13'),
        basin=None, doc='doc13', compact=True),
    'wrp-hanoverpark': dict(kind='wrp', label='Hanover Park WRP', short='Hanover Pk',
        daf=S(12, 'MGD', 'doc13'), dmf=S(22, 'MGD', 'doc13'), avg=S(9, 'MGD', 'assumed'),
        acres=S(289, 'acre', 'doc13'), basin=None, doc='doc13', compact=True),
    'wrp-lemont': dict(kind='wrp', label='Lemont WRP', short='Lemont', daf=S(2.3, 'MGD', 'doc13'),
        dmf=S(4, 'MGD', 'doc13'), avg=S(1.8, 'MGD', 'assumed'), acres=S(21.5, 'acre', 'doc13'),
        basin='LEMONT', doc='doc13', compact=True,
        note='Smallest of the seven plants. Its 5-MG underground wet-weather reservoir (~65.5 × 50 × 9 m) gives storm flow primary treatment and disinfection.'),

    # ---- TARP pumping stations --------------------------------------------
    'ps-mainstream': dict(
        kind='tarp-ps', label='Mainstream Pumping Station', short='Mainstream PS',
        pumps=S(8, 'pumps', 'doc09', 'two pump houses, four pumps each'),
        hp=S(17500, 'hp', 'doc09', 'largest pump'),
        liftFt=S(300, 'ft', 'doc09'),
        capMGD=S(1000, 'MGD', 'doc09', 'MWRD reports the station can move "more than one billion gallons" per day'),
        shaftDepthFt=S(300, 'ft', 'doc09'),
        riserFt=S(14, 'ft', 'derived',
            'Both doc09 and doc07 report a "14-inch" force main. At the station’s own stated ~1,000 MGD that is physically impossible (~181 ft/s per pump); 14 FEET is the only reading consistent with the pumping rate, so the riser is drawn at 14 ft and the published figure is flagged.'),
        conflict='Published dimension "14-inch force main" is not physically compatible with the published ~1,000 MGD capacity. Drawn at 14 ft. See the model-notes panel.',
        doc='doc09', system='mainstream', plant='wrp-stickney',
        note='Dewaters the Mainstream and Des Plaines tunnels and, since 2017, McCook Reservoir, lifting flow ~300 ft to Stickney. Two independent 138,000-volt feeds.'),
    'ps-calumet-tarp': dict(
        kind='tarp-ps', label='Calumet TARP Pumping Station', short='Calumet TARP PS',
        pumps=S(6, 'pumps', 'doc09'), capCFS=S(535, 'cfs', 'doc09', 'six-pump design capacity'),
        capMGD=S(346, 'MGD', 'derived', '535 cfs ÷ 1.547 cfs-per-MGD, MWRD’s own conversion'),
        liftFt=S(365, 'ft', 'doc09'), shaftDepthFt=S(365, 'ft', 'doc09'),
        riserFt=S(4.5, 'ft', 'doc09', 'custom 54-in. × 36-in. eccentric reducing elbow'),
        doc='doc09', system='calumet', plant='wrp-calumet',
        note='Pump-room floor about 365 ft below grade — one of the lowest inhabited points in the Chicago area. Dewaters the Calumet system in roughly two days.'),
    'ps-ohare-udp': dict(
        kind='tarp-ps', label='O’Hare / Upper Des Plaines TARP Pumps', short='O’Hare UDP PS',
        pumps=S(4, 'pumps', 'assumed'), capMGD=S(110, 'MGD', 'doc09',
            'set by Kirie WRP’s design maximum flow, which the pumps feed'),
        liftFt=S(60, 'ft', 'derived', 'Majewski working range −2 to +58 ft CCD'),
        shaftDepthFt=S(60, 'ft', 'doc10'), riserFt=S(6, 'ft', 'assumed'),
        doc='doc09', system='udp', plant='wrp-kirie',
        note='The Upper Des Plaines tunnel is a pure gravity system: flow reaches Majewski Reservoir without pumping, and only the return leg to Kirie is pumped.'),

    # ---- MWRD sewage pumping stations (surface, interceptor relief) --------
    'ps-racine': dict(
        kind='sewage-ps', label='Racine Avenue Pumping Station (RAPS)', short='Racine Ave PS',
        pumps=S(14, 'pumps', 'doc07', 'originally 6 in 1939, expanded to 14 by 1954'),
        capCFS=S(6000, 'cfs', 'doc07', 'maximum combined discharge in extreme storms'),
        capMGD=S(3878, 'MGD', 'doc07'), areaSqMi=S(30, 'sq mi', 'doc07', 'USACE 2020; MWRD-adjacent sources say 36 sq mi'),
        bldgSqFt=S(33000, 'sq ft', 'doc07'), doc='doc07', basin='CENTRAL',
        shafts=S(3, 'TARP drop shafts', 'doc07'),
        note='Four converging intercepting sewers from a 30-sq-mi South Side area, downtown to 87th St. Discharges to Bubbly Creek when the tunnel and reservoir are full. The single largest CSO source in the recorded log.'),
    'ps-north-branch': dict(
        kind='sewage-ps', label='North Branch (Lawrence Avenue) Pumping Station', short='North Branch PS',
        pumps=S(8, 'pumps', 'doc07', 'five 300-cfs storm pumps + three 75-cfs dry-weather pumps, as designed 1928'),
        capCFS=S(1725, 'cfs', 'derived', '5 × 300 cfs storm + 3 × 75 cfs dry-weather'),
        capMGD=S(1115, 'MGD', 'derived', '1,725 cfs ÷ 1.547'),
        stormPumpFt=S(6.0, 'ft', 'doc07', '72-in. discharge, 300 cfs, 800-hp synchronous motors'),
        dryPumpFt=S(3.5, 'ft', 'doc07', '42-in. discharge, 75 cfs, 100-hp motors'),
        doc='doc07', basin='NORTH',
        note='Built 1928–29 at Lawrence & Francisco. Drop shaft DS-LAT sits across the river in Ronan Park. 303 recorded discharge events totalling ~41,884 MG; the largest was 1,348.9 MG on 13 Sept 2008.'),
    'ps-95th': dict(kind='sewage-ps', label='95th Street Pumping Station', short='95th St PS',
        pumps=S(6, 'pumps', 'doc07', 'three 30-in. dry-weather at 35 cfs + three 72-in. storm at 250 cfs'),
        capCFS=S(855, 'cfs', 'doc07'), capMGD=S(553, 'MGD', 'doc07'),
        stormPumpFt=S(6.0, 'ft', 'doc07'), dryPumpFt=S(2.5, 'ft', 'doc07'),
        doc='doc07', basin='SOUTH'),
    'ps-122nd': dict(kind='sewage-ps', label='122nd Street Pumping Station', short='122nd St PS',
        pumps=S(4, 'pumps', 'assumed'), capCFS=S(375, 'cfs', 'doc07'), capMGD=S(242, 'MGD', 'doc07'),
        doc='doc07', basin='SOUTH'),
    'ps-125th': dict(kind='sewage-ps', label='125th Street Pumping Station', short='125th St PS',
        pumps=S(6, 'pumps', 'assumed'), capCFS=S(1140, 'cfs', 'doc07'), capMGD=S(737, 'MGD', 'doc07'),
        doc='doc07', basin='SOUTH'),
    'ps-westchester': dict(kind='sewage-ps', label='Westchester Pumping Station', short='Westchester PS',
        pumps=S(4, 'pumps', 'assumed'), capCFS=S(200, 'cfs', 'assumed',
            'MWRD does not publish this station’s pump count or capacity; sized here only so the model can route its recorded discharges'),
        capMGD=S(129, 'MGD', 'assumed'), doc='doc07', basin='CENTRAL',
        note='Relieves the Berkley-Hillside and Broadview-Bellwood intercepting sewers; CSO to Addison Creek at Outfall 150 (TARP structure DS-D34-AI).'),
    'ps-wilmette': dict(kind='sewage-ps', label='Wilmette Pumping Station', short='Wilmette PS',
        pumps=S(4, 'screw pumps', 'doc07', '250 cfs each at 3.0-ft lift, 9-ft-diameter propellers; only 2 of 4 in service'),
        capCFS=S(1000, 'cfs', 'doc07'), capMGD=S(646, 'MGD', 'derived', '1,000 cfs ÷ 1.547'),
        screwFt=S(9.0, 'ft', 'doc07'), doc='doc07', basin='NORTH',
        note='North end of the Mainstream tunnel and the head of the North Shore Channel.'),

    # ---- reservoirs --------------------------------------------------------
    'res-mccook': dict(
        kind='reservoir', label='McCook Reservoir', short='McCook',
        capMG=S(3500, 'MG', 'doc10', 'Stage 1, dedicated 4 Dec 2017'),
        capFullMG=S(10000, 'MG', 'doc10', 'Stage 1 + Stage 2, design total; Stage 2 target now 31 Dec 2032'),
        depthFt=S(300, 'ft', 'doc10'), shape='pit', wallSlope=S(0.18, 'H:V', 'assumed'),
        doc='doc10', system='mainstream', pump='ps-mainstream', plant='wrp-stickney',
        note='Mined out of dolomite next to the Stickney plant’s Lawndale Avenue solids lagoons, ringed by a double-row grout curtain ~350–370 ft deep around a 3-mile perimeter. ~137.9 BG captured through Sept 2025. Aerated by coarse-bubble diffusers and floating solar surface aerators.',
        stage2=True),
    'res-thornton': dict(
        kind='reservoir', label='Thornton Composite Reservoir', short='Thornton',
        capMG=S(4800, 'MG', 'doc10', 'CSO/TARP share'),
        capFullMG=S(7900, 'MG', 'doc10', 'total, including 3.1 BG of Thorn Creek overbank flood storage'),
        depthFt=S(292, 'ft', 'derived',
            'mean depth reconciling the sourced 7.9 BG total against the sourced 83-acre surface — the quarry itself reaches ~450 ft at its deepest'),
        surfaceAcres=S(83, 'acre', 'doc12'),
        shape='quarry', wallSlope=S(0.06, 'H:V', 'assumed'),
        doc='doc10', system='calumet', pump='ps-calumet-tarp', plant='wrp-calumet',
        note='A working aggregate quarry converted to the world’s largest CSO reservoir. The north lobe sits under I-80/294 behind a 32,000-cu-yd roller-compacted concrete dam; a ~1,300-ft, ~30-ft-diameter tunnel with four 100-ton gates connects it to the Calumet tunnel. ~64.9 BG captured through Dec 2025.'),
    'res-majewski': dict(
        kind='reservoir', label='Gloria Alitto Majewski Reservoir', short='Majewski',
        capMG=S(350, 'MG', 'doc10', 'USACE design figure 342.1 MG = 1,050 acre-ft'),
        capFullMG=S(350, 'MG', 'doc10'),
        depthFt=S(60, 'ft', 'doc10', 'working range −2 to +58 ft CCD, 22 ft below original grade'),
        surfaceAcres=S(30, 'acre', 'doc10', 'excavated footprint on a 105-acre site'),
        shape='basin', wallSlope=S(3.0, 'H:V', 'assumed', 'typical earth-basin side slope; a 3:1 frustum reconciles the sourced 30-acre top, 60-ft depth and 350-MG volume'),
        doc='doc10', system='udp', pump='ps-ohare-udp', plant='wrp-kirie',
        note='The pilot reservoir, completed 1998 next to Kirie WRP. An open surface basin, not a rock pit.'),
    'res-thornton-transitional': dict(
        kind='reservoir', label='Thornton Transitional Reservoir', short='Thornton TTR',
        capMG=S(3100, 'MG', 'doc10'), capFullMG=S(3100, 'MG', 'doc10'),
        depthFt=S(150, 'ft', 'assumed'), surfaceAcres=S(63, 'acre', 'derived', 'volume ÷ assumed depth'),
        shape='quarry', wallSlope=S(0.06, 'H:V', 'assumed'), retired=True,
        doc='doc10', system='calumet',
        note='West lobe of the quarry, in service March 2003, decommissioned September 2022 after capturing 58+ BG in 83 fill events. Drawn faded: standing but retired.'),
}

# map archive facility ids -> our spec ids
FAC_ID_MAP = {
    'wrp-stickney': 'wrp-stickney', 'wrp-calumet': 'wrp-calumet', 'wrp-obrien': 'wrp-obrien',
    'wrp-kirie': 'wrp-kirie', 'wrp-egan': 'wrp-egan', 'wrp-hanoverpark': 'wrp-hanoverpark',
    'wrp-lemont': 'wrp-lemont',
    'mwrd-mainstream': 'ps-mainstream', 'mwrd-calumet-tarp': 'ps-calumet-tarp',
    'mwrd-ohare-udp-pumps': 'ps-ohare-udp',
    'mwrd-racine-ave': 'ps-racine', 'mwrd-north-branch': 'ps-north-branch',
    'mwrd-95th-st': 'ps-95th', 'mwrd-122nd-st': 'ps-122nd', 'mwrd-125th-st': 'ps-125th',
    'mwrd-westchester': 'ps-westchester', 'wilmette-ps': 'ps-wilmette',
    'reservoir-mccook-stage1': 'res-mccook', 'reservoir-thornton-composite': 'res-thornton',
    'reservoir-majewski': 'res-majewski',
    'reservoir-thornton-transitional': 'res-thornton-transitional',
}

# recorded-CSO station name -> facility id
CSO_STATION = {'Racine Avenue': 'ps-racine', 'North Branch': 'ps-north-branch',
               'Westchester': 'ps-westchester', '125th St': 'ps-125th',
               '95th St': 'ps-95th', '122nd St': 'ps-122nd'}


# ---------------------------------------------------------------- basin areas
def ring_area_m2(ring):
    R = 6371008.8
    s = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = math.radians(ring[i][0]), math.radians(ring[i][1])
        x2, y2 = math.radians(ring[i + 1][0]), math.radians(ring[i + 1][1])
        s += (x2 - x1) * (2 + math.sin(y1) + math.sin(y2))
    return abs(s * R * R / 2)

def poly_area_m2(coords):
    a = ring_area_m2(coords[0])
    for h in coords[1:]:
        a -= ring_area_m2(h)
    return a

BASIN_META = {
    'CENTRAL': dict(name='Central basin', plant='wrp-stickney', systems=['mainstream', 'desplaines'],
                    color='#c98a2e', relief=['ps-racine', 'ps-westchester']),
    'NORTH':   dict(name='North basin', plant='wrp-obrien', systems=['mainstream'],
                    color='#8a6fc4', relief=['ps-north-branch', 'ps-wilmette']),
    'SOUTH':   dict(name='South basin', plant='wrp-calumet', systems=['calumet'],
                    color='#7fae3f', relief=['ps-95th', 'ps-122nd', 'ps-125th']),
    'OHARE':   dict(name='O’Hare basin', plant='wrp-kirie', systems=['udp'],
                    color='#4aa3c4', relief=[]),
    'LEMONT':  dict(name='Lemont basin', plant='wrp-lemont', systems=[], color='#9aa4b0', relief=[]),
}

def build_basins():
    g = load('gis/combined-sewer-areas.geojson', {'features': []})
    area = collections.defaultdict(float)
    outline = collections.defaultdict(list)
    for f in g['features']:
        p = f['properties']
        b = p.get('Basin')
        if not b or p.get('Type') != 'CSA':
            continue
        gm = f['geometry']
        polys = [gm['coordinates']] if gm['type'] == 'Polygon' else gm['coordinates']
        for poly in polys:
            a = poly_area_m2(poly)
            area[b] += a
            if a > 2.0e6:            # keep only the substantial rings as outlines
                ring = poly[0]
                step = max(1, len(ring) // 160)
                pts = [proj(c[1], c[0]) for c in ring[::step]]
                if len(pts) > 6:
                    outline[b].append(pts)
    out = []
    for b, meta in BASIN_META.items():
        m2 = area.get(b, 0.0)
        out.append(dict(
            id=b, name=meta['name'], plant=meta['plant'], systems=meta['systems'],
            color=meta['color'], relief=meta['relief'],
            areaSqMi=S(round(m2 / 2589988.11, 2), 'sq mi', 'gis',
                       'geodesic area of MWRD’s own Combined Sewer Area polygons'),
            areaM2=round(m2),
            outline=outline.get(b, [])))
    return out


# -------------------------------------------------------------------- tunnels
def _plen(pts):
    return sum(math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
               for i in range(1, len(pts)))

def _seg(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def repair_geometry(pts, label=''):
    """Clean three defects inherited from the corridor-tracing in tunnels.json.

    These are real errors in the source geometry, not modelling choices, and
    each one shows up in the render as a straight line shooting across the map:

      1. OUT-AND-BACK SPUR -- a facility point spliced between two copies of the
         same corridor point (the Calumet TARP Pumping Station sits this way
         inside tarp_calumet, 4.4 km out and 4.4 km back). The connection is
         real, so the point is lifted out as its own short spur rather than
         deleted.
      2. ZIGZAG -- two interleaved corridors merged into one polyline, so the
         line alternates between them (the Torrence Ave leg bounces twice
         between the Calumet River and the Little Calumet, 4.4 km each way).
      3. SPURIOUS TAIL -- the traced surface waterway runs on past the tunnel's
         terminus and the terminus is then appended as the last point, leaving
         a long jump back (tarp_des_plaines follows the Des Plaines River all
         the way to Lockport, 25 km past McCook, then leaps back to McCook).

    Returns (cleaned_points, spurs, log).
    """
    p = [list(x) for x in pts]
    spurs, log = [], []

    i = 1
    while i < len(p) - 1:
        if _seg(p[i - 1], p[i + 1]) < 60 and _seg(p[i - 1], p[i]) > 300:
            spurs.append([p[i - 1][:], p[i][:]])
            log.append(f'{label}: lifted a {_seg(p[i - 1], p[i]) / 1000:.2f} km out-and-back spur '
                       f'at point {i} into its own feature')
            del p[i]
            if i < len(p) - 1 and _seg(p[i - 1], p[i]) < 60:
                del p[i]
            continue
        i += 1

    changed = True
    while changed and len(p) > 3:
        changed = False
        segs = [_seg(p[k], p[k - 1]) for k in range(1, len(p))]
        med = sorted(segs)[len(segs) // 2] or 1.0
        for i in range(1, len(p) - 1):
            direct = _seg(p[i - 1], p[i + 1])
            detour = _seg(p[i - 1], p[i]) + _seg(p[i], p[i + 1])
            if direct > 0 and detour > 3.0 * direct and _seg(p[i - 1], p[i]) > 2.5 * med:
                log.append(f'{label}: removed a zigzag point at {i} '
                           f'({detour / 1000:.2f} km detour across a {direct / 1000:.2f} km gap)')
                del p[i]
                changed = True
                break

    segs = [_seg(p[k], p[k - 1]) for k in range(1, len(p))]
    med = sorted(segs)[len(segs) // 2] or 1.0
    if len(p) > 3 and segs[-1] > 4 * med:
        last = p[-1]
        for j in range(len(p) - 2):
            if _seg(p[j], last) < 1.8 * med:
                if j < len(p) - 2:
                    dropped = sum(_seg(p[k], p[k - 1]) for k in range(j + 1, len(p) - 1))
                    log.append(f'{label}: dropped {dropped / 1000:.1f} km of traced corridor running '
                               f'past the terminus, and the jump back to it')
                    p = p[:j + 1] + [last]
                break
    return p, spurs, log


def _smooth(pts, n):
    """Laplacian smoothing with fixed endpoints. Converges a meandering surface
    corridor toward the straight shaft-to-shaft runs a bored tunnel actually
    follows, which is what lets us match the published tunnel mileage."""
    q = [list(x) for x in pts]
    for _ in range(int(n)):
        r = [q[0]]
        for i in range(1, len(q) - 1):
            r.append([(q[i - 1][0] + 2 * q[i][0] + q[i + 1][0]) / 4.0,
                      (q[i - 1][1] + 2 * q[i][1] + q[i + 1][1]) / 4.0])
        r.append(q[-1])
        q = r
    return q

def _fit_taper(dmin, dmax, target_area, samples):
    """Solve p in d(f) = dmin + (dmax-dmin)*f**p so that the length-weighted
    mean cross-sectional area equals target_area (= sourced storage volume /
    sourced tunnel length). Returns (p, achieved_mean_area)."""
    def mean_area(pw):
        tot = w = 0.0
        for f, L in samples:
            d = dmin + (dmax - dmin) * (f ** pw if f > 0 else 0.0)
            tot += math.pi * (d / 2.0) ** 2 * L
            w += L
        return tot / w if w else 0.0
    lo, hi = 0.02, 40.0
    a_lo, a_hi = mean_area(lo), mean_area(hi)
    if not (min(a_lo, a_hi) <= target_area <= max(a_lo, a_hi)):
        return None, mean_area(1.0)
    for _ in range(90):
        mid = math.sqrt(lo * hi)
        if (mean_area(mid) - target_area) * (a_lo - target_area) > 0:
            lo = mid
        else:
            hi = mid
    p = math.sqrt(lo * hi)
    return p, mean_area(p)


def build_tunnels(tunnels_raw):
    feats, repairs, spur_feats = [], [], []
    for t in tunnels_raw:
        spec = TUNNEL_SPEC.get(t['id'])
        if not spec:
            continue
        raw = [list(proj(a, b)) for a, b in t['geometry']]
        pts, spurs, rlog = repair_geometry(raw, t['id'])
        repairs += rlog
        for k, sp in enumerate(spurs):
            spur_feats.append(dict(id=f"{t['id']}-spur{k + 1}", parent=t['id'],
                                   system=spec['system'], pts=sp))
        # orient upstream -> downstream against the system's terminus
        dn = proj(*DOWNSTREAM[spec['system']])
        d0 = math.hypot(pts[0][0] - dn[0], pts[0][1] - dn[1])
        d1 = math.hypot(pts[-1][0] - dn[0], pts[-1][1] - dn[1])
        flipped = d0 < d1
        if flipped:
            pts.reverse()
        feats.append(dict(raw=t, spec=spec, pts=pts, corridor=[list(x) for x in pts],
                          flipped=flipped))

    # --- route calibration: smooth each system until the total drawn length
    #     matches the mileage MWRD publishes for that system.
    fidelity = {}
    for sid, sysmeta in SYSTEMS.items():
        mine = [f for f in feats if f['spec']['system'] == sid]
        if not mine:
            continue
        target = sysmeta['lengthMi']['v'] * 1609.344
        raw_len = sum(_plen(f['pts']) for f in mine)
        floor_len = sum(_plen(_smooth(f['pts'], 400)) for f in mine)
        iters = 0
        if raw_len > target > floor_len:
            lo, hi = 0.0, 400.0
            for _ in range(24):
                mid = (lo + hi) / 2
                if sum(_plen(_smooth(f['pts'], mid)) for f in mine) > target:
                    lo = mid
                else:
                    hi = mid
            iters = (lo + hi) / 2
            for f in mine:
                f['pts'] = _smooth(f['pts'], iters)
        drawn = sum(_plen(f['pts']) for f in mine)
        fidelity[sid] = dict(
            sourcedMi=round(target / 1609.344, 2),
            corridorMi=round(raw_len / 1609.344, 2),
            drawnMi=round(drawn / 1609.344, 2),
            smoothing=round(iters, 1),
            lenDeltaPct=round(100.0 * (drawn - target) / target, 1),
            chordFloorMi=round(floor_len / 1609.344, 2))

    # --- diameter calibration: pick the taper that makes the tunnel hold the
    #     storage volume MWRD publishes for it.
    out = []
    for sid, sysmeta in SYSTEMS.items():
        mine = [f for f in feats if f['spec']['system'] == sid]
        if not mine:
            continue
        dmin, dmax = sysmeta['diaFt']['v']
        src_len_ft = sysmeta['lengthMi']['v'] * 5280.0
        src_vol_cuft = sysmeta['storageMG']['v'] * 133680.556
        target_area = src_vol_cuft / src_len_ft
        # sample (normalised system position, segment length) over every feature
        samples = []
        for f in mine:
            sp, pts = f['spec'], f['pts']
            cum, tot = [0.0], 0.0
            for i in range(1, len(pts)):
                tot += math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
                cum.append(tot)
            tot = tot or 1.0
            for i in range(1, len(pts)):
                fpos = sp['f0'] + (sp['f1'] - sp['f0']) * ((cum[i] + cum[i - 1]) / 2 / tot)
                samples.append((fpos, cum[i] - cum[i - 1]))
        if mine[0]['spec'].get('segs'):
            pexp, got_area = None, None      # UDP: per-segment diameters are published
        else:
            pexp, got_area = _fit_taper(dmin, dmax, target_area, samples)

        sys_vol_cuft = 0.0
        for f in mine:
            sp, pts = f['spec'], f['pts']
            cum, tot = [0.0], 0.0
            for i in range(1, len(pts)):
                tot += math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
                cum.append(tot)
            tot = tot or 1.0
            dia, depth, fpos = [], [], []
            for c in cum:
                fr = c / tot
                fs = sp['f0'] + (sp['f1'] - sp['f0']) * fr
                if sp.get('segs'):
                    d = sp['segs'][-1][0]
                    for dv, a, b in sp['segs']:
                        if a <= fs <= b:
                            d = dv
                            break
                elif pexp:
                    d = dmin + (dmax - dmin) * (fs ** pexp if fs > 0 else 0.0)
                else:
                    d = dmin + (dmax - dmin) * fs
                dia.append(round(d, 2))
                depth.append(round(sp['zUp'] + (sp['zDn'] - sp['zUp']) * fr, 1))
                fpos.append(round(fs, 4))
            for i in range(1, len(dia)):
                seg = (cum[i] - cum[i - 1]) / FT
                a = math.pi * ((dia[i] + dia[i - 1]) / 4.0) ** 2
                sys_vol_cuft += a * seg
            t = f['raw']
            out.append(dict(
                id=t['id'], name=t['name'], system=sid, order=sp['order'],
                f0=sp['f0'], f1=sp['f1'],
                pts=[[round(x, 1), round(z, 1)] for x, z in pts],
                corridor=[[round(x, 1), round(z, 1)] for x, z in f['corridor']],
                dia=dia, depth=depth, fpos=fpos,
                lenM=round(_plen(pts)), lenMi=round(_plen(pts) / 1609.344, 2),
                corridorMi=round(_plen(f['corridor']) / 1609.344, 2),
                reversed=f['flipped'],
                approx=bool(t.get('approx', True)),
                note=t.get('note', '')[:420], doc='doc09'))
        fid = fidelity.get(sid, {})
        fid.update(
            corridorVolDeltaPct=None,
            sourcedMG=sysmeta['storageMG']['v'],
            drawnMG=round(sys_vol_cuft / 133680.556, 1),
            volDeltaPct=round(100.0 * (sys_vol_cuft / 133680.556 - sysmeta['storageMG']['v'])
                              / sysmeta['storageMG']['v'], 1),
            taperExp=round(pexp, 3) if pexp else None,
            meanDiaFt=round(2 * math.sqrt(target_area / math.pi), 2),
            diaRange=[dmin, dmax])
        fidelity[sid] = fid
    # spurs: short real connections lifted out of the main lines above
    for sp in spur_feats:
        parent = next((o for o in out if o['id'] == sp['parent']), None)
        depth = parent['depth'][len(parent['depth']) // 2] if parent else 250.0
        dia = parent['dia'][len(parent['dia']) // 2] if parent else 15.0
        out.append(dict(
            id=sp['id'], name=(parent['name'] if parent else sp['system']) + ' \u2014 connection spur',
            system=sp['system'], order=9, f0=1.0, f1=1.0,
            pts=[[round(x, 1), round(z, 1)] for x, z in sp['pts']],
            corridor=[[round(x, 1), round(z, 1)] for x, z in sp['pts']],
            dia=[dia, dia], depth=[depth, depth], fpos=[1.0, 1.0],
            lenM=round(_plen(sp['pts'])), lenMi=round(_plen(sp['pts']) / 1609.344, 2),
            corridorMi=round(_plen(sp['pts']) / 1609.344, 2), reversed=False, spur=True,
            approx=True, doc='doc09',
            note='Lifted out of the parent tunnel line, where this facility connection was spliced '
                 'in as an out-and-back detour. The connection is real; drawing it inside the main '
                 'line was not.'))
    out.sort(key=lambda t: (t['system'], t['order']))
    return out, fidelity, repairs


SHAFT_PREFIX = [
    ('UDP-DS', 'udp', 'drop-shaft'),
    ('CDS-', 'calumet', 'drop-shaft'), ('CI-', 'calumet', 'drop-shaft'),
    ('CIM-', 'calumet', 'drop-shaft'), ('IM-Ca', 'calumet', 'drop-shaft'),
    ('DS-DA', 'mainstream', 'drop-shaft'),
    ('DS-D', 'desplaines', 'drop-shaft'),
    ('DS-M', 'mainstream', 'drop-shaft'), ('DS-N', 'mainstream', 'drop-shaft'),
    ('DS-LA', 'mainstream', 'drop-shaft'), ('DS-', 'mainstream', 'drop-shaft'),
    ('TG-M', 'mainstream', 'tide-gate'), ('TG-I', None, 'tide-gate'),
    ('TG-NA', None, 'tide-gate'), ('TG-', None, 'tide-gate'),
    ('I-', None, 'connection'),
]

def classify_shaft(tc):
    t = (tc or '').strip()
    for pre, sysname, kind in SHAFT_PREFIX:
        if t.upper().startswith(pre.upper()):
            return sysname, kind
    return None, None


def build_shafts(ref, gis, tunnels3d):
    """Drop shafts and connecting structures, keyed on MWRD's own
    TARP_CONNECTION identifiers in the public CSO_Points layer. One structure
    can serve several outfalls, so identifiers are de-duplicated."""
    named = {}
    for d in ref.get('dropshafts', []):
        key = d['id'].upper()
        named[key] = d['name']
    byname = {}
    for k, v in list(named.items()):
        import re as _re
        m = _re.search(r'\b((?:DS|TG|CDS|CI|UDP-DS)[-\w]*)', v, _re.I)
        if m:
            byname[m.group(1).upper()] = v

    seen, out = {}, []
    for f in gis.get('features', []):
        p = f['properties']
        tc = (p.get('TARP_CONNECTION') or '').strip()
        if not tc or tc.lower() in ('none', 'indirect'):
            continue
        sysname, kind = classify_shaft(tc)
        if kind is None:
            continue
        key = tc.upper()
        c = f['geometry']['coordinates']
        if key in seen:
            seen[key]['outfalls'] += 1
            continue
        x, z = proj(c[1], c[0])
        rec = dict(id=key, name=byname.get(key) or tc, tc=tc, x=x, z=z,
                   system=sysname, kind=kind, outfalls=1,
                   loc=(p.get('LOCATION') or '')[:60],
                   owner=(p.get('OWNER') or '')[:24],
                   reach=(p.get('WATERWAY_REACH') or '')[:34])
        seen[key] = rec
        out.append(rec)

    # land each structure on the nearest point of its own system's tunnel
    for s in out:
        if not s['system']:
            s['depth'] = 0.0
            s['tunnel'] = None
            s['dist'] = None
            continue
        # Project onto the AS-TRACED corridor (nearest point on a segment, not
        # the nearest vertex) -- that is where MWRD's own structure coordinates
        # sit -- then take the same normalised arclength on the
        # length-calibrated line, so the shaft attaches at the topologically
        # correct point. The residual gap is the disclosed displacement the
        # route calibration introduces, not a data error.
        best, bestd = None, 1e18
        for t in tunnels3d:
            if t['system'] != s['system']:
                continue
            cor = t['corridor']
            for i in range(1, len(cor)):
                ax, az = cor[i - 1]
                bx, bz = cor[i]
                vx, vz = bx - ax, bz - az
                L2 = vx * vx + vz * vz
                u = 0.0 if L2 == 0 else max(0.0, min(1.0, ((s['x'] - ax) * vx + (s['z'] - az) * vz) / L2))
                px, pz = ax + u * vx, az + u * vz
                dd = (px - s['x']) ** 2 + (pz - s['z']) ** 2
                if dd < bestd:
                    bestd, best = dd, (t['id'], i, u, px, pz)
        if best:
            tt = next(t for t in tunnels3d if t['id'] == best[0])
            i, u, px, pz = best[1], best[2], best[3], best[4]
            cor = tt['corridor']
            cum = [0.0]
            for k in range(1, len(cor)):
                cum.append(cum[-1] + math.hypot(cor[k][0] - cor[k - 1][0], cor[k][1] - cor[k - 1][1]))
            arc = cum[i - 1] + u * (cum[i] - cum[i - 1])
            frac = arc / (cum[-1] or 1.0)
            # same fraction along the calibrated line
            pts = tt['pts']
            cum2 = [0.0]
            for k in range(1, len(pts)):
                cum2.append(cum2[-1] + math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
            tgt = frac * cum2[-1]
            j = 1
            while j < len(cum2) - 1 and cum2[j] < tgt:
                j += 1
            seg = (cum2[j] - cum2[j - 1]) or 1.0
            w = max(0.0, min(1.0, (tgt - cum2[j - 1]) / seg))
            s['tx'] = round(pts[j - 1][0] + w * (pts[j][0] - pts[j - 1][0]), 1)
            s['tz'] = round(pts[j - 1][1] + w * (pts[j][1] - pts[j - 1][1]), 1)
            s['depth'] = round(tt['depth'][j - 1] + w * (tt['depth'][j] - tt['depth'][j - 1]), 1)
            s['dia'] = round(tt['dia'][j - 1] + w * (tt['dia'][j] - tt['dia'][j - 1]), 2)
            s['fpos'] = round(tt['fpos'][j - 1] + w * (tt['fpos'][j] - tt['fpos'][j - 1]), 4)
            s['cx'] = round(px, 1)          # attach point on the as-traced corridor
            s['cz'] = round(pz, 1)
            # depth at the corridor attach point (same vertex indexing)
            ci = max(1, min(len(tt['corridor']) - 1, i))
            s['cdepth'] = round(tt['depth'][min(ci, len(tt['depth']) - 1)], 1)
            s['tunnel'] = best[0]
            s['dist'] = round(math.sqrt(bestd))                   # shaft -> as-traced corridor
            s['shift'] = round(math.hypot(s['tx'] - px, s['tz'] - pz))
            s['orphan'] = s['dist'] > 1800
        else:
            s['depth'] = 0.0
            s['tunnel'] = None
            s['dist'] = None
    return out


# ----------------------------------------------------------------- facilities
def reservoir_geometry(spec):
    """Build a to-scale solid whose own volume equals the published capacity.
    Whichever dimension the archive does NOT source is the one solved for, and
    the result records which that was."""
    capMG = spec['capFullMG']['v']
    V = capMG * 133680.556                     # cu ft
    depth = spec['depthFt']['v']
    slope = spec['wallSlope']['v']
    aspect = 3.0 if spec['shape'] == 'quarry' else (1.6 if spec['shape'] == 'pit' else 1.35)
    have_area = 'surfaceAcres' in spec
    solved = None

    def frustum(L, W, d, s):
        i = min(s * d, 0.45 * min(L, W))
        A1 = L * W
        A2 = max(1.0, (L - 2 * i) * (W - 2 * i))
        return d / 3.0 * (A1 + A2 + math.sqrt(A1 * A2)), i

    if have_area:
        top = spec['surfaceAcres']['v'] * 43560.0
        L = math.sqrt(top * aspect)
        W = top / L
        if spec['depthFt']['s'] in ('doc10', 'doc12', 'doc09'):
            # area + depth + volume all sourced -> solve the wall slope
            lo, hi = 0.0, 12.0
            for _ in range(70):
                mid = (lo + hi) / 2
                v, _i = frustum(L, W, depth, mid)
                if v > V:
                    lo = mid
                else:
                    hi = mid
            slope = (lo + hi) / 2
            solved = 'wall slope'
        else:
            # area + volume sourced -> solve the mean depth
            lo, hi = 1.0, 900.0
            for _ in range(70):
                mid = (lo + hi) / 2
                v, _i = frustum(L, W, mid, slope)
                if v < V:
                    lo = mid
                else:
                    hi = mid
            depth = (lo + hi) / 2
            solved = 'mean depth'
    else:
        lo, hi = 10.0, 40000.0
        for _ in range(80):
            L = (lo + hi) / 2
            v, _i = frustum(L, L / aspect, depth, slope)
            if v < V:
                lo = L
            else:
                hi = L
        L = (lo + hi) / 2
        W = L / aspect
        top = L * W
        solved = 'plan footprint'

    geomV, inset = frustum(L, W, depth, slope)
    return dict(L=round(L * FT, 1), W=round(W * FT, 1), D=round(depth * FT, 1),
                insetM=round(inset * FT, 1), depthFt=round(depth, 1),
                slope=round(slope, 3), solvedFor=solved,
                topAcres=round(top / 43560.0, 1),
                geomMG=round(geomV / 133680.556, 1), sourcedMG=capMG,
                deltaPct=round(100.0 * (geomV / 133680.556 - capMG) / capMG, 1))


TRAIN_BY_ID = {'grit': ('water', 1), 'primary': ('water', 2), 'imhoff': ('water', 2),
               'aeration': ('water', 3), 'final': ('water', 4), 'uv': ('water', 5),
               'filter': ('water', 5), 'disinfect': ('water', 5), 'digest': ('solids', 6)}

# Treatment trains for the satellite plants. doc13 gives the SEQUENCE in words
# for each plant; the tank counts and sizes are not published, so the stages
# are drawn at sizes scaled from the plant's design flow and tagged 'assumed'.
COMPACT_TRAIN = {
    'wrp-kirie': ['screen', 'grit', 'aeration', 'final', 'filter', 'disinfect', 'postair'],
    'wrp-egan': ['screen', 'grit', 'aeration', 'final', 'filter', 'disinfect'],
    'wrp-hanoverpark': ['screen', 'grit', 'aeration', 'final', 'filter', 'disinfect'],
    'wrp-lemont': ['screen', 'grit', 'aeration', 'final', 'disinfect'],
}
STAGE_LABEL = {
    'screen': 'Screening', 'grit': 'Grit removal', 'primary': 'Primary settling',
    'aeration': 'Activated sludge (aeration)', 'final': 'Final settling',
    'filter': 'Tertiary filtration', 'disinfect': 'Chlorination / dechlorination',
    'postair': 'Post-aeration', 'uv': 'UV disinfection', 'imhoff': 'Imhoff tanks',
    'digest': 'Anaerobic digestion',
}


def wrp_geometry(spec):
    """Lay the sourced tank inventory out on the plant's sourced acreage.
    Tank counts and sizes are sourced; the arrangement on the site is not."""
    if spec.get('compact') or not spec.get('units'):
        # Draw the sourced treatment SEQUENCE. Stage sizes are scaled from the
        # plant's design maximum flow against Stickney's sourced tank sizes, and
        # every dimension here is tagged 'assumed' because none is published.
        acres = spec['acres']['v']
        side = math.sqrt(acres * 43560.0)
        siteL, siteW = side * 1.5, side / 1.5
        stages = COMPACT_TRAIN.get(spec.get('_id'), ['screen', 'grit', 'aeration', 'final', 'disinfect'])
        f = math.sqrt(max(spec['dmf']['v'], 1) / 1440.0)          # vs Stickney DMF
        rows = []
        for k, sid in enumerate(stages):
            if sid in ('final',):
                n = max(2, round(8 * f))
                dia_ft = max(125 * f, 60)
                rows.append(dict(id=sid, label=STAGE_LABEL[sid], shape='cyl', n=n,
                                 dia=round(dia_ft * FT, 2), D=round(12 * FT, 2),
                                 footM2=round(n * math.pi * (dia_ft * FT / 2) ** 2),
                                 train='water', stage=k + 1,
                                 src={'n': 'assumed', 'dia': 'assumed', 'D': 'assumed'}))
            elif sid == 'aeration':
                am2 = max(36 * 4046.856 * (spec['dmf']['v'] / 1440.0), 8000.0)
                bl = math.sqrt(am2 * 3.2)
                rows.append(dict(id=sid, label=STAGE_LABEL[sid], shape='basin-array', n=4,
                                 L=round(bl, 1), W=round(am2 / bl, 1), D=round(15 * FT, 2),
                                 acres=round(am2 / 4046.856, 2), footM2=round(am2),
                                 train='water', stage=k + 1,
                                 src={'acres': 'derived', 'D': 'assumed'}))
            else:
                n = max(2, round(4 * f))
                # floor the assumed sizes: these are scaled placeholders, and a
                # half-metre-wide tank is not a credible drawing of anything
                Lf, Wf = max(110 * f, 55), max(34 * f, 18)
                rows.append(dict(id=sid, label=STAGE_LABEL[sid], shape='box', n=n,
                                 L=round(Lf * FT, 2), W=round(Wf * FT, 2), D=round(12 * FT, 2),
                                 footM2=round(n * Lf * Wf * FT * FT),
                                 train='water', stage=k + 1,
                                 src={'n': 'assumed', 'L': 'assumed', 'D': 'assumed'}))
        covered = sum(r['footM2'] for r in rows)
        return dict(siteL=round(siteL * FT, 1), siteW=round(siteW * FT, 1), rows=rows,
                    siteM2=round(acres * 4046.856), tankM2=covered,
                    coveragePct=round(100.0 * covered / (acres * 4046.856), 1),
                    compact=True, trainSourced=True)
    acres = spec['acres']['v']
    side = math.sqrt(acres * 43560.0)
    siteL, siteW = side * 1.45, side / 1.45
    rows = []
    for u in spec['units']:
        tr, st = TRAIN_BY_ID.get(u['id'], ('water', 9))
        r = dict(id=u['id'], label=u['label'], shape=u['shape'], note=u.get('note'),
                 train=u.get('train', tr), stage=u.get('stage', st))
        if u['shape'] == 'cyl':
            r.update(n=u['n']['v'], dia=round(u['dia']['v'] * FT, 2), D=round(u['D']['v'] * FT, 2))
            r['footM2'] = round(u['n']['v'] * math.pi * (u['dia']['v'] * FT / 2) ** 2)
        elif u['shape'] == 'box':
            r.update(n=u['n']['v'], L=round(u['L']['v'] * FT, 2), W=round(u['W']['v'] * FT, 2),
                     D=round(u['D']['v'] * FT, 2))
            r['footM2'] = round(u['n']['v'] * u['L']['v'] * u['W']['v'] * FT * FT)
        else:  # basin-array: a sourced total surface area, split into passes
            am2 = u['acres']['v'] * 4046.856
            lanes = u['lanes']['v']
            bl = math.sqrt(am2 * 3.2)
            r.update(n=lanes, L=round(bl, 1), W=round(am2 / bl, 1), D=round(u['D']['v'] * FT, 2),
                     acres=u['acres']['v'], footM2=round(am2))
        r['src'] = {k: u[k]['s'] for k in ('n', 'dia', 'D', 'L', 'W', 'acres') if k in u}
        rows.append(r)
    rows.sort(key=lambda r: r['stage'])
    covered = sum(r['footM2'] for r in rows)
    return dict(siteL=round(siteL * FT, 1), siteW=round(siteW * FT, 1), rows=rows,
                siteM2=round(acres * 4046.856), tankM2=covered,
                coveragePct=round(100.0 * covered / (acres * 4046.856), 1))


def build_facilities(fac_raw, tunnels3d):
    out = []
    byid = {f['id']: f for f in fac_raw}
    for src_id, spec_id in FAC_ID_MAP.items():
        f = byid.get(src_id)
        spec = FAC_SPEC.get(spec_id)
        if not f or not spec:
            continue
        x, z = proj(f['lat'], f['lng'])
        rec = dict(id=spec_id, srcId=src_id, name=spec['label'], short=spec['short'],
                   kind=spec['kind'], x=x, z=z, doc=spec.get('doc'),
                   note=spec.get('note'), spec={})
        for k, v in spec.items():
            if isinstance(v, dict) and 'v' in v and 'u' in v:
                rec['spec'][k] = v
        for k in ('basin', 'system', 'plant', 'pump', 'conflict', 'retired', 'stage2', 'extras', 'shape'):
            if k in spec:
                rec[k] = spec[k]
        if spec['kind'] == 'reservoir':
            rec['geom'] = reservoir_geometry(spec)
        elif spec['kind'] == 'wrp':
            spec['_id'] = spec_id
            rec['geom'] = wrp_geometry(spec)
        else:
            npump = spec.get('pumps', {}).get('v', 4)
            hallL = max(40.0, npump * 9.0)
            rec['geom'] = dict(hallL=round(hallL, 1), hallW=26.0, hallH=14.0, n=npump,
                               pumpDia=round(spec.get('stormPumpFt', spec.get('screwFt', S(5, 'ft', 'assumed')))['v'] * FT, 2),
                               shaftM=round(spec.get('shaftDepthFt', S(0, 'ft', 'assumed'))['v'] * FT, 1),
                               riserM=round(spec.get('riserFt', S(2, 'ft', 'assumed'))['v'] * FT, 2))
        out.append(rec)
    return out


# ---------------------------------------------------------- recorded CSO log
def build_events():
    p = os.path.join(ROOT, 'data', 'mwrd-ps-cso-activity.csv')
    if not os.path.exists(p):
        return []
    rows = [r for r in csv.DictReader(open(p))
            if r['row_type'] == 'event' and r['volume_mg'] and r['date_iso']]
    byd = collections.defaultdict(lambda: collections.defaultdict(float))
    span = {}
    for r in rows:
        st = CSO_STATION.get(r['station'])
        if not st:
            continue
        byd[r['date_iso']][st] += float(r['volume_mg'])
        try:
            span[r['date_iso']] = max(span.get(r['date_iso'], 1), int(r['span_days'] or 1))
        except ValueError:
            span[r['date_iso']] = span.get(r['date_iso'], 1)
    ev = []
    for d, stations in byd.items():
        tot = sum(stations.values())
        ev.append(dict(date=d, totalMG=round(tot, 1), days=span.get(d, 1),
                       stations={k: round(v, 1) for k, v in stations.items()}))
    ev.sort(key=lambda e: -e['totalMG'])
    return ev[:40]


# ------------------------------------------------------------------ waterways
def build_waterways():
    ww = load('waterways-modern.json', [])
    keep = {'chicago-river-main-stem', 'south-branch-chicago-river', 'north-branch-chicago-river',
            'north-shore-channel', 'chicago-sanitary-ship-canal', 'cal-sag-channel',
            'calumet-river', 'little-calumet-river', 'grand-calumet-river-il',
            'des-plaines-river-lyons-lockport', 'bubbly-creek-south-fork',
            'north-shore-channel-wilmette', 'lake-michigan-shore'}
    out = []
    for w in ww:
        if w['id'] not in keep and 'channel' not in w['id'] and 'canal' not in w['id']:
            continue
        g = w.get('geometry') or []
        if len(g) < 2:
            continue
        step = max(1, len(g) // 120)
        out.append(dict(id=w['id'], name=w.get('name', w['id']),
                        pts=[list(proj(a, b)) for a, b in g[::step]]))
    return out


# ============================================================ simulation model
def build_sim(basins, facs):
    byid = {f['id']: f for f in facs}
    plants = {}
    for f in facs:
        if f['kind'] != 'wrp':
            continue
        plants[f['id']] = dict(
            id=f['id'], name=f['short'],
            dmf=f['spec']['dmf']['v'], daf=f['spec']['daf']['v'], avg=f['spec']['avg']['v'],
            basin=f.get('basin'))
    systems = {}
    for sid, s in SYSTEMS.items():
        systems[sid] = dict(
            id=sid, name=s['name'], color=s['color'],
            storageMG=s['storageMG']['v'], lengthMi=s['lengthMi']['v'],
            pump=s['pump'], reservoir=s['reservoir'], plant=s['plant'],
            basins=s['basins'], gravity=bool(s.get('gravity')))
    pumps = {}
    for f in facs:
        if f['kind'] != 'tarp-ps':
            continue
        pumps[f['id']] = dict(id=f['id'], name=f['short'],
                              capMGD=f['spec']['capMGD']['v'], plant=f.get('plant'),
                              n=f['spec'].get('pumps', {}).get('v', 4))
    reservoirs = {}
    for f in facs:
        if f['kind'] != 'reservoir' or f.get('retired'):
            continue
        reservoirs[f['id']] = dict(id=f['id'], name=f['short'],
                                   capMG=f['spec']['capMG']['v'],
                                   capFullMG=f['spec']['capFullMG']['v'],
                                   system=f.get('system'), pump=f.get('pump'))
    relief = {}
    for f in facs:
        if f['kind'] != 'sewage-ps':
            continue
        relief[f['id']] = dict(id=f['id'], name=f['short'], basin=f.get('basin'),
                               capMGD=f['spec'].get('capMGD', {}).get('v', 100))
    return dict(
        plants=plants, systems=systems, pumps=pumps, reservoirs=reservoirs, relief=relief,
        constants=dict(
            cfsPerMGD=S(1.547, 'cfs/MGD', 'doc07', 'MWRD’s own conversion, from its Combined Sewer System report'),
            mgdPerInHrSqMi=S(417.0, 'MGD', 'derived',
                             '1 in/hr over 1 sq mi = 645.3 cfs = 417 MGD'),
            runoffC=S(0.70, '—', 'assumed',
                      'volumetric runoff coefficient for dense combined-sewer catchment; adjustable in the viewer'),
            designStormIn=S(2.0, 'in/24 h', 'doc06',
                            'the design standard Chicago’s combined sewers were built to — the model’s main calibration anchor'),
            interceptorFactor=S(1.0, '× plant DMF', 'assumed',
                                'intercepting-sewer capture capacity is modelled as the plant’s design maximum flow'),
            dwfSplit=S('plant average flow', '—', 'doc11',
                       'dry-weather flow per basin taken from each plant’s reported average'),
        ),
        scenarios=[
            dict(id='dry', label='Dry weather', inches=0.0, hours=0, note='Sanitary flow only — what the system does 300-odd days a year.'),
            dict(id='p25', label='0.25 in / 6 h', inches=0.25, hours=6, note='A routine light rain.'),
            dict(id='p50', label='0.5 in / 3 h', inches=0.5, hours=3, note='A brisk summer shower.'),
            dict(id='p100', label='1.0 in / 6 h', inches=1.0, hours=6, note='Enough to start filling the tunnels.'),
            dict(id='design', label='2.0 in / 24 h — design storm', inches=2.0, hours=24,
                 note='The standard Chicago’s combined sewers were designed to (doc 06). CSOs historically begin around here.'),
            dict(id='p350', label='3.5 in / 12 h', inches=3.5, hours=12, note='A serious convective event.'),
            dict(id='s2008', label='6.64 in / 24 h — 13 Sept 2008', inches=6.64, hours=24,
                 note='O’Hare’s single-calendar-day rainfall record. 6,173.8 MG of CSO was recorded across four MWRD pumping stations that day; North Branch PS alone discharged 1,348.9 MG.'),
            dict(id='s2026', label='10 in / 48 h — 2026 event', inches=10.0, hours=48,
                 note='The 2026 storm that pushed McCook to ~98% of capacity — its sixth fill of that year — and Thornton to a record level.'),
        ],
        events=build_events(),
    )


# ===================================================================== assemble
def main():
    fac_raw = load('facilities.json', [])
    tun_raw = load('tunnels.json', [])
    ref = load('tarp-refined.json', {'dropshafts': []})
    gis = load('gis/cso-outfall-points.geojson', {'features': []})

    basins = build_basins()
    tunnels, fidelity, repairs = build_tunnels(tun_raw)
    shafts = build_shafts(ref, gis, tunnels)
    facs = build_facilities(fac_raw, tunnels)

    outfalls = []
    for f in gis.get('features', []):
        c = f['geometry']['coordinates']
        p = f['properties']
        x, z = proj(c[1], c[0])
        outfalls.append([x, z, p.get('LOCATION') or '', p.get('TARP_CONNECTION') or '',
                         p.get('OWNER') or '', p.get('WATERWAY_REACH') or ''])

    # city-sewer size ladder, for the true-scale cross-section ruler
    city_sizes = [4, 6, 8, 10, 12, 15, 18, 21, 24, 27, 30, 33, 36, 42, 48, 54, 60, 66, 72, 78]
    ladder = dict(
        city=dict(label='City of Chicago sewer mains (DWM standard details)', sizesIn=city_sizes,
                  maxIn=S(204, 'in', 'doc06', 'DWM’s FY2025–29 lining program covers trunk sewers 72"–204"'),
                  minIn=S(4, 'in', 'doc06'), milesS=S(4400, 'mi', 'doc06', '4,400–4,500 mi depending on the DWM source')),
        interceptor=dict(label='MWRD intercepting sewers', minIn=S(6, 'in', 'doc07'),
                         maxFt=S(27, 'ft', 'doc07'), milesS=S(560, 'mi', 'doc07'),
                         connections=S(10000, 'connections', 'doc07')),
        tarp=dict(label='TARP deep tunnels', minFt=S(8, 'ft', 'doc09'), maxFt=S(33, 'ft', 'doc09'),
                  milesS=S(110.4, 'mi', 'doc09'), storageMG=S(2320, 'MG', 'doc09')),
        shaft=dict(label='TARP drop shafts', minFt=S(4, 'ft', 'doc09'), maxFt=S(25, 'ft', 'doc09',
                   'some accounts say up to 33 ft'), count=S(256, 'shafts', 'doc09',
                   'academic source; MWRD variously says "over 250" and 264'),
                   note='Individual shaft diameters are not published. Every shaft in this model is drawn at a single representative diameter inside the sourced 4–25 ft range.'),
    )

    out = dict(
        meta=dict(
            generated=datetime.date.today().isoformat(),
            origin=dict(lat=LAT0, lng=LNG0),
            projection='local east-north-up tangent plane, metres; x = east, z = south (three.js y-up). '
                       'Horizontal distances are true; no map projection distortion at this extent.',
            units='All scene units are metres. Every engineering value carries {v, u, s}: '
                  'v = value, u = unit, s = source tag (docNN = sourced in this archive, '
                  'derived = computed here, assumed = typical practice, not sourced).',
            caveats=[
                'Tunnel alignments are surface corridors traced through MWRD’s own catalogued drop shafts and waterway centrelines. No surveyed TARP centreline is published anywhere; the horizontal route is therefore approximate, while the shaft positions on it are MWRD GIS data.',
                'Tunnel diameter and depth are published only as per-system ranges. Each tunnel is drawn tapering from the upstream to the downstream end of its sourced range; no per-segment diameter is published.',
                'The ground surface is drawn flat. Chicago’s relief across this extent is roughly 100 ft, which is small next to the 150–300 ft tunnel depth but not zero.',
                'Treatment-plant tank counts and sizes are sourced where the tag says so; their arrangement on the site is schematic.',
                'The flow simulation is a mass balance over sourced storage volumes and pump capacities. It is not a hydraulic model: it does not solve for head, velocity, air entrainment or surge.',
            ],
        ),
        sources=SOURCES,
        systems={k: {kk: vv for kk, vv in v.items()} for k, v in SYSTEMS.items()},
        basins=basins, tunnels=tunnels, fidelity=fidelity, repairs=repairs,
        shafts=shafts, facilities=facs,
        outfalls=outfalls, waterways=build_waterways(), ladder=ladder,
        sim=build_sim(basins, facs),
    )

    dst = os.path.join(MD, 'system3d.js')
    with open(dst, 'w') as fh:
        fh.write('window.SYS3D = ')
        json.dump(out, fh, separators=(',', ':'), ensure_ascii=False)
        fh.write(';\n')

    tl = sum(t['lenM'] for t in tunnels) / 1609.344
    print(f'system3d.js: {len(facs)} facilities, {len(tunnels)} tunnel features '
          f'({tl:.1f} mi drawn), {len(shafts)} shafts, {len(outfalls)} outfalls, '
          f'{len(out["waterways"])} waterways, {len(out["sim"]["events"])} recorded events '
          f'({round(os.path.getsize(dst)/1024)} KB)')
    if repairs:
        print(f'   geometry repairs ({len(repairs)}):')
        for r in repairs:
            print(f'     - {r}')
    sc = collections.Counter((s['system'] or 'interceptor', s['kind']) for s in shafts)
    orph = sum(1 for s in shafts if s.get('orphan'))
    dists = sorted(s['dist'] for s in shafts if s.get('dist') is not None)
    shifts = sorted(s.get('shift', 0) for s in shafts if s.get('dist') is not None)
    if dists:
        print(f'   shafts: {dict(sc)}')
        print(f'     shaft -> as-traced corridor: median {dists[len(dists)//2]} m, '
              f'p90 {dists[int(.9*len(dists))]} m, {orph} beyond 1800 m (drawn unconnected)')
        print(f'     corridor -> length-calibrated line: median {shifts[len(shifts)//2]} m, '
              f'p90 {shifts[int(.9*len(shifts))]} m')
    for sid, f in fidelity.items():
        print(f'   {sid:11s} route {f["corridorMi"]:6.2f} -> {f["drawnMi"]:6.2f} mi vs sourced '
              f'{f["sourcedMi"]:5.1f} ({f["lenDeltaPct"]:+5.1f}%)  |  volume {f["drawnMG"]:7.1f} vs '
              f'{f["sourcedMG"]:6.0f} MG ({f["volDeltaPct"]:+5.1f}%)  taper p={f["taperExp"]}')
    for b in basins:
        print(f'   basin {b["id"]:8s} {b["areaSqMi"]["v"]:7.2f} sq mi  ({len(b["outline"])} outline rings)')
    for f in facs:
        if f['kind'] == 'reservoir':
            g = f['geom']
            print(f'   {f["short"]:12s} {g["L"]:7.0f} x {g["W"]:6.0f} x {g["D"]:5.0f} m  '
                  f'geom {g["geomMG"]:8.0f} MG vs sourced {g["sourcedMG"]:8.0f} MG  ({g["deltaPct"]:+.1f}%)')
        if f['kind'] == 'wrp' and not f['geom'].get('compact'):
            g = f['geom']
            print(f'   {f["short"]:12s} site {g["siteL"]:.0f} x {g["siteW"]:.0f} m, '
                  f'tanks cover {g["coveragePct"]}% of the sourced site area')


if __name__ == '__main__':
    main()
