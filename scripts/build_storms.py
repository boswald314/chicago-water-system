#!/usr/bin/env python3
"""Recorded storms for the 3D model: the ten largest multi-day rainfall events
at Chicago's two first-order gauges since 2006, with hourly hyetographs from
every ASOS station in the region, so the model can rain a real storm with its
real spatial shape and be compared with what MWRD actually recorded.

Inputs (fetched separately, cached in the scratchpad):
  ghcn_ord.json / ghcn_mdw.json   NCEI GHCN-Daily PRCP, USW00094846 / USW00014819
  events_top.json                 event windows ranked from those two records
  hourly/<start>.csv              IEM ASOS 1-hour precipitation (p01i) for
                                  ORD MDW PWK DPA LOT IGQ GYY UGN ARR ENW
Output: map-data/storms.json
"""
import json, csv, os, sys, math, datetime, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCR = os.environ.get('STORM_SCRATCH', '/tmp/claude-501/-Users-bryanoswald-Documents-Research-ChicagoSewers/d40a9738-211e-496c-9658-45ebec776028/scratchpad')
LAT0, LNG0 = 41.85, -87.75
MPLAT = 111132.0; MPLNG = 111320.0 * math.cos(math.radians(LAT0))
def proj(lat, lng): return (round((lng - LNG0) * MPLNG), round(-(lat - LAT0) * MPLAT))

CSO_STATION = {'Racine Avenue': 'ps-racine', 'North Branch': 'ps-north-branch', 'Westchester': 'ps-westchester',
               '125th St': 'ps-125th', '95th St': 'ps-95th', '122nd St': 'ps-122nd'}
NAMES = {'ORD': "O'Hare", 'MDW': 'Midway', 'PWK': 'Chicago Executive (Wheeling)', 'DPA': 'DuPage (West Chicago)',
         'LOT': 'Lewis (Romeoville)', 'IGQ': 'Lansing', 'GYY': 'Gary', 'UGN': 'Waukegan', 'ARR': 'Aurora', 'ENW': 'Kenosha'}

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

def main():
    top = json.load(open(os.path.join(SCR, 'events_top.json')))[:10]
    ghcn = {}
    for k, f in (('ORD', 'ghcn_ord.json'), ('MDW', 'ghcn_mdw.json')):
        ghcn[k] = {x['DATE']: float(x['PRCP']) for x in json.load(open(os.path.join(SCR, f))) if x.get('PRCP') not in (None, '')}
    log = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in csv.DictReader(open(os.path.join(ROOT, 'data', 'mwrd-ps-cso-activity.csv'))):
        if r['row_type'] != 'event' or not r['volume_mg'] or not r['date_iso']: continue
        st = CSO_STATION.get(r['station'])
        if st: log[r['date_iso']][st] += float(r['volume_mg'])
    storms = []
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
                               totalIn=round(tot, 2), hourly=arr))
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
        hourly='Iowa Environmental Mesonet ASOS 1-hour precipitation (p01i), routine hourly reports; T = 0.005 in; each series starts seven days before the ranked event so antecedent conditions are real',
        recorded='MWRD pumping-station discharge log in data/mwrd-ps-cso-activity.csv, summed over the event window plus two days',
        caveat='Gauges are point measurements; convective storms vary sharply between them. The model rains each basin by inverse-distance weighting of the gauges around its centroid.'),
        storms=storms)
    json.dump(out, open(os.path.join(ROOT, 'map-data', 'storms.json'), 'w'), separators=(',', ':'))
    for s in storms:
        print(f"{s['start']}..{s['end']} {s['hours']:4d} h  gauges={len(s['gauges'])}  " +
              ' '.join(f"{g['id']}:{g['totalIn']}" for g in s['gauges'][:5]) +
              f"  | recorded CSO {s['recordedTotalMG']:,.0f} MG  era={s['era']}")
    print('storms.json', os.path.getsize(os.path.join(ROOT, 'map-data', 'storms.json')) // 1024, 'KB')

if __name__ == '__main__':
    main()
