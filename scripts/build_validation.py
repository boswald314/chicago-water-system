#!/usr/bin/env python3
"""Observations the six-pumping-station log cannot supply, assembled per storm
so the 3D model can be checked on what else it predicts: which outfalls opened
and when, whether the system was forced to reverse into Lake Michigan, and
where water stood in the streets.

Three independent sources, none of which covers all ten storms:

  1. MWRD CSO Event Synopsis Report (apps.mwrd.org/csoreports) - per-outfall
     tide-gate open/close timestamps with waterway reach and treatment plant,
     plus MWRD's own three-basin rain-gauge totals. Earliest selectable date
     is 2016-04-01, so only the 2017 and 2020 storms are covered. The date
     list contains only days on which a CSO occurred, so a storm window with
     no listed date is a recorded absence of overflow, not missing data.
  2. MWRD's "Reversals to Lake Michigan (1985-Present)" table, hand-curated
     into data/storm-reports.csv with the verbatim table row as the quote.
     Covers nine of the ten storms; the tenth (2014-08-21) is a true negative.
  3. Chicago 311 service requests, "Water in Basement Complaint" and "Water On
     Street Complaint" (data.cityofchicago.org, v6vf-nfxy). The dataset begins
     2018-07-01 and those two request types first appear 2018-12-19, so only
     2020-05-14 of the ten is covered. The city publishes no pre-2019 311
     water dataset: its twelve "- Historical" 311 extracts are all non-water
     categories (graffiti, potholes, rodents, street lights and so on).

Raw pulls are cached outside the repo (scratchpad); pass --fetch to populate
them. Output: map-data/storm-validation.json.
"""
import json, csv, os, sys, re, html, datetime, collections
import urllib.parse, urllib.request, http.cookiejar

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCR = os.environ.get('STORM_SCRATCH', '/tmp/claude-501/-Users-bryanoswald-Documents-Research-ChicagoSewers/d40a9738-211e-496c-9658-45ebec776028/scratchpad')
CSO_DIR = os.path.join(SCR, 'valext', 'cso')
C311_DIR = os.path.join(SCR, '311')
FETCH = '--fetch' in sys.argv

SODA = 'https://data.cityofchicago.org/resource/v6vf-nfxy.json'
SR_BASEMENT = 'Water in Basement Complaint'
SR_STREET = 'Water On Street Complaint'
SR_WHERE = "sr_type in('%s','%s')" % (SR_BASEMENT, SR_STREET)
CSO_APP = 'https://apps.mwrd.org/csoreports/'
UA = {'User-Agent': 'ChicagoSewers-research/1.0 (+archive validation)'}
TODAY = datetime.date.today().isoformat()

SRC_CSO = dict(title='CSO Event Synopsis Report', url=CSO_APP, accessed=TODAY,
               note='MWRD; per-outfall tide-gate open/close times by waterway reach, '
                    'with the district rain-gauge basin totals. Earliest date 2016-04-01; '
                    'only days with a CSO are listed.')
SRC_311 = dict(title='311 Service Requests', url='https://data.cityofchicago.org/d/v6vf-nfxy',
               accessed=TODAY,
               note='City of Chicago open data; "%s" and "%s". Coverage begins 2018-12-19 '
                    'for these request types.' % (SR_BASEMENT, SR_STREET))


# ---------------------------------------------------------------- 311 pulls

def soda(params, tries=4):
    import time
    url = SODA + '?' + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if i == tries - 1:
                raise
            sys.stderr.write('311 retry %d: %s\n' % (i + 1, e))
            time.sleep(4 * (i + 1))


def complaints(storm):
    """Daily and per-area counts over start-1 .. end+3 (inclusive)."""
    path = os.path.join(C311_DIR, 'win-%s.json' % storm['id'])
    if not os.path.exists(path):
        if not FETCH:
            return None
        os.makedirs(C311_DIR, exist_ok=True)
        lo = (datetime.date.fromisoformat(storm['start']) - datetime.timedelta(days=1)).isoformat()
        hi = (datetime.date.fromisoformat(storm['end']) + datetime.timedelta(days=4)).isoformat()
        w = "%s AND created_date >= '%sT00:00:00' AND created_date < '%sT00:00:00'" % (SR_WHERE, lo, hi)
        raw = dict(window=[lo, hi],
                   daily=soda({'$select': 'date_trunc_ymd(created_date) as d, sr_type, count(*) as n',
                               '$where': w, '$group': 'd,sr_type', '$order': 'd', '$limit': 5000}),
                   byArea=soda({'$select': 'community_area, sr_type, count(*) as n',
                                '$where': w, '$group': 'community_area,sr_type', '$limit': 5000}),
                   byWard=soda({'$select': 'ward, sr_type, count(*) as n',
                                '$where': w, '$group': 'ward,sr_type', '$limit': 5000}))
        json.dump(raw, open(path, 'w'))
    raw = json.load(open(path))

    def pair(rows, key, numeric=False):
        """Sum [basement, street] per group. Socrata returns area/ward ids as
        floats ("1.0"); dates come back as full timestamps."""
        out = collections.defaultdict(lambda: [0, 0])
        for r in rows:
            k = r.get(key)
            if k in (None, ''):
                k = 'unknown'
            k = str(k).split('.')[0] if numeric else str(k)[:10]
            out[k][0 if r['sr_type'] == SR_BASEMENT else 1] += int(r['n'])
        return out

    lo, hi = raw['window']
    day = pair(raw['daily'], 'd')
    daily, d = [], datetime.date.fromisoformat(lo)
    while d < datetime.date.fromisoformat(hi):
        b, s = day.get(d.isoformat(), [0, 0])
        daily.append([d.isoformat(), b, s])
        d += datetime.timedelta(days=1)
    if not any(b or s for _, b, s in daily):
        return dict(coverage=False, window=[lo, hi], daily=None, total=None, byArea=None,
                    note='No 311 records: these request types begin 2018-12-19.')
    tb, ts = sum(x[1] for x in daily), sum(x[2] for x in daily)
    peak = max(daily, key=lambda x: x[1])
    return dict(coverage=True, window=[lo, hi], daily=daily, total=tb + ts,
                totalBasement=tb, totalStreet=ts, peakDay=peak[0], peakBasement=peak[1],
                byArea={k: v for k, v in sorted(pair(raw['byArea'], 'community_area', True).items())},
                byWard={k: v for k, v in sorted(pair(raw['byWard'], 'ward', True).items())},
                note='[date, basement, street] per day; byArea/byWard are [basement, street] totals.')


# ------------------------------------------------------- CSO synopsis pulls

def _cso_session():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def cso_fetch(op, date):
    """Export one rain-gauge date's synopsis report as CSV."""
    def get(url, data=None):
        h = dict(UA)
        if data is not None:
            h['Content-Type'] = 'application/x-www-form-urlencoded'
            h['Referer'] = CSO_APP
        with op.open(urllib.request.Request(url, data=data, headers=h), timeout=180) as r:
            return r.read().decode('utf-8', 'replace')
    page = get(CSO_APP)
    if ('<option value="%s"' % date) not in page:
        return None
    f = {}
    for m in re.finditer(r'<input[^>]*type="hidden"[^>]*>', page, re.I):
        n = re.search(r'name="([^"]*)"', m.group(0))
        v = re.search(r'value="([^"]*)"', m.group(0))
        if n:
            f[n.group(1)] = html.unescape(v.group(1)) if v else ''
    f.update({'ddlCSODates': date, 'bttSearchDay': 'Search',
              'txtStartDateSearch': '', 'txtEndDateSearch': ''})
    page2 = get(CSO_APP, urllib.parse.urlencode(f).encode())
    sess = re.search(r'ReportSession=([^&"\']+)', page2)
    ctl = re.search(r'ControlID=([^&"\']+)', page2)
    if not (sess and ctl):
        return None
    q = urllib.parse.urlencode({'ReportSession': sess.group(1), 'ControlID': ctl.group(1),
                                'Culture': '1033', 'CultureOverrides': 'False', 'UICulture': '1033',
                                'UICultureOverrides': 'False', 'ReportStack': '1', 'OpType': 'Export',
                                'FileName': 'CSO', 'ContentDisposition': 'AlwaysInline', 'Format': 'CSV'})
    return get(CSO_APP + 'Reserved.ReportViewerWebControl.axd?' + q)


def cso_dates():
    p = os.path.join(CSO_DIR, '_dates.json')
    if os.path.exists(p):
        return set(json.load(open(p)))
    if not FETCH:
        return None
    os.makedirs(CSO_DIR, exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(CSO_APP, headers=UA), timeout=180) as r:
        page = r.read().decode('utf-8', 'replace')
    ds = re.findall(r'<option value="(\d+/\d+/\d{4})"', page)
    json.dump(ds, open(p, 'w'))
    return set(ds)


DT = '%m/%d/%Y %I:%M:%S %p'


def cso(storm, listed, op):
    """Aggregate the per-outfall synopsis rows across the storm window."""
    if listed is None:
        return None
    lo = datetime.date.fromisoformat(storm['start']) - datetime.timedelta(days=1)
    hi = datetime.date.fromisoformat(storm['end']) + datetime.timedelta(days=3)
    earliest = min(datetime.datetime.strptime(d, '%m/%d/%Y').date() for d in listed)
    if hi < earliest:
        return dict(coverage=False, reaches=None, outfalls=None,
                    note='Storm predates the CSO Event Synopsis Report; earliest date %s.' % earliest.isoformat())
    want, d = [], lo
    while d <= hi:
        s = '%d/%d/%d' % (d.month, d.day, d.year)
        if s in listed:
            want.append((d, s))
        d += datetime.timedelta(days=1)
    if not want:
        return dict(coverage=True, dates=[], reaches={}, outfalls=0, openings=0, basinRainIn=None,
                    note='In coverage and MWRD lists no CSO day in this window: a recorded absence of overflow.')
    reaches = collections.defaultdict(lambda: dict(outfalls=set(), openings=0, plants=set()))
    outfalls, openings, rain = set(), 0, {}
    first, last = None, None
    for d, s in want:
        p = os.path.join(CSO_DIR, s.replace('/', '-') + '.csv')
        if not os.path.exists(p):
            if not FETCH:
                continue
            txt = cso_fetch(op, s)
            if txt is None:
                continue
            open(p, 'w').write(txt)
        rows = list(csv.reader(open(p)))
        mode = None
        for r in rows:
            if not r:
                continue
            if r[0] == 'Basin':
                mode = 'rain'; continue
            if r[0] == 'TARP_CONNECTION':
                mode = 'gate'; continue
            if mode == 'rain' and len(r) >= 2 and r[0].endswith('Basin'):
                try:
                    rain.setdefault(r[0].replace(' Basin', ''), []).append(float(r[1].strip()))
                except ValueError:
                    pass
            elif mode == 'gate' and len(r) >= 8 and r[5] and r[6]:
                reach = r[3].strip() or 'unknown'
                key = '%s|%s' % (r[0].strip(), r[2].strip())
                reaches[reach]['outfalls'].add(key)
                reaches[reach]['openings'] += 1
                if r[4].strip():
                    reaches[reach]['plants'].add(r[4].strip())
                outfalls.add(key); openings += 1
                try:
                    a = datetime.datetime.strptime(r[5].strip(), DT)
                    b = datetime.datetime.strptime(r[6].strip(), DT)
                except ValueError:
                    continue
                first = a if first is None or a < first else first
                last = b if last is None or b > last else last
    return dict(
        coverage=True, dates=[d.isoformat() for d, _ in want],
        reaches={k: dict(outfalls=len(v['outfalls']), openings=v['openings'],
                         plants=sorted(v['plants'])) for k, v in sorted(reaches.items())},
        outfalls=len(outfalls), openings=openings,
        firstOpen=first.isoformat() if first else None,
        lastClose=last.isoformat() if last else None,
        basinRainIn={k: round(max(v), 2) for k, v in sorted(rain.items())} or None,
        note='Distinct outfall+tide-gate pairs and the number of open/close cycles, by waterway '
             'reach, summed over the window. basinRainIn is MWRD\'s own gauge maximum per basin.')


# --------------------------------------------------------- curated reports

def curated():
    rows = list(csv.DictReader(open(os.path.join(ROOT, 'data', 'storm-reports.csv'))))
    by = collections.defaultdict(list)
    for r in rows:
        by[r['storm_id']].append(r)
    return by


def src_of(r):
    s = dict(title=r['source_title'], url=r['source_url'], accessed=r['accessed'], note=r['quote'])
    if r['source_local']:
        s['local'] = r['source_local']
    return s


def tarp(rows):
    """Reversal volumes, summed over every reversal event inside the window."""
    rev = {k: None for k in ('obrienMG', 'crcwMG', 'wilmetteMG', 'totalMG')}
    KEY = dict(obrien_mg='obrienMG', crcw_mg='crcwMG', wilmette_mg='wilmetteMG', total_mg='totalMG')
    dates, quotes = [], []
    for r in rows:
        if r['kind'] != 'reversal':
            continue
        k = KEY.get(r['key'])
        if not k:
            continue
        rev[k] = round((rev[k] or 0) + float(r['value']), 1)
        if r['event_date'] and r['event_date'] not in dates:
            dates.append(r['event_date'])
        if r['quote'] not in quotes:
            quotes.append(r['quote'])
    return dict(
        reversal=dict(dates=dates, quotes=quotes, **rev),
        gallonsCapturedMG=None, reservoirPeakPct=None, tunnelPeakPct=None, basementsFlooded=None,
        note='Reversal volumes are MWRD\'s published per-structure figures summed over every '
             'reversal event falling inside the storm window; a null structure means MWRD\'s '
             'table records no volume there. No per-storm TARP capture volume, reservoir or '
             'tunnel fill, or flooded-basement count was located for any of the ten storms - '
             'MWRD publishes those only as multi-year cumulative totals (see meta.context).')


def main():
    storms = json.load(open(os.path.join(ROOT, 'map-data', 'storms.json')))['storms']
    cur = curated()
    listed = cso_dates()
    op = _cso_session() if FETCH else None
    out = {}
    for st in storms:
        rows = cur.get(st['id'], [])
        c = cso(st, listed, op)
        comp = complaints(st)
        srcs = []
        for r in rows:
            s = src_of(r)
            if s not in srcs:
                srcs.append(s)
        if c and c.get('coverage') and c.get('dates'):
            srcs.append(SRC_CSO)
        if comp and comp.get('coverage'):
            srcs.append(SRC_311)
        out[st['id']] = dict(start=st['start'], end=st['end'], era=st['era'],
                             cso=c, tarp=tarp(rows), complaints=comp, sources=srcs)
    ctx = [dict(kind=r['kind'], key=r['key'], value=r['value'], unit=r['unit'],
                period=r['event_date'], scope=r['scope'], quote=r['quote'],
                source=src_of(r), note=r['note']) for r in cur.get('*', [])]
    doc = dict(meta=dict(
        purpose='Observations against which the 3D model can be checked beyond the six '
                'MWRD pumping stations in data/mwrd-ps-cso-activity.csv.',
        generated=TODAY,
        cso='MWRD CSO Event Synopsis Report, %s - per-outfall tide-gate open/close by waterway '
            'reach. Earliest date 2016-04-01, so only the 2017 and 2020 storms are covered. Only '
            'days with a CSO are listed, so an empty in-coverage window is a recorded absence.' % CSO_APP,
        tarp='Reversals to Lake Michigan, hand-curated into data/storm-reports.csv with the '
             'verbatim MWRD table row as the quote for every figure.',
        complaints='Chicago 311 "%s" and "%s", %s. These request types begin 2018-12-19, so only '
                   '2020-05-14 of the ten storms is covered; the city publishes no pre-2019 311 '
                   'water dataset.' % (SR_BASEMENT, SR_STREET, 'https://data.cityofchicago.org/d/v6vf-nfxy'),
        caveat='null means not found, never zero. Coverage differs per source and per storm; read '
               'the coverage flags before comparing storms with each other.',
        context=ctx), storms=out)
    p = os.path.join(ROOT, 'map-data', 'storm-validation.json')
    json.dump(doc, open(p, 'w'), separators=(',', ':'))
    for sid, v in out.items():
        c, t, m = v['cso'], v['tarp']['reversal'], v['complaints']
        print('%s  cso:%-28s  reversal:%9s MG  311:%s' % (
            sid,
            'n/a' if not c else ('out of coverage' if not c['coverage']
                                 else '%d outfalls / %d reaches' % (c['outfalls'], len(c['reaches']))),
            '%.1f' % t['totalMG'] if t['totalMG'] is not None else 'none',
            'n/a' if not m else ('none' if not m['coverage'] else '%d basement / %d street' % (
                m['totalBasement'], m['totalStreet']))))
    print('storm-validation.json', os.path.getsize(p) // 1024, 'KB')


if __name__ == '__main__':
    main()
