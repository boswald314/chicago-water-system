#!/usr/bin/env python3
"""Re-fetch the IEM ASOS hourly precipitation the archive's build_storms.py eats.
Windows are taken from the committed map-data/storms.json so the ten events are
byte-identical to the ones already published."""
import json, os, time, datetime, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCR = os.environ.get('STORM_SCRATCH', os.path.join(ROOT, '.storm-scratch'))
STATIONS = ['ORD', 'MDW', 'PWK', 'DPA', 'LOT', 'IGQ', 'GYY', 'UGN', 'ARR', 'ENW']
os.makedirs(os.path.join(SCR, 'hourly7'), exist_ok=True)

storms = json.load(open(os.path.join(ROOT, 'map-data', 'storms.json')))['storms']
# events_top.json, reconstructed from the published storms
top = [dict(start=s['start'], end=s['end'], ord=s['ghcn']['ORD'], mdw=s['ghcn']['MDW'])
       for s in storms]
json.dump(top, open(os.path.join(SCR, 'events_top.json'), 'w'), indent=1)

for s in storms:
    out = os.path.join(SCR, 'hourly7', f"{s['start']}.csv")
    if os.path.exists(out) and os.path.getsize(out) > 20000:
        print('have', out); continue
    t0 = datetime.datetime.fromisoformat(s['t0'])
    t1 = t0 + datetime.timedelta(hours=s['hours'] + 1)
    q = [('data', 'p01i'), ('tz', 'America/Chicago'), ('format', 'onlycomma'),
         ('latlon', 'yes'), ('missing', 'M'), ('trace', 'T'), ('report_type', '3'),
         ('year1', t0.year), ('month1', t0.month), ('day1', t0.day),
         ('year2', t1.year), ('month2', t1.month), ('day2', t1.day)]
    q = [('station', st) for st in STATIONS] + q
    url = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?' + urllib.parse.urlencode(q)
    for attempt in range(4):
        try:
            body = urllib.request.urlopen(url, timeout=300).read().decode()
        except Exception as e:
            print('  err', e); time.sleep(30); continue
        # IEM rate-limits by writing the refusal INSIDE the CSV
        if 'Too many requests' in body or body.count('\n') < 500:
            print('  throttled/short', s['start'], body.count('\n'), body[:120].replace('\n', ' '))
            time.sleep(60); continue
        open(out, 'w').write(body)
        print(f"{s['start']}  {body.count(chr(10))} rows")
        break
    else:
        print('FAILED', s['start'])
    time.sleep(20)
print('done')
