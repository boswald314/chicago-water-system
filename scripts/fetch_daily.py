#!/usr/bin/env python3
"""NCEI GHCN-Daily PRCP for every co-op / CoCoRaHS gauge near the combined-sewer
basins, for each of the ten storm windows. Output: daily/<start>.json

Needs $STORM_SCRATCH/ghcnd-stations.txt and ghcnd-inventory.txt, from
https://www.ncei.noaa.gov/pub/data/ghcn/daily/"""
import json, os, math, time, datetime, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCR = os.environ.get('STORM_SCRATCH', os.path.join(ROOT, '.storm-scratch'))
LAT0, LNG0 = 41.85, -87.75
RADIUS_KM = 45
os.makedirs(os.path.join(SCR, 'daily'), exist_ok=True)

def near_stations():
    inv = set()
    for L in open(os.path.join(SCR, 'ghcnd-inventory.txt')):
        if L[31:35].strip() == 'PRCP' and int(L[41:45]) >= 2007 and int(L[36:40]) <= 2021:
            inv.add(L[0:11])
    out = []
    for L in open(os.path.join(SCR, 'ghcnd-stations.txt')):
        sid = L[0:11]
        if sid not in inv: continue
        la, lo = float(L[12:20]), float(L[21:30])
        if math.hypot((la - LAT0) * 111.1, (lo - LNG0) * 82.8) > RADIUS_KM: continue
        out.append(sid)
    return sorted(out)

def fetch(stations, d0, d1):
    rows = []
    for i in range(0, len(stations), 40):
        chunk = stations[i:i + 40]
        url = 'https://www.ncei.noaa.gov/access/services/data/v1?' + urllib.parse.urlencode(dict(
            dataset='daily-summaries', dataTypes='PRCP', stations=','.join(chunk),
            startDate=d0, endDate=d1, format='json', units='standard',
            includeStationLocation='1', includeStationName='1'))
        for attempt in range(4):
            try:
                body = urllib.request.urlopen(url, timeout=300).read().decode()
                rows += json.loads(body or '[]')
                break
            except Exception as e:
                print('   retry', e); time.sleep(20)
        time.sleep(3)
    return rows

def main():
    sts = near_stations()
    print(len(sts), 'candidate GHCN-Daily PRCP stations within', RADIUS_KM, 'km')
    storms = json.load(open(os.path.join(ROOT, 'map-data', 'storms.json')))['storms']
    for s in storms:
        out = os.path.join(SCR, 'daily', f"{s['start']}.json")
        if os.path.exists(out): print('have', s['start']); continue
        t0 = datetime.datetime.fromisoformat(s['t0'])
        t1 = t0 + datetime.timedelta(hours=s['hours'])
        rows = fetch(sts, t0.date().isoformat(), (t1.date()).isoformat())
        json.dump(rows, open(out, 'w'))
        print(f"{s['start']}  {len(rows)} daily rows, "
              f"{len(set(r['STATION'] for r in rows))} stations")

if __name__ == '__main__':
    main()
