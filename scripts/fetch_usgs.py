#!/usr/bin/env python3
"""USGS NWIS instantaneous precipitation (parameter 00045) for every gauge
within 45 km of the model origin. Output: usgs/<start>.json

Needs $STORM_SCRATCH/usgs_sites.rdb, the site inventory, from
https://waterservices.usgs.gov/nwis/site/?format=rdb&parameterCd=00045
&siteStatus=all&hasDataTypeCd=iv&countyCd=17031,17043,17097,17089
&seriesCatalogOutput=true"""
import json, os, math, time, datetime, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCR = os.environ.get('STORM_SCRATCH', os.path.join(ROOT, '.storm-scratch'))
LAT0, LNG0 = 41.85, -87.75
os.makedirs(os.path.join(SCR, 'usgs'), exist_ok=True)

def sites():
    rows, hdr = [], None
    for L in open(os.path.join(SCR, 'usgs_sites.rdb')):
        if L.startswith('#'): continue
        f = L.rstrip('\n').split('\t')
        if hdr is None: hdr = f; continue
        if f and f[0].endswith('s') and len(f[0]) < 4: continue
        rows.append(dict(zip(hdr, f)))
    out = {}
    for r in rows:
        if r.get('parm_cd') != '00045' or r.get('data_type_cd') != 'uv': continue
        try: la, lo = float(r['dec_lat_va']), float(r['dec_long_va'])
        except Exception: continue
        if math.hypot((la - LAT0) * 111.1, (lo - LNG0) * 82.8) > 45: continue
        out[r['site_no']] = dict(id=r['site_no'], name=r['station_nm'].title(),
                                 lat=la, lng=lo, begin=r['begin_date'], end=r['end_date'])
    return out

def main():
    st = sites()
    print(len(st), 'USGS uv 00045 sites within 45 km')
    json.dump(st, open(os.path.join(SCR, 'usgs', 'stations.json'), 'w'), indent=1)
    storms = json.load(open(os.path.join(ROOT, 'map-data', 'storms.json')))['storms']
    for s in storms:
        out = os.path.join(SCR, 'usgs', f"{s['start']}.json")
        if os.path.exists(out): print('have', s['start']); continue
        t0 = datetime.datetime.fromisoformat(s['t0'])
        t1 = t0 + datetime.timedelta(hours=s['hours'] + 2)
        live = [k for k, v in st.items()
                if v['begin'] <= t0.date().isoformat() and v['end'] >= t1.date().isoformat()]
        series = []
        for i in range(0, len(live), 10):
            chunk = live[i:i + 10]
            url = 'https://waterservices.usgs.gov/nwis/iv/?' + urllib.parse.urlencode(dict(
                format='json', sites=','.join(chunk), parameterCd='00045',
                # send wall-clock local times with an explicit CDT offset; every
                # one of the ten windows lies inside daylight-saving time
                startDT=t0.strftime('%Y-%m-%dT%H:%M-05:00'),
                endDT=t1.strftime('%Y-%m-%dT%H:%M-05:00')))
            for attempt in range(5):
                try:
                    d = json.loads(urllib.request.urlopen(url, timeout=300).read().decode())
                    series += d['value']['timeSeries']
                    break
                except Exception as e:
                    print('   retry', e); time.sleep(25)
            time.sleep(6)
        json.dump(series, open(out, 'w'))
        n = sum(len(t['values'][0]['value']) for t in series)
        print(f"{s['start']}  {len(live):2d} live sites, {len(series):2d} series, {n} readings")

if __name__ == '__main__':
    main()
