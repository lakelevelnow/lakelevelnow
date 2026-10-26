// fetch-levels.mjs — lakelevelnow.com data pipeline (v2, NASA-grade).
//
// Pulls current lake/reservoir levels from FREE, keyless government APIs:
//   • CDEC  — California Data Exchange (cdec.water.ca.gov)
//   • USGS  — USGS NWIS Instantaneous Values (waterservices.usgs.gov)
//   • USBR  — Bureau of Reclamation Lower Colorado hourly JSON (usbr.gov)
//   • TWDB  — Texas Water Development Board daily reservoir CSV (waterdatafortexas.org)
//   • CWMS  — U.S. Army Corps of Engineers CWMS Data API (cwms-data.usace.army.mil)
//
// ── Reliability rules (the "NASA rules" the project runs under) ─────────────
//  1. DETERMINISTIC INPUTS — every lake's feed is an explicit binding in
//     src/data/sources.json. The pipeline NEVER does runtime name-discovery
//     against a search API. (Discovery is a dev-only tool: discover-sources.mjs.)
//  2. BOUNDED EXECUTION — every network call has a hard timeout and a fixed
//     retry budget with exponential backoff. No call can hang the run.
//  3. FAIL-SAFE — a transient upstream failure NEVER drops a lake that had data.
//     The previous reading is kept and re-labeled stale. We ship the freshest
//     reading we have; we label it honestly. No silent data loss.
//  4. FAIL-CLOSED FRESHNESS — a reading older than FRESH_DAYS is never marked
//     fresh, regardless of where it came from. The homepage "live" set only
//     contains genuinely current readings.
//  5. SINGLE SOURCE OF TRUTH — sources.json binds feeds; lakes.seed.json holds
//     metadata; this script emits lakes.json + levels.json + health.json. The
//     site reads only the emitted files (lib/lakes.ts).
//  6. NO SILENT FAILURES — every outcome is logged and recorded in health.json
//     with per-lake feed, as_of, age, and a status string. Exit code is 0 unless
//     the ENTIRE run produced zero fresh readings (circuit-breaker), so a flaky
//     single lake never fails CI.
//
// Run locally and in CI:  node scripts/fetch-levels.mjs   (npm run fetch)
// No API keys required.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src', 'data');
const SEED_PATH = join(DATA, 'lakes.seed.json');
const SOURCES_PATH = join(DATA, 'sources.json');
const LAKES_OUT = join(DATA, 'lakes.json');
const LEVELS_OUT = join(DATA, 'levels.json');
const HEALTH_OUT = join(DATA, 'health.json');

const FRESH_DAYS = 7;
const SERIES_DAYS = 30;
const UA = 'lakelevelnow-data/1.0 (+https://lakelevelnow.com; contact@lakelevelnow.com)';
const TIMEOUT_MS = 20000;
const RETRIES = 3;

const now = Date.now();
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => now - n * 86400000;
const ageDays = (iso) => (iso ? (now - new Date(iso).getTime()) / 86400000 : Infinity);
const todayISO = () => new Date(now).toISOString();

// ---- bounded, retried HTTP (NASA rule 2) -------------------------------------
async function httpGet(url, accept = 'application/json,text/plain,*/*') {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** attempt); // 0.8s, 1.6s, 3.2s
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ac.signal,
        headers: { 'User-Agent': UA, Accept: accept },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RDB (tab-delimited, '#' comment line, header + dash line) → objects.
function parseRDB(rdb) {
  const lines = rdb.split('\n').filter((l) => l.length && !l.startsWith('#'));
  if (lines.length < 3) return [];
  const header = lines[0].split('\t');
  return lines.slice(2).map((l) => {
    const c = l.split('\t');
    const o = {};
    header.forEach((h, i) => (o[h] = c[i]));
    return o;
  });
}

// ---- adapters: each returns a uniform reading or null ------------------------
// Uniform reading: { level_ft, storage_af, pct_full, as_of, series:[{t,v}], msl }
//   msl=true means level_ft is an elevation (feet above mean sea level), so it
//   can be compared to full_pool_ft. msl=false means stage/gage height.
const USGS_PARAM_META = {
  '62614': { label: 'reservoir elevation', msl: true },
  '00062': { label: 'reservoir elevation', msl: true },
  '00065': { label: 'gage height', msl: false },
};

async function fetchUSGS(site) {
  // Probe the three reservoir params at once; rank elevation above stage.
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${site}&parameterCd=62614,00062,00065&siteStatus=all&period=P${SERIES_DAYS}D`;
  const d = JSON.parse(await httpGet(url));
  const ts = d?.value?.timeSeries || [];
  const ranked = ts
    .map((t) => {
      const code = String(t.variable.variableCode[0].value);
      const meta = USGS_PARAM_META[code] || { label: 'stage', msl: false };
      const vals = t.values[0].value.filter((v) => v.value && v.value !== '-999999');
      if (!vals.length) return null;
      return {
        code,
        msl: meta.msl,
        label: meta.label,
        level: parseFloat(vals[vals.length - 1].value),
        as_of: vals[vals.length - 1].dateTime,
        series: vals.map((v) => ({ t: v.dateTime, v: parseFloat(v.value) })),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.msl - a.msl) || (new Date(b.as_of) - new Date(a.as_of)));
  const r = ranked[0];
  if (!r) return null;
  return { level_ft: r.level, storage_af: null, pct_full: null, as_of: r.as_of, series: downsampleDaily(r.series, SERIES_DAYS), delta_24h: delta24(r.series), msl: r.msl, param_label: r.label };
}

async function fetchCDEC(station, capacity) {
  const start = ymd(daysAgo(SERIES_DAYS + 5));
  const end = ymd(now);
  const url = `https://cdec.water.ca.gov/dynamicapp/req/JSONDataServlet?Stations=${station}&SensorNums=15,6&dur_code=D&Start=${start}&End=${end}`;
  const rows = JSON.parse(await httpGet(url));
  if (!Array.isArray(rows) || !rows.length) return null;
  const ok = (r) => r.value !== null && r.value !== undefined && r.value !== -9999 && r.value !== '-9999';
  const sto = rows.filter((r) => String(r.SENSOR_NUM) === '15' && ok(r)).sort((a, b) => new Date(a.date) - new Date(b.date));
  const elev = rows.filter((r) => String(r.SENSOR_NUM) === '6' && ok(r)).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!sto.length && !elev.length) return null;
  const useElev = elev.length > 0;
  const src = useElev ? elev : sto;
  const last = src[src.length - 1];
  const storage_af = sto.length ? Number(sto[sto.length - 1].value) : null;
  const level = useElev ? Number(last.value) : null;
  const pct = capacity && storage_af ? Math.max(0, Math.min(100, Math.round((storage_af / capacity) * 100))) : null;
  const as_of = String(last.date).replace(/(\d{4})-(\d{1,2})-(\d{1,2}).*/, '$1-$2-$3');
  return {
    level_ft: level,
    storage_af,
    pct_full: pct,
    as_of,
    series: downsampleDaily(src.map((r) => ({ t: String(r.date), v: Number(r.value), storage: !useElev })), SERIES_DAYS),
    msl: useElev, // elevation sensor is msl; pure-storage fallback is not
    param_label: useElev ? 'reservoir elevation' : 'reservoir storage',
  };
}

// USBR Lower Colorado JSON carries Mead/Mohave/Havasu in one request. Cache it.
// The promise is cached too, so when www.usbr.gov times out the three lakes share ONE
// bounded retry cycle instead of paying it three times.
let _usbr = null;
function usbrSeries() {
  if (!_usbr) {
    _usbr = httpGet('https://www.usbr.gov/lc/region/g4000/riverops/webreports/hourlyweb.json').then(
      (txt) => parseUsbr(txt)?.Series || [],
    );
  }
  return _usbr;
}
// USBR sometimes splices a .NET exception ("Collection was modified ...") into the
// middle of the JSON. Keep every complete series before the break instead of failing.
function parseUsbr(txt) {
  try {
    return JSON.parse(txt);
  } catch (e) {
    let end = txt.length;
    for (let i = 0; i < 400; i++) {
      end = txt.lastIndexOf(']}', end - 1);
      if (end < 0) break;
      try {
        const out = JSON.parse(txt.slice(0, end + 2) + ']}');
        console.warn(`USBR JSON malformed (${e.message}); salvaged ${out.Series?.length || 0} series`);
        return out;
      } catch {}
    }
    throw e;
  }
}
const ELEV_DT = 'reservoir ws elevation, end of period primary reading';
const STO_DT = 'storage, end of period reading';
function dmyToIso(t) {
  // "6/19/2026 11:00:00 AM" → ISO
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i.exec(String(t).trim());
  if (!m) return String(t);
  const [, mo, da, yr, hh, mm, ss, ap] = m;
  let h = +hh % 12;
  if (/PM/i.test(ap || '')) h += 12;
  return `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}T${String(h).padStart(2, '0')}:${mm}:${ss}`;
}
async function fetchUSBR(siteName, capacity) {
  const series = await usbrSeries();
  const elev = series.find((s) => s.SiteName === siteName && s.DataTypeName === ELEV_DT);
  const sto = series.find((s) => s.SiteName === siteName && s.DataTypeName === STO_DT);
  if (!elev && !sto) return null;
  const pick = elev || sto;
  const data = (pick.Data || []).filter((p) => p.v !== null && p.v !== '' && p.v !== undefined);
  if (!data.length) return null;
  const last = data[data.length - 1];
  const storage_af = sto ? Number((sto.Data.find((p) => p.v) && [...sto.Data].reverse().find((p) => p.v)?.v)) : null;
  const level = elev ? Number(last.v) : null;
  const pct = capacity && storage_af ? Math.max(0, Math.min(100, Math.round((storage_af / capacity) * 100))) : null;
  return {
    level_ft: level,
    storage_af,
    pct_full: pct,
    as_of: dmyToIso(last.t),
    series: downsampleDaily(data.map((p) => ({ t: dmyToIso(p.t), v: Number(p.v) })), SERIES_DAYS),
    delta_24h: delta24(data.map((p) => ({ t: dmyToIso(p.t), v: Number(p.v) }))),
    msl: !!elev,
    param_label: elev ? 'reservoir elevation' : 'reservoir storage',
  };
}

// ---- TWDB daily reservoir CSV (Texas) -----------------------------------------
// adsense-w2 (2026-10-26): Texas lakes without a USGS elevation gage. TWDB publishes one
// row per day: date, water_level (ft msl), conservation storage and percent_full. TWDB is
// slow (9-22 s measured), so one 45 s attempt plus one retry, all lakes fetched in
// parallel before the main loop (see twdbFeed below).
function parseTWDBCsv(txt) {
  const rows = String(txt).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (rows.length < 2) return [];
  const header = rows[0].split(',');
  const col = (n) => header.indexOf(n);
  const iDate = col('date'), iLvl = col('water_level'), iPct = col('percent_full'), iSto = col('conservation_storage');
  if (iDate < 0 || iLvl < 0) return [];
  return rows.slice(1).map((l) => l.split(',')).filter((c) => c.length === header.length && /^\d{4}-\d{2}-\d{2}$/.test(c[iDate]))
    .map((c) => ({ t: c[iDate], v: Number(c[iLvl]), pct: iPct >= 0 && c[iPct] !== '' ? Number(c[iPct]) : null, sto: iSto >= 0 && c[iSto] !== '' ? Number(c[iSto]) : null }))
    .filter((r) => Number.isFinite(r.v));
}
async function fetchTWDB(name) {
  const url = `https://www.waterdatafortexas.org/reservoirs/individual/${name}-30day.csv`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TWDB_TIMEOUT_MS);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'text/csv,text/plain,*/*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseTWDBCsv(await res.text());
      if (!rows.length) return null;
      const last = rows[rows.length - 1];
      const pct = Number.isFinite(last.pct) && last.pct >= 0 && last.pct <= 110 ? Math.round(last.pct * 10) / 10 : null;
      const series = rows.map((r) => ({ t: r.t, v: r.v }));
      return {
        level_ft: last.v,
        storage_af: Number.isFinite(last.sto) ? last.sto : null,
        pct_full: pct,
        as_of: last.t,
        series: downsampleDaily(series, SERIES_DAYS),
        delta_24h: delta24(series),
        msl: true,
        param_label: 'reservoir elevation',
      };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---- USACE CWMS Data API (Corps reservoirs; TVA and Alabama Power pools it carries) ----
// adsense-w2 (2026-10-26). Deterministic binding (rule 1): sources.json gives the office and
// the exact time-series id, found with /catalog/TIMESERIES and checked with curl. Values are
// [epoch ms, value, quality]. Some upstream loggers stamp local time as UTC (Alabama Power's
// Smith Lake reads 4-5 h "in the future"), so points later than the fetch time are dropped.
async function fetchCWMS(office, tsid) {
  const qs = new URLSearchParams({
    office, name: tsid, unit: 'EN', 'page-size': '5000',
    begin: new Date(daysAgo(SERIES_DAYS + 5)).toISOString(),
    end: new Date(now + 86400000).toISOString(),
  });
  const d = JSON.parse(await httpGet(`https://cwms-data.usace.army.mil/cwms-data/timeseries?${qs}`, 'application/json;version=2'));
  const pts = (d?.values || [])
    .filter((x) => Array.isArray(x) && x[1] !== null && Number.isFinite(Number(x[1])) && x[0] <= now + 15 * 60000)
    .map((x) => ({ t: new Date(x[0]).toISOString(), v: Math.round(Number(x[1]) * 100) / 100 }));
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  return {
    level_ft: last.v,
    storage_af: null,
    pct_full: null,
    as_of: last.t,
    series: downsampleDaily(pts, SERIES_DAYS),
    delta_24h: delta24(pts),
    msl: true,
    param_label: 'reservoir elevation',
  };
}

// ---- RISE fallback (Reclamation's official data API) ----------------------------
// www.usbr.gov/.../hourlyweb.json can time out for days (from CI and locally), which
// left Mead/Mohave/Havasu on "Connecting". RISE (data.usbr.gov) publishes the same
// Reclamation daily elevation + storage for these dams. Deterministic bindings (rule 1):
// catalog items found via /rise/api/location/{3514,3513,3515} -> catalog-record -> items.
const RISE_ITEMS = {
  'Lake Mead': { elev: 6123, sto: 6124 }, // Hoover Dam
  'Lake Mohave': { elev: 6133, sto: 6134 }, // Davis Dam
  'Lake Havasu': { elev: 6128, sto: 6129 }, // Parker Dam
};
// Bound the query by date: an unfiltered order=DESC sorts the item's whole history
// (33k rows for Mead) and took 30-50 s; the dateTime[after] window answers in ~1.3 s.
async function riseResults(itemId) {
  const after = ymd(daysAgo(SERIES_DAYS + 10));
  const url = `https://data.usbr.gov/rise/api/result?itemId=${itemId}&dateTime%5Bafter%5D=${after}&itemsPerPage=100`;
  const d = JSON.parse(await httpGet(url, 'application/vnd.api+json'));
  return (d?.data || [])
    .map((r) => ({ t: r?.attributes?.dateTime, v: Number(r?.attributes?.result) }))
    .filter((p) => p.t && p.v !== null && Number.isFinite(p.v))
    .sort((a, b) => new Date(a.t) - new Date(b.t));
}
async function fetchRISE(siteName, capacity) {
  const ids = RISE_ITEMS[siteName];
  if (!ids) return null;
  const [elevS, stoS] = await Promise.all([
    riseResults(ids.elev).catch(() => []),
    ids.sto ? riseResults(ids.sto).catch(() => []) : [],
  ]);
  const src = elevS.length ? elevS : stoS;
  if (!src.length) return null;
  const last = src[src.length - 1];
  const storage_af = stoS.length ? stoS[stoS.length - 1].v : null;
  const pct = capacity && storage_af ? Math.max(0, Math.min(100, Math.round((storage_af / capacity) * 100))) : null;
  return {
    level_ft: elevS.length ? last.v : null,
    storage_af,
    pct_full: pct,
    as_of: last.t,
    series: downsampleDaily(src, SERIES_DAYS),
    delta_24h: delta24(src),
    msl: elevS.length > 0,
    param_label: elevS.length ? 'reservoir elevation' : 'reservoir storage',
  };
}
// USBR hourly first; RISE when it fails, lacks the lake, or is older than FRESH_DAYS.
// Both are Reclamation data, so the lake keeps feed 'usbr' and its source label.
async function fetchUSBRWithFallback(siteName, capacity) {
  let primary = null;
  let primaryErr = null;
  try {
    primary = await fetchUSBR(siteName, capacity);
  } catch (e) {
    primaryErr = e;
  }
  if (primary && ageDays(primary.as_of) <= FRESH_DAYS) return primary;
  const why = primaryErr ? `failed: ${primaryErr.message || primaryErr.name}` : primary ? 'stale' : 'no series';
  let fallback = null;
  try {
    fallback = await fetchRISE(siteName, capacity);
  } catch (e) {
    if (!primary && primaryErr) throw new Error(`USBR ${primaryErr.message}; RISE ${e.message}`);
  }
  if (fallback && (!primary || ageDays(fallback.as_of) < ageDays(primary.as_of))) {
    process.stdout.write(`[USBR hourly ${why}; RISE fallback] `);
    return fallback;
  }
  if (primaryErr && !primary) throw primaryErr;
  return primary;
}

// ---- TWDB percent full (Texas) -------------------------------------------------
// USGS gives Texas lakes an elevation but no storage, so pct_full stayed null and the
// SERP's reference answer (TWDB's "Medina Lake: 28.7% full") never appeared in our title.
// TWDB publishes a free daily CSV per reservoir. FAIL-CLOSED: any error, a missing
// column, a non-finite or out-of-range value, or a TWDB date more than 3 days away from
// the USGS reading yields null, and the page falls back to feet. TWDB is slow (9-22 s
// measured), so one bounded attempt per lake, all fetched in parallel before the loop.
const TWDB_NAMES = {
  'lake-travis': 'travis',
  'lake-buchanan': 'buchanan',
  'medina-lake': 'medina',
  'canyon-lake': 'canyon',
  'lake-belton': 'belton',
  'lake-somerville': 'somerville',
  'lake-fork': 'fork',
  'lake-whitney': 'whitney',
};
const TWDB_TIMEOUT_MS = 45000;
const TWDB_MAX_GAP_DAYS = 3;

async function fetchTWDBPct(name) {
  const url = `https://www.waterdatafortexas.org/reservoirs/individual/${name}-30day.csv`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TWDB_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'text/csv,text/plain,*/*' } });
    if (!res.ok) return null;
    const rows = (await res.text()).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (rows.length < 2) return null;
    const header = rows[0].split(',');
    const iDate = header.indexOf('date');
    const iPct = header.indexOf('percent_full');
    if (iDate < 0 || iPct < 0) return null;
    const last = rows[rows.length - 1].split(',');
    if (last.length !== header.length) return null; // truncated body
    const pct = Number(last[iPct]);
    const date = String(last[iDate]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(pct) || pct < 0 || pct > 110) return null;
    return { pct: Math.round(pct * 10) / 10, date };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- load inputs (NASA rule 5: single source of truth) -----------------------
const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
const sourcesRaw = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
const SOURCES = Object.fromEntries(Object.entries(sourcesRaw).filter(([k]) => !k.startsWith('_')));
const prevLevels = safeReadJSON(LEVELS_OUT, {}); // last-known-good cache (rule 3)

// adsense-w2 (2026-10-26): the committed levels.json is weeks old, so when CDEC timed out
// in CI the "last-known-good" reading was older than FRESH_DAYS and 10 California pages
// fell back to "feed connecting". Every deploy now also publishes the emitted levels.json
// at /data/levels.json, and the next run reads it back as a second cache. Per lake, the
// newer of the two wins. One bounded attempt; any failure leaves the committed cache.
const LIVE_CACHE_URL = 'https://lakelevelnow.com/data/levels.json';
const PUBLIC_LEVELS_OUT = join(ROOT, 'public', 'data', 'levels.json');
try {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  const res = await fetch(LIVE_CACHE_URL, { signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const live = await res.json();
  let used = 0;
  for (const [slug, r] of Object.entries(live || {})) {
    if (!r || typeof r.as_of !== 'string' || !Array.isArray(r.series) || (r.level_ft == null && r.pct_full == null)) continue;
    const prev = prevLevels[slug];
    if (!prev || ageDays(r.as_of) < ageDays(prev.as_of)) { prevLevels[slug] = r; used++; }
  }
  console.log(`Live cache ${LIVE_CACHE_URL}: ${used} newer readings than the committed levels.json`);
} catch (e) {
  console.log(`Live cache ${LIVE_CACHE_URL} unavailable (${e.message || e.name}); using the committed levels.json only`);
}

function safeReadJSON(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// Collapse a high-frequency series (USGS IV 15-min, USBR hourly) to ONE reading
// per local day, keeping the latest reading of each YYYY-MM-DD. This is what makes
// a "30-day series" actually span 30 days — without it, .slice(-30) on 15-min data
// is a 7.5-hour window mislabeled as a month, and every delta/change derived from it
// (delta_24h, change30d) gets the wrong sign. CDEC is already daily (dur_code=D),
// so this is a harmless no-op there. Preserves the optional {storage:true} flag.
function downsampleDaily(points, maxDays) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const byDay = new Map();
  for (const p of points) {
    const day = String(p.t).slice(0, 10);
    const prev = byDay.get(day);
    if (!prev || String(p.t) > String(prev.t)) byDay.set(day, p); // latest reading of the day
  }
  return [...byDay.values()].sort((a, b) => new Date(a.t) - new Date(b.t)).slice(-maxDays);
}

function delta24(series) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  const a = last.v;
  const lastT = new Date(last.t).getTime();
  // Pick the point closest to 24h before the last reading (must be >= 12h old so a
  // same-day intra-day swing can't masquerade as a day's change). With a properly
  // daily series this is yesterday's reading — a real ~24h delta, not a 7-hour one.
  let best = null;
  for (const p of series.slice(0, -1)) {
    const ageH = (lastT - new Date(p.t).getTime()) / 3600000;
    if (ageH >= 12 && (!best || Math.abs(ageH - 24) < Math.abs(best.ageH - 24))) best = { v: p.v, ageH };
  }
  if (!best) return null;
  return Math.round((a - best.v) * 100) / 100;
}

// ---- main --------------------------------------------------------------------
const twdbPct = Object.fromEntries(
  await Promise.all(Object.entries(TWDB_NAMES).map(async ([slug, name]) => [slug, await fetchTWDBPct(name)])),
);
// Parallel prefetch for TWDB-bound lakes (slow upstream; rule 2 still bounds each call).
const twdbFeed = Object.fromEntries(Object.entries(SOURCES).filter(([, s]) => s.feed === 'twdb')
  .map(([slug, s]) => [slug, fetchTWDB(s.site).then((r) => ({ r }), (e) => ({ e }))]));
const lakes = [];
const levels = {};
const health = [];
let fresh = 0;
let stale = 0;
let missing = 0;

for (const lk of seed) {
  const src = SOURCES[lk.slug];
  process.stdout.write(`• ${lk.name} (${lk.state}) … `);

  let newReading = null;
  let err = null;
  if (src) {
    try {
      if (src.feed === 'cdec') newReading = await fetchCDEC(src.site, lk.capacity_af);
      else if (src.feed === 'usgs') newReading = await fetchUSGS(src.site);
      else if (src.feed === 'usbr') newReading = await fetchUSBRWithFallback(src.site, lk.capacity_af);
      else if (src.feed === 'twdb') { const o = await twdbFeed[lk.slug]; if (o.e) throw o.e; newReading = o.r; }
      else if (src.feed === 'cwms') newReading = await fetchCWMS(src.office, src.site);
      // Fail closed on a wrong binding or a unit error in the newer TWDB/CWMS bindings: an
      // elevation more than 120 ft from the lake's full pool is not this lake's surface.
      // (Not applied to Mead/Powell, which really sit 170-190 ft below full pool.)
      if ((src.feed === 'twdb' || src.feed === 'cwms') && newReading && newReading.level_ft != null && lk.full_pool_ft != null && Math.abs(newReading.level_ft - lk.full_pool_ft) > 120) {
        err = `implausible level ${newReading.level_ft} ft vs full pool ${lk.full_pool_ft} ft`;
        newReading = null;
      }
    } catch (e) {
      err = e.message;
    }
  }

  const cached = prevLevels[lk.slug] || null;

  // Rule 3+4: choose the freshest reading we have; label honestly.
  let chosen = null;
  let status = 'missing';
  if (newReading && (!cached || ageDays(newReading.as_of) <= ageDays(cached.as_of))) {
    chosen = newReading;
    status = ageDays(newReading.as_of) <= FRESH_DAYS ? 'fresh' : 'stale-upstream';
  } else if (cached) {
    chosen = cached;
    status = newReading ? 'stale-cached-fresher' : (err ? `stale-fetch-failed:${err}` : 'stale-cached');
  }
  const chosenFresh = chosen && ageDays(chosen.as_of) <= FRESH_DAYS;

  if (chosenFresh) fresh++;
  else if (chosen) stale++;
  else missing++;

  // registry entry (always ships — the page is the SEO asset)
  lakes.push({
    slug: lk.slug,
    name: lk.name,
    state: lk.state,
    river: lk.river,
    operator: lk.operator,
    full_pool_ft: lk.full_pool_ft ?? null,
    capacity_af: lk.capacity_af ?? null,
    vol: lk.vol ?? null,
    kd: lk.kd ?? null,
    feed: src?.feed ?? null,
    usgs_site: src?.feed === 'usgs' ? src.site : null,
    cdec_id: src?.feed === 'cdec' ? src.site : (lk.cdec_id ?? null),
    lat: null,
    lon: null,
  });

  if (chosen) {
    let feet_from_full = null;
    if (chosen.msl && lk.full_pool_ft && chosen.level_ft != null) {
      feet_from_full = Math.round((lk.full_pool_ft - chosen.level_ft) * 100) / 100;
    }
    // TWDB percent full only for a fresh USGS reading, and only when both are within a
    // few days of each other, so the title never pairs a stale percent with today's feet.
    // A USGS reading never carries its own percent; a cached one may hold an old TWDB value.
    let pctFull = src?.feed === 'usgs' ? null : (chosen.pct_full ?? null);
    let pctSource = pctFull != null ? (src?.feed ?? null) : null;
    let pctAsOf = pctSource === 'twdb' ? String(chosen.as_of).slice(0, 10) : null;
    const tw = src?.feed === 'usgs' ? twdbPct[lk.slug] : null;
    if (tw && chosenFresh && Math.abs(new Date(tw.date + 'T12:00:00Z').getTime() - new Date(chosen.as_of).getTime()) <= TWDB_MAX_GAP_DAYS * 86400000) {
      pctFull = tw.pct;
      pctSource = 'twdb';
      pctAsOf = tw.date;
    }
    levels[lk.slug] = {
      level_ft: chosen.level_ft,
      storage_af: chosen.storage_af ?? null,
      pct_full: pctFull,
      pct_source: pctSource,
      pct_as_of: pctAsOf,
      feet_from_full,
      param: chosen.param_label,
      delta_24h: chosen.delta_24h != null ? chosen.delta_24h : delta24(chosen.series),
      series: chosen.series.slice(-SERIES_DAYS),
      as_of: chosen.as_of,
      feed: src?.feed ?? chosen.feed ?? null,
      fresh: !!chosenFresh,
      status,
    };
    if (TWDB_NAMES[lk.slug]) process.stdout.write(`[TWDB ${pctSource === 'twdb' ? pctFull + '% @ ' + pctAsOf : 'none, feet only'}] `);
    console.log(
      `${chosenFresh ? '✓' : '·'} ${chosen.level_ft ?? (chosen.storage_af != null ? chosen.storage_af + ' AF' : '?')} ` +
      `(feed=${src?.feed}) @ ${String(chosen.as_of).slice(0, 10)} age=${ageDays(chosen.as_of).toFixed(1)}d [${status}]`
    );
  } else {
    console.log(`✗ no live feed${src ? '' : ' (registry only)'}`);
  }

  health.push({
    slug: lk.slug,
    feed: src?.feed ?? null,
    as_of: chosen ? chosen.as_of : null,
    age_days: chosen ? Math.round(ageDays(chosen.as_of) * 10) / 10 : null,
    fresh: !!chosenFresh,
    status,
  });
}

mkdirSync(DATA, { recursive: true });
writeFileSync(LAKES_OUT, JSON.stringify(lakes, null, 2));
writeFileSync(LEVELS_OUT, JSON.stringify(levels, null, 2));
// Published with the site (gitignored), read back by the next run as the live cache.
mkdirSync(dirname(PUBLIC_LEVELS_OUT), { recursive: true });
writeFileSync(PUBLIC_LEVELS_OUT, JSON.stringify(levels));
writeFileSync(
  HEALTH_OUT,
  JSON.stringify(
    {
      run_at: todayISO(),
      total: seed.length,
      fresh,
      stale,
      missing,
      fresh_slugs: health.filter((h) => h.fresh).map((h) => h.slug),
      lakes: health,
    },
    null,
    2,
  ),
);

console.log(`\nDone. ${seed.length} lakes → ${fresh} fresh · ${stale} stale(cached) · ${missing} no-feed.`);
console.log(`  → lakes.json · levels.json · health.json`);
console.log(`  Circuit-breaker: ${fresh === 0 ? 'ZERO fresh — exit 1' : 'ok'}`);

// Rule 6: nonzero exit ONLY when the whole run is cold (zero fresh data),
// which signals a systemic outage rather than one flaky lake. CI stays green
// while individual lakes degrade gracefully to last-known-good.
if (fresh === 0 && seed.length > 0) process.exit(1);
