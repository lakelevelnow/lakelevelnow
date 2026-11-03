// Fetch CDEC's complete MONTHLY storage record (sensor 15, dur_code=M) for every California
// lake in src/data/lakes.json that carries a cdec_id, plus the capacity and the first-fill year
// CDEC publishes on each station's Reservoir Information page. Writes src/data/ca-history.json,
// which src/lib/cahistory.ts turns into the /lake/<slug>/chart/ pages.
//
// WHY MONTHLY: a monthly file covers the whole record (back to the 1940s and 1950s for most of
// these stations) in about 900 rows per lake, so all twelve lakes fit in one small JSON file.
//
// FAILURE POSTURE, same as fetch-lake-history.mjs: a network or parse failure keeps the previous
// entry for that station, and a CDEC outage keeps the whole previous file. The script exits 0
// whenever a previous file exists, so a CDEC outage never breaks the daily build. It exits 1
// only on a first run with nothing to fall back on.
//
// IDEMPOTENT: the file carries no run timestamp. It is rewritten only when the data changed.
//
// CDEC_VIA=google-translate (local runs only): some networks cannot open a TCP connection to
// cdec.water.ca.gov (the owner's VPN exit is one). This routes the same two URLs through
// Google's translate.goog proxy and reads the untouched servlet text out of its <pre> block.
// CI does not set it and talks to CDEC directly.
//
// No axios (supply-chain rule), native fetch only, bounded retries, bounded loops, and one
// overall deadline so an unreachable CDEC cannot stall the build.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'data', 'ca-history.json');
const LAKES_FILE = path.join(ROOT, 'src', 'data', 'lakes.json');
const UA = 'lakelevelnow-data/1.0 (+https://lakelevelnow.com)';
const TIMEOUT_MS = 30000;
const RETRIES = 2;
const DEADLINE_MS = 4 * 60 * 1000;   // whole run; CI must never wait longer for CDEC
const MAX_STATIONS = 40;
const MAX_ROWS = 2000;                // 1900 to 2066 is 2,000 months
const MIN_ROWS = 120;                 // ten years; anything shorter is a truncated reply
const MAX_AF = 1e8;
const VIA = process.env.CDEC_VIA === 'google-translate' ? 'google-translate' : 'direct';
const T0 = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

const dataUrl = (id) =>
  `https://cdec.water.ca.gov/dynamicapp/req/CSVDataServlet?Stations=${id}&SensorNums=15&dur_code=M&Start=1900-01-01&End=${today()}`;
const profileUrl = (id) => `https://cdec.water.ca.gov/dynamicapp/profile?s=${id}&type=res`;

function routed(url) {
  if (VIA !== 'google-translate') return url;
  const u = new URL(url);
  u.hostname = 'cdec-water-ca-gov.translate.goog';
  u.searchParams.set('_x_tr_sl', 'auto');
  u.searchParams.set('_x_tr_tl', 'en');
  u.searchParams.set('_x_tr_hl', 'en');
  return u.toString();
}

function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

async function httpGet(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (Date.now() - T0 > DEADLINE_MS) throw new Error('run deadline passed');
    if (attempt > 0) await sleep(800 * 2 ** attempt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(routed(url), { redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('fetch failed');
}

// The CSV servlet returns STATION_ID,DURATION,SENSOR_NUMBER,SENSOR_TYPE,DATE TIME,OBS DATE,
// VALUE,DATA_FLAG,UNITS. '---' and negative or absurd values are missing months, never zero.
function parseMonthly(txt, id) {
  const body = VIA === 'google-translate' ? unescapeHtml((/<pre>([\s\S]*?)<\/pre>/.exec(txt) || [])[1] || '') : String(txt);
  const lines = body.split('\n');
  const rows = new Map();
  for (let i = 0; i < lines.length && i <= MAX_ROWS + 1; i += 1) {
    const c = lines[i].trim().split(',');
    if (c.length < 7 || c[0] !== id || c[1] !== 'M' || c[2] !== '15') continue;
    const m = /^(\d{4})(\d{2})01 /.exec(c[4]);
    const v = Number(c[6]);
    if (!m || c[6] === '---' || !Number.isFinite(v) || v < 0 || v > MAX_AF) continue;
    const ym = `${m[1]}-${m[2]}`;
    if (!rows.has(ym)) rows.set(ym, Math.round(v));
  }
  return [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

// Dense encoding: the first month, then one value per month with null for a missing month.
function encodeDense(rows) {
  if (!rows.length) return null;
  const start = rows[0][0];
  const base = monthIndex(start);
  const n = monthIndex(rows[rows.length - 1][0]) - base + 1;
  if (n > MAX_ROWS) return null;
  const values = new Array(n).fill(null);
  for (const [ym, v] of rows) values[monthIndex(ym) - base] = v;
  return { start, values };
}

// Reservoir Information page text: "Lake Name X Stream Name ... Capacity 3,424,753 af
// Year Built 1968 Year Fill 1969". Any field that does not parse is null, never guessed.
function parseProfile(html) {
  const t = unescapeHtml(String(html).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const lakeName = (/Lake Name (.+?) Stream Name/.exec(t) || [])[1] || null;
  const cap = /Capacity ([\d,]+) af/.exec(t);
  const fill = /Year Fill (\d{4})\b/.exec(t);
  const built = /Year Built (\d{4})\b/.exec(t);
  return {
    cdecLakeName: lakeName ? lakeName.trim() : null,
    capacityAf: cap ? Number(cap[1].replace(/,/g, '')) : null,
    yearFill: fill ? Number(fill[1]) : null,
    yearBuilt: built ? Number(built[1]) : null,
  };
}

async function oneStation(lake, prev) {
  const id = lake.cdec_id;
  const rows = parseMonthly(await httpGet(dataUrl(id)), id);
  if (rows.length < MIN_ROWS) throw new Error(`${rows.length} monthly rows, below the ${MIN_ROWS} floor`);
  const dense = encodeDense(rows);
  if (!dense) throw new Error('series too long to encode');
  if (prev && prev.values && dense.values.length < prev.values.length - 24) {
    throw new Error(`series shrank from ${prev.values.length} to ${dense.values.length} months`);
  }
  let profile = { cdecLakeName: null, capacityAf: null, yearFill: null, yearBuilt: null };
  try {
    profile = parseProfile(await httpGet(profileUrl(id)));
  } catch (e) {
    console.warn(`  ${id}: profile page failed (${e.message}), keeping the previous profile fields`);
  }
  const keep = (k) => (profile[k] != null ? profile[k] : prev?.[k] ?? null);
  return {
    slug: lake.slug, cdecId: id, name: lake.name,
    cdecLakeName: keep('cdecLakeName'), capacityAf: keep('capacityAf'),
    yearFill: keep('yearFill'), yearBuilt: keep('yearBuilt'),
    sensor: 15, durCode: 'M', units: 'AF',
    start: dense.start, values: dense.values,
  };
}

async function main() {
  const lakes = JSON.parse(await readFile(LAKES_FILE, 'utf8'))
    .filter((l) => l.state === 'CA' && /^[A-Z0-9]{3}$/.test(l.cdec_id || ''))
    .slice(0, MAX_STATIONS);
  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { previous = null; }
  const prevStations = previous?.stations || {};
  const stations = {};
  let fresh = 0;
  let failedInARow = 0;
  for (const lake of lakes) {
    const prev = prevStations[lake.slug];
    if (failedInARow >= 2 && fresh === 0) {           // CDEC is down; do not burn the deadline
      if (prev) stations[lake.slug] = prev;
      continue;
    }
    try {
      stations[lake.slug] = await oneStation(lake, prev);
      fresh += 1;
      failedInARow = 0;
      const s = stations[lake.slug];
      console.log(`  ${lake.cdec_id} ${lake.slug}: ${s.values.length} months from ${s.start}`);
    } catch (e) {
      failedInARow += 1;
      console.warn(`  ${lake.cdec_id} ${lake.slug}: ${e.message}${prev ? ', keeping the previous series' : ', no previous series'}`);
      if (prev) stations[lake.slug] = prev;
    }
    await sleep(400);
  }
  if (fresh === 0) {
    console.warn(`ca-history: CDEC gave no usable series (via ${VIA}), ${previous ? 'previous file kept' : 'and there is no previous file'}`);
    process.exit(previous ? 0 : 1);
  }
  const payload = {
    source: 'California Data Exchange Center (CDEC), California Department of Water Resources',
    sensor: 'RESERVOIR STORAGE, sensor 15, monthly (dur_code=M), acre-feet',
    dataUrlPattern: 'https://cdec.water.ca.gov/dynamicapp/req/CSVDataServlet?Stations=<ID>&SensorNums=15&dur_code=M',
    stations,
  };
  // One station per line: small diffs in git, still plain JSON.
  const head = JSON.stringify({ ...payload, stations: undefined }, null, 2).replace(/\n}$/, '');
  const body = Object.entries(stations).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  const text = `${head},\n  "stations": {\n${body}\n  }\n}\n`;
  const old = await readFile(OUT, 'utf8').catch(() => '');
  if (old === text) { console.log(`ca-history: ${fresh}/${lakes.length} stations fetched, file unchanged`); return; }
  await writeFile(OUT, text);
  console.log(`ca-history: ${fresh}/${lakes.length} stations fetched, wrote ${path.relative(ROOT, OUT)} (${text.length} bytes)`);
}

main().catch((e) => {
  console.warn(`ca-history: unexpected error, previous file kept: ${e?.message || e}`);
  process.exit(0);
});
