#!/usr/bin/env python3
"""NCEI Hourly Precipitation Data (HPD v2) for the co-op hourly gauges near the
combined-sewer basins. Output: hpd/<start>.json

Needs $STORM_SCRATCH/hpd_inv.csv, the HPD v2 station inventory, from
https://www.ncei.noaa.gov/data/coop-hourly-precipitation/v2/station-inventory/"""
import json, os, math, csv, time, datetime, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCR = os.environ.get('STORM_SCRATCH', os.path.join(ROOT, '.storm-scratch'))
LAT0, LNG0 = 41.85, -87.75
RADIUS_KM = 75
os.makedirs(os.path.join(SCR, 'hpd'), exist_ok=True)

def near():
    out = []
    for r in csv.DictReader(open(os.path.join(SCR, 'hpd_inv.csv'))):
        try: la, lo = float(r['Lat']), float(r['Lon'])
        except Exception: continue
        if math.hypot((la - LAT0) * 111.1, (lo - LNG0) * 82.8) > RADIUS_KM: continue
        out.append(dict(id=r['StnID'], name=r['Name'].title(), lat=la, lng=lo,
                        utcOffset=int(r['UTC_Offset']), por=r['POR_Date_Range']))
    return out

def main():
    sts = near()
    print(len(sts), 'HPD stations within', RADIUS_KM, 'km:',
          ', '.join(f"{s['id']} {s['name']}" for s in sts))
    json.dump(sts, open(os.path.join(SCR, 'hpd', 'stations.json'), 'w'), indent=1)
    storms = json.load(open(os.path.join(ROOT, 'map-data', 'storms.json')))['storms']
    for s in storms:
        out = os.path.join(SCR, 'hpd', f"{s['start']}.json")
        if os.path.exists(out): print('have', s['start']); continue
        t0 = datetime.datetime.fromisoformat(s['t0'])
        t1 = t0 + datetime.timedelta(hours=s['hours'] + 48)
        url = 'https://www.ncei.noaa.gov/access/services/data/v1?' + urllib.parse.urlencode(dict(
            dataset='coop-hourly-precipitation',
            stations=','.join(x['id'] for x in sts),
            startDate=(t0.date() - datetime.timedelta(days=1)).isoformat(),
            endDate=t1.date().isoformat(), format='json'))
        rows = []
        for attempt in range(4):
            try:
                rows = json.loads(urllib.request.urlopen(url, timeout=300).read().decode() or '[]')
                break
            except Exception as e:
                print('   retry', e); time.sleep(20)
        json.dump(rows, open(out, 'w'))
        print(f"{s['start']}  {len(rows)} station-days, "
              f"{sorted(set(r['STATION'] for r in rows))}")
        time.sleep(4)

if __name__ == '__main__':
    main()
