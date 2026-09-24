#!/usr/bin/env python3
"""Recorded storms for the 3D model: the ten largest multi-day rainfall events
at Chicago's two first-order gauges since 2006, with hourly hyetographs from
every gauge in the region, so the model can rain a real storm with its real
spatial shape and be compared with what MWRD actually recorded.

Ten ASOS stations are too coarse for convective storms -- they sit 15 to 40 km
apart, and the July 2011 event alone shows an 8 in gradient between two of
them. So the gauge field is built from four networks:

  measured hourly   IEM ASOS p01i, NCEI's co-op Hourly Precipitation Data, and
                    USGS NWIS tipping buckets
  derived hourly    NCEI GHCN-Daily co-op and CoCoRaHS gauges, whose event
                    total is real but whose timing is borrowed from the nearest
                    measured hourly gauge (see daily_gauges)

That takes a storm from 8 or 9 gauges to between 47 and 143 of them.

Inputs (fetched separately, cached in the scratchpad):
  events_top.json                 event windows ranked from the two first-order
                                  gauge records
  hourly7/<start>.csv             IEM ASOS 1-hour precipitation (p01i) for
                                  ORD MDW PWK DPA LOT IGQ GYY UGN ARR ENW
  map-data/storm-observations.json  what MWRD's own records say each storm's
                                  tunnels and reservoirs were doing (optional)
  hpd/<start>.json                NCEI coop-hourly-precipitation (HPD v2)
  hpd/stations.json               HPD station inventory, subset near Chicago
  usgs/<start>.json               USGS NWIS instantaneous values, parameter
                                  00045, all sites within 45 km
  daily/<start>.json              NCEI daily-summaries PRCP, all GHCN-Daily
                                  stations within 45 km, units=standard
Output: map-data/storms.json

Run with --observed-only to re-merge storm-observations.json into an existing
storms.json without refetching the rainfall inputs, which live in a scratchpad
cache rather than in the repository.
"""
import json, csv, os, sys, math, datetime, collections
from zoneinfo import ZoneInfo

CHI = ZoneInfo('America/Chicago')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCR = os.environ.get('STORM_SCRATCH', '/tmp/claude-501/-Users-bryanoswald-Documents-Research-ChicagoSewers/d40a9738-211e-496c-9658-45ebec776028/scratchpad')
LAT0, LNG0 = 41.85, -87.75
MPLAT = 111132.0; MPLNG = 111320.0 * math.cos(math.radians(LAT0))
def proj(lat, lng): return (round((lng - LNG0) * MPLNG), round(-(lat - LAT0) * MPLAT))

CSO_STATION = {'Racine Avenue': 'ps-racine', 'North Branch': 'ps-north-branch', 'Westchester': 'ps-westchester',
               '125th St': 'ps-125th', '95th St': 'ps-95th', '122nd St': 'ps-122nd'}
NAMES = {'ORD': "O'Hare", 'MDW': 'Midway', 'PWK': 'Chicago Executive (Wheeling)', 'DPA': 'DuPage (West Chicago)',
         'LOT': 'Lewis (Romeoville)', 'IGQ': 'Lansing', 'GYY': 'Gary', 'UGN': 'Waukegan', 'ARR': 'Aurora', 'ENW': 'Kenosha'}

SRC_ASOS = 'IEM ASOS p01i (measured hourly)'
SRC_HPD = 'NCEI HPD v2 coop-hourly-precipitation (measured hourly)'
SRC_USGS = 'USGS NWIS instantaneous precipitation, parameter 00045 (measured, tipping bucket)'
SRC_DAILY = 'NCEI GHCN-Daily PRCP (measured event total, hourly shape borrowed)'

def hourly(path, t0):
    """ASOS p01i is the precipitation in the hour ending at the observation;
    bin observations to whole hours after t0, summing partial reports."""
    rows = list(csv.DictReader(open(path)))
    by = collections.defaultdict(lambda: collections.defaultdict(float))
    seen = collections.defaultdict(set)
    coords = {}
    for r in rows:
        st = r['station']
        v = r['p01i'].strip()
        t = datetime.datetime.strptime(r['valid'], '%Y-%m-%d %H:%M')
        h = int((t - t0).total_seconds() // 3600)
        if h < 0: continue
        coords[st] = (float(r['lat']), float(r['lon']))
        seen[st].add(h)                       # an observation exists for this hour
        # In older METARs a dry hour simply has no precipitation group, which
        # IEM renders as 'M'. Station totals read that way match GHCN-Daily
        # (O'Hare 8.61 vs 8.59 in for July 2011), so 'M' on an existing report
        # is zero, not missing.
        if v in ('M', ''): continue
        val = 0.005 if v == 'T' else float(v)
        # the routine :51 report carries the hour's total; specials in between
        # repeat partial amounts, so keep the max seen in the bin
        by[st][h] = max(by[st][h], val)
    return by, coords, seen

OBSERVED_META = ('MWRD Monitoring and Research Department annual IEPA groundwater-monitoring reports, merged '
                 'from map-data/storm-observations.json as storm.observed where MWRD recorded anything for '
                 'that storm. MWRD logs fill events as dates, not volumes, so `observed` is mostly a check on '
                 'the model rather than an input to it.')


def merge_observed(out):
    """Attach MWRD's own record of each storm to the storm itself, as `observed`,
    so the viewer can show what the District reported beside what the model says.
    Storms with nothing recorded are left without the key."""
    path = os.path.join(ROOT, 'map-data', 'storm-observations.json')
    if not os.path.exists(path):
        return 0
    obs = json.load(open(path)).get('storms', {})
    n = 0
    for s in out['storms']:
        if s['id'] in obs:
            s['observed'] = obs[s['id']]
            n += 1
    if n:
        out['meta']['observed'] = OBSERVED_META
    return n


def write(out):
    json.dump(out, open(os.path.join(ROOT, 'map-data', 'storms.json'), 'w'), separators=(',', ':'))
    print('storms.json', os.path.getsize(os.path.join(ROOT, 'map-data', 'storms.json')) // 1024, 'KB')


def observed_only():
    """Re-merge the observations into the storms.json already on disk."""
    out = json.load(open(os.path.join(ROOT, 'map-data', 'storms.json')))
    print('merged observations into', merge_observed(out), 'of', len(out['storms']), 'storms')
    write(out)
# HPD quality flags that mean the value failed a check or was deleted; 'A' (a
# multi-hour accumulation) is kept, because the water did fall.
HPD_BAD_QF = set('XNYKGOZDQ')

def hpd_hourly(path, stations, t0, hours):
    """NCEI HPD v2: HRnnVal is the total for nn:00-nn+1:00 local standard time,
    in hundredths of an inch, so it belongs in the bin ending at nn+1.

    That +1 alignment is not documented against local civil time, so it was
    measured: cross-correlating Chicago Midway AP 3SW against Midway ASOS 4 km
    away picks lag +1 in every one of the nine storms with measurable rain at
    Midway (all ten windows fall inside daylight-saving time)."""
    if not os.path.exists(path):
        return {}
    by = collections.defaultdict(lambda: [0.0] * hours)
    for r in json.load(open(path)):
        st = r['STATION']
        if st not in stations: continue
        d = datetime.datetime.fromisoformat(r['DATE'])
        base = int((d - t0).total_seconds() // 3600)
        for nn in range(24):
            v = r.get(f'HR{nn:02d}Val')
            if v in (None, '', '-9999'): continue
            if (r.get(f'HR{nn:02d}QF') or ' ').strip() in HPD_BAD_QF: continue
            h = base + nn + 1
            if 0 <= h < hours: by[st][h] += float(v) / 100.0
    return by

def usgs_hourly(path, t0, hours):
    """USGS NWIS parameter 00045 is a tipping-bucket log: each reading is the
    0.01 in increment at the instant the bucket tipped, not a fixed-interval
    total, so the series is irregular and has to be binned rather than resampled.
    Timestamps carry an explicit UTC offset, which is what makes them safe to
    line up with the ASOS local-civil-time frame."""
    if not os.path.exists(path):
        return {}
    by = {}
    for ts in json.load(open(path)):
        si = ts['sourceInfo']
        sid = si['siteCode'][0]['value']
        gl = si['geoLocation']['geogLocation']
        arr = by.setdefault(sid, dict(id=sid, name=si['siteName'].title(),
                                      lat=float(gl['latitude']), lng=float(gl['longitude']),
                                      hourly=[0.0] * hours))['hourly']
        for i, v in enumerate(ts['values'][0]['value']):
            try: x = float(v['value'])
            except Exception: continue
            if x < 0: continue                       # -999999 = missing
            # the first sample of a query window is sometimes the gauge's
            # running accumulator rather than an increment -- West Chicago opens
            # the July 2011 window at 9.27 in and then tips 0.01 at a time
            if i == 0 and x > 0.05: continue
            t = datetime.datetime.fromisoformat(v['dateTime']).astimezone(CHI).replace(tzinfo=None)
            d = (t - t0).total_seconds() / 3600.0
            h = int(math.ceil(d))                    # the bin ENDING at h, as ASOS
            if 0 <= h < hours: arr[h] += x
    return by

def daily_gauges(path, t0, hours, measured):
    """GHCN-Daily co-op and CoCoRaHS gauges. These are daily reads, so they
    cannot supply a hyetograph -- but they can supply the one thing ten ASOS
    stations cannot, which is how much rain actually fell between them.

    Each gauge keeps its own EVENT total and borrows its shape from the nearest
    measured hourly gauge. Scaling the whole event by one factor, rather than
    day by day, is deliberate: most of these are CoCoRaHS gauges read at about
    7 a.m., so their calendar days are offset from the model's, and only the
    event total is free of that. Every storm window opens with seven dry-ish
    lead-in days and closes two days after the event, so the sum is safe.

    A gauge is used only if it reported on every day of the window; one that
    reported nothing while its neighbours were measuring inches is a dead gauge,
    not a dry spot, and is dropped the same way the ASOS pass drops Gary."""
    if not os.path.exists(path):
        return [], measured, []
    days = [(t0 + datetime.timedelta(days=i)).date().isoformat()
            for i in range(int(math.ceil((hours) / 24.0)))]
    got = collections.defaultdict(dict)
    meta = {}
    for r in json.load(open(path)):
        if r.get('PRCP') in (None, ''): continue
        got[r['STATION']][r['DATE']] = float(r['PRCP'])
        meta[r['STATION']] = (r['NAME'], float(r['LATITUDE']), float(r['LONGITUDE']))
    def km(a, b):
        return math.hypot((a['lat'] - b['lat']) * 111.1, (a['lng'] - b['lng']) * 82.8)
    cand = []
    for st, series in got.items():
        if any(d not in series for d in days): continue        # incomplete record
        name, lat, lng = meta[st]
        g = dict(id=st, name=name.replace(', IL US', '').replace(', IN US', '').title(),
                 lat=lat, lng=lng, totalIn=round(sum(series[d] for d in days), 2))
        # the airports and the HPD co-ops report to GHCN-Daily as well; keep the
        # gauge that has a real hyetograph rather than a borrowed one
        if any(km(g, m) < 1.0 for m in measured): continue
        cand.append(g)
    # dead-gauge check against the neighbourhood, for daily and hourly alike
    everyone = cand + measured
    dropped = []
    def alive(g):
        near = sorted(o['totalIn'] for o in everyone
                      if o['id'] != g['id'] and km(o, g) < 15)
        med = near[len(near) // 2] if len(near) >= 5 else None
        if med is not None and med >= 1.0 and g['totalIn'] < 0.15 * med:
            dropped.append((g['id'], g.get('name', g['id']), g['totalIn'], round(med, 2)))
            return False
        return g['totalIn'] >= 0.05
    return [g for g in cand if alive(g)], [m for m in measured if alive(m)], dropped

def shape_from(g, measured):
    """The nearest measured hourly gauge that actually recorded the storm."""
    best = None
    for m in measured:
        if m['totalIn'] <= 0.05: continue
        d = math.hypot((m['lat'] - g['lat']) * 111.1, (m['lng'] - g['lng']) * 82.8)
        if best is None or d < best[0]: best = (d, m)
    return best


def main():
    top = json.load(open(os.path.join(SCR, 'events_top.json')))[:10]
    log = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in csv.DictReader(open(os.path.join(ROOT, 'data', 'mwrd-ps-cso-activity.csv'))):
        if r['row_type'] != 'event' or not r['volume_mg'] or not r['date_iso']: continue
        st = CSO_STATION.get(r['station'])
        if st: log[r['date_iso']][st] += float(r['volume_mg'])
    storms = []
    drops = {}
    for e in top:
        start = datetime.date.fromisoformat(e['start']); end = datetime.date.fromisoformat(e['end'])
        # seven days of lead-in so the model can build antecedent storage and
        # soil moisture before the ranked storm itself begins
        LEAD = 7
        t0 = datetime.datetime.combine(start - datetime.timedelta(days=LEAD), datetime.time(0))
        hours = int((datetime.datetime.combine(end + datetime.timedelta(days=2), datetime.time(0)) - t0).total_seconds() // 3600)
        by, coords, seen = hourly(os.path.join(SCR, 'hourly7', f"{e['start']}.csv"), t0)
        gauges = []
        for st in seen:
            if len(seen[st]) < hours * 0.5: continue        # station mostly absent
            series = by.get(st, {})
            arr = [round(series.get(h, 0.0), 3) for h in range(hours)]
            tot = sum(arr)
            if tot < 0.05: continue                          # reported nothing all storm: dead sensor (Gary)
            x, z = proj(*coords[st])
            gauges.append(dict(id=st, name=NAMES.get(st, st), lat=coords[st][0], lng=coords[st][1], x=x, z=z,
                               totalIn=round(tot, 2), hourly=arr, source=SRC_ASOS))

        # --- NCEI co-op hourly gauges (HPD v2) --------------------------
        hpd_st = {s['id']: s for s in json.load(open(os.path.join(SCR, 'hpd', 'stations.json')))}
        for st, arr in hpd_hourly(os.path.join(SCR, 'hpd', f"{e['start']}.json"), hpd_st, t0, hours).items():
            tot = sum(arr)
            if tot < 0.05: continue
            s = hpd_st[st]
            x, z = proj(s['lat'], s['lng'])
            gauges.append(dict(id=st, name=s['name'], lat=s['lat'], lng=s['lng'], x=x, z=z,
                               totalIn=round(tot, 2), hourly=[round(v, 3) for v in arr],
                               source=SRC_HPD))

        # --- USGS tipping-bucket gauges ---------------------------------
        for sid, g in usgs_hourly(os.path.join(SCR, 'usgs', f"{e['start']}.json"), t0, hours).items():
            tot = sum(g['hourly'])
            if tot < 0.05: continue
            x, z = proj(g['lat'], g['lng'])
            gauges.append(dict(id='usgs-' + sid, name=g['name'], lat=g['lat'], lng=g['lng'], x=x, z=z,
                               totalIn=round(tot, 2), hourly=[round(v, 3) for v in g['hourly']],
                               source=SRC_USGS))

        # --- GHCN-Daily gauges, shaped by their nearest hourly neighbour ---
        # the dead-gauge check looks at the hourly gauges too: an ASOS whose
        # neighbours measured inches while it measured nothing was not dry
        daily, gauges, dropped = daily_gauges(
            os.path.join(SCR, 'daily', f"{e['start']}.json"), t0, hours, gauges)
        measured = list(gauges)          # only these have a hyetograph to lend
        for g in daily:
            near = shape_from(g, measured)
            if not near: continue
            d, m = near
            x, z = proj(g['lat'], g['lng'])
            # no hourly array: the series is totalIn/sum(shape) times the shape
            # gauge's, and writing it out would be a megabyte of redundancy.
            # sim.js expands it once per storm.
            gauges.append(dict(id=g['id'], name=g['name'], lat=g['lat'], lng=g['lng'], x=x, z=z,
                               totalIn=g['totalIn'], source=SRC_DAILY,
                               shapeFrom=m['id'], shapeKm=round(d, 1)))
        drops[e['start']] = dropped
        shaped = {g['id'] for g in gauges if 'hourly' in g}
        for g in gauges:
            assert 'hourly' in g or g['shapeFrom'] in shaped, \
                f"{e['start']}: {g['id']} borrows its shape from {g.get('shapeFrom')}, which has none"
        # recorded discharge within the window (plus two days for lag)
        rec = collections.defaultdict(float)
        d = start
        while d <= end + datetime.timedelta(days=2):
            for st, v in log.get(d.isoformat(), {}).items(): rec[st] += v
            d += datetime.timedelta(days=1)
        yr = start.year
        era = 'pre' if yr < 2007 else 'tunnels' if yr < 2015 else 'r2015' if yr < 2018 else 'today'
        storms.append(dict(
            id=e['start'], start=e['start'], end=e['end'], t0=t0.isoformat(), hours=hours, leadHr=LEAD * 24,
            stormHr=int((datetime.datetime.combine(end + datetime.timedelta(days=1), datetime.time(0)) - t0).total_seconds() // 3600) - LEAD * 24,
            ghcn=dict(ORD=round(e['ord'], 2), MDW=round(e['mdw'], 2)),
            gauges=sorted(gauges, key=lambda g: -g['totalIn']),
            recordedCsoMG={k: round(v, 1) for k, v in rec.items()},
            recordedTotalMG=round(sum(rec.values()), 1),
            era=era))
    out = dict(meta=dict(
        ranking='multi-day events (consecutive days with >=0.10 in at either gauge, one dry day allowed, light edges trimmed) ranked by the larger of the two gauge totals, 2006-01-01 to 2026-09-20',
        daily='NCEI GHCN-Daily PRCP: USW00094846 (O’Hare), USW00014819 (Midway)',
        hourly='four networks, listed under sources below; every series starts seven days before the ranked event so antecedent conditions are real, and every gauge carries its own lat/lng, name and source',
        recorded='MWRD pumping-station discharge log in data/mwrd-ps-cso-activity.csv, summed over the event window plus two days',
        sources=[
            dict(source=SRC_ASOS, url='https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py',
                 note='ten regional airports (ORD MDW PWK DPA LOT IGQ GYY UGN ARR ENW), tz=America/Chicago, p01i is the total for the hour ending at the observation'),
            dict(source=SRC_HPD, url='https://www.ncei.noaa.gov/access/services/data/v1?dataset=coop-hourly-precipitation',
                 inventory='https://www.ncei.noaa.gov/data/coop-hourly-precipitation/v2/station-inventory/',
                 note='NCEI Hourly Precipitation Data v2. The network is sparse here: five stations within 75 km, of which Chicago Midway AP 3SW (USC00111577) is the only one inside the city. HRnnVal is the total for nn:00-nn+1:00 LST in hundredths of an inch; values carrying a failed-check or deleted quality flag are dropped. The bin alignment against local civil time was measured, not assumed -- see hpd_hourly() in scripts/build_storms.py.'),
            dict(source=SRC_USGS, url='https://waterservices.usgs.gov/nwis/iv/?parameterCd=00045',
                 inventory='https://waterservices.usgs.gov/nwis/site/?parameterCd=00045&hasDataTypeCd=iv&countyCd=17031,17043,17097,17089&seriesCatalogOutput=true',
                 note='59 gauges within 45 km. Instantaneous values begin 2007-10-01 at the older sites, so the 2007 storm gets none; the ~20 dense in-city gauges are the USGS successors to the Illinois State Water Survey Cook County network and only start in 2019-2020, which is why the 2020 storm has far more gauges than the rest. Readings are 0.01 in bucket tips at irregular times, binned here to the hour ending.'),
            dict(source=SRC_DAILY, url='https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries&dataTypes=PRCP&units=standard',
                 inventory='https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt',
                 note='Every GHCN-Daily PRCP station within 45 km, which is mostly the CoCoRaHS volunteer network. ASSUMPTION: these are daily reads, so each gauge keeps its own measured EVENT total but takes its hourly shape from the nearest measured hourly gauge, scaled. The amount is observed; the timing is not. Gauges missing any day of the window are dropped.'),
        ],
        deadGauges=dict(
            rule='a gauge whose event total is under 15% of the median of the gauges within 15 km of it, where that median is at least 1.00 in and at least five neighbours exist, is treated as a failed gauge rather than a dry spot, and dropped',
            note='this check applies to the hourly networks too, and it has to: the airports fail more often than one would like. It removes Midway ASOS from the July 2011 event, where the airport logged 0.17 in over the window while nineteen gauges within 13 km of it logged 2.4 to 5.2 in, and Chicago Executive from both September 2008 and April 2013. April 2013 also drops five USGS gauges at once, which is the shape of a network whose unheated tipping buckets are not all back in service by mid-April; gauges reading low but not low enough to trip this rule will still be in the April and October events.',
            dropped={k: [dict(id=i, name=n, totalIn=t, neighbourMedianIn=m) for i, n, t, m in v]
                     for k, v in drops.items() if v}),
        notUsed=[
            dict(network='Illinois State Water Survey Cook County Precipitation Network (25 gauges, Oct 1989 - Sep 2019)',
                 status='not freely available',
                 note='The data portal at isws.illinois.edu/data/ccprecipnet/ is gone (every documented path 404s) and the network was terminated on 2019-09-30. Even while it ran, the public download was daily only; the 10-minute and hourly products were a live current-conditions display, and quality-controlled series were available "by request" through the Midwestern Regional Climate Center. USGS SIR 2025-5102 records that its own authors had to obtain the historical series from the Army Corps rather than any public endpoint. Historical hourly CCPN needs an email request, so it is not used here.',
                 url='https://web.archive.org/web/20180511230453/https://www.isws.illinois.edu/data/ccprecipnet/'),
            dict(network='MWRD rain-gauge network (23 gauges)',
                 status='available, but daily and only from 2016',
                 note='Reachable without a login through the Rain Gauge Viewer’s own ArcGIS proxy, but it carries one daily total per gauge per day and its record starts in mid-2016, so it would cover only two of these ten storms and would add nothing the GHCN-Daily network does not already give at higher density. Not used.',
                 url='https://gispub.mwrd.org/raingaugeviewer/'),
            dict(network='City of Chicago Beach Weather Stations',
                 status='available, but three lakefront points from 2015',
                 note='Hourly interval_rain at Foster, Oak Street and 63rd Street only, starting 2015-04-25. Too few points, too far east, and too late for eight of these ten storms. Not used.',
                 url='https://data.cityofchicago.org/resource/k7hf-8y75.json'),
            dict(network='Cook County open data portal',
                 status='nothing to use',
                 note='The Socrata catalogue returns no precipitation or rain-gauge dataset at all.',
                 url='https://datacatalog.cookcountyil.gov'),
        ],
        caveat='Gauges are point measurements; convective storms vary sharply between them. The model rains each basin by the AREA average of the inverse-distance gauge field over a grid of sample points inside the basin (map-data/system3d.js, basins[].samples), not by the field at the basin centroid.'),
        storms=storms)
    merge_observed(out)
    for s in storms:
        n = collections.Counter(g['source'] for g in s['gauges'])
        print(f"{s['start']}..{s['end']} {s['hours']:4d} h  gauges={len(s['gauges']):3d} "
              f"(asos {n[SRC_ASOS]}, hpd {n[SRC_HPD]}, usgs {n[SRC_USGS]}, daily {n[SRC_DAILY]})  " +
              ' '.join(f"{g['id']}:{g['totalIn']}" for g in s['gauges'][:3]) +
              f"  | recorded CSO {s['recordedTotalMG']:,.0f} MG  era={s['era']}")
        for i, nm, t, m in drops[s['start']]:
            print(f"    dropped {i} {nm}: {t} in vs neighbourhood median {m} in")
    write(out)

if __name__ == '__main__':
    observed_only() if '--observed-only' in sys.argv else main()
