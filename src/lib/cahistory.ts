// California long-record charts (/lake/<slug>/chart/ for CDEC lakes).
//
// Reads src/data/ca-history.json, which scripts/fetch-ca-history.mjs refreshes from CDEC on
// every build (monthly RESERVOIR STORAGE, sensor 15, dur_code=M, acre-feet). Every figure the
// chart pages print is computed here from that file. Nothing is typed by hand.
//
// THE FIRST-FILL BOUNDARY IS OURS AND IS ALWAYS STATED. Several of these files open while the
// reservoir was filling for the first time (Oroville opens at 1,000 acre-feet in 1967), so a
// whole-file minimum would call the filling years a record low. CDEC's Reservoir Information
// page lists a "Year Fill" for each station. Rankings, averages, extremes and shares below count
// only months from January of the year after that year. The whole-file minimum is still
// reported, labelled as such, when it is lower.
//
// A lake is charted only when its record spans at least MIN_YEARS years.
import history from '../data/ca-history.json';
import { LAKES } from './lakes';

export const MIN_YEARS = 15;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Station = {
  slug: string; cdecId: string; name: string; cdecLakeName: string | null;
  capacityAf: number | null; yearFill: number | null; yearBuilt: number | null;
  start: string; values: (number | null)[];
};

export type Point = [string, number];       // ['YYYY-MM', acre-feet]
export type CaChart = {
  slug: string; name: string; cdecId: string; cdecLakeName: string | null;
  capacityAf: number | null; yearFill: number | null;
  stationUrl: string; profileUrl: string; dataUrl: string;
  points: Point[];
  recordStart: string; recordEnd: string; years: number; monthsInFile: number;
  compareFrom: string;                     // first month counted in the comparisons
  latest: { ym: string; af: number; label: string };
  pctOfCapacity: number | null;
  sameMonth: { name: string; n: number; rankLow: number; rankHigh: number; avgAf: number; pctOfAvg: number;
    lowest: Point; highest: Point; sinceYear: number };
  recordLow: Point; recordHigh: Point;
  fileLow: Point | null;                   // whole-file minimum, only when it predates compareFrom and is lower
  monthsCompared: number; monthsBelow: number; shareBelowPct: number;
};
export type Skipped = { slug: string; name: string; cdecId: string | null; reason: string };

const idx = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const ymOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const fmtAf = (v: number) => Math.round(v).toLocaleString('en-US');

function pointsOf(s: Station): Point[] {
  const base = idx(s.start);
  const out: Point[] = [];
  const n = Math.min(s.values.length, 2000);
  for (let i = 0; i < n; i += 1) {
    const v = s.values[i];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out.push([ymOf(base + i), v]);
  }
  return out;
}

function extremes(pts: Point[]): { low: Point; high: Point } {
  let low = pts[0], high = pts[0];
  for (const p of pts) {
    if (p[1] < low[1]) low = p;              // strict, so ties keep the earliest month
    if (p[1] > high[1]) high = p;
  }
  return { low, high };
}

function sameMonthStats(cmp: Point[], latest: Point) {
  const mm = latest[0].slice(5, 7);
  const same = cmp.filter((p) => p[0].slice(5, 7) === mm);
  const lower = same.filter((p) => p[1] < latest[1]).length;
  const higher = same.filter((p) => p[1] > latest[1]).length;
  const avgAf = same.reduce((a, p) => a + p[1], 0) / same.length;
  const { low, high } = extremes(same);
  return {
    name: MONTHS[Number(mm) - 1], n: same.length, rankLow: lower + 1, rankHigh: higher + 1,
    avgAf, pctOfAvg: Math.round((latest[1] / avgAf) * 100), lowest: low, highest: high,
    sinceYear: Number(same[0][0].slice(0, 4)),
  };
}

function build(s: Station): CaChart | Skipped {
  const skip = (reason: string): Skipped => ({ slug: s.slug, name: s.name, cdecId: s.cdecId, reason });
  const pts = pointsOf(s);
  if (pts.length < 2) return skip('CDEC returned no monthly storage record');
  const recordStart = pts[0][0], recordEnd = pts[pts.length - 1][0];
  const years = Math.floor((idx(recordEnd) - idx(recordStart) + 1) / 12);
  if (years < MIN_YEARS) return skip(`monthly record spans ${years} years, under ${MIN_YEARS}`);
  const fillFrom = s.yearFill ? `${s.yearFill + 1}-01` : recordStart;
  const compareFrom = fillFrom > recordStart ? fillFrom : recordStart;
  const cmp = pts.filter((p) => p[0] >= compareFrom);
  if (cmp.length < MIN_YEARS * 12 * 0.8) return skip(`only ${cmp.length} months after the first fill`);
  const latest = pts[pts.length - 1];
  const { low, high } = extremes(cmp);
  const whole = extremes(pts);
  const monthsBelow = cmp.filter((p) => p[1] < latest[1]).length;
  return {
    slug: s.slug, name: s.name, cdecId: s.cdecId, cdecLakeName: s.cdecLakeName,
    capacityAf: s.capacityAf, yearFill: s.yearFill,
    stationUrl: `https://cdec.water.ca.gov/dynamicapp/staMeta?station_id=${s.cdecId}`,
    profileUrl: `https://cdec.water.ca.gov/dynamicapp/profile?s=${s.cdecId}&type=res`,
    dataUrl: `https://cdec.water.ca.gov/dynamicapp/req/CSVDataServlet?Stations=${s.cdecId}&SensorNums=15&dur_code=M&Start=${recordStart}-01&End=${recordEnd}-28`,
    points: pts, recordStart, recordEnd, years, monthsInFile: pts.length, compareFrom,
    latest: { ym: latest[0], af: latest[1], label: monthLabel(latest[0]) },
    pctOfCapacity: s.capacityAf ? Math.round((latest[1] / s.capacityAf) * 100) : null,
    sameMonth: sameMonthStats(cmp, latest),
    recordLow: low, recordHigh: high,
    fileLow: whole.low[0] < compareFrom && whole.low[1] < low[1] ? whole.low : null,
    monthsCompared: cmp.length, monthsBelow,
    shareBelowPct: Math.round((monthsBelow / cmp.length) * 100),
  };
}

const STATIONS = ((history as any).stations ?? {}) as Record<string, Station>;
const BUILT = Object.values(STATIONS).map(build);
const CA_CDEC = LAKES.filter((l) => l.state === 'CA' && l.cdec_id);

export const CA_CHARTS: CaChart[] = BUILT.filter((b): b is CaChart => 'points' in b);
export const CA_SKIPPED: Skipped[] = [
  ...BUILT.filter((b): b is Skipped => 'reason' in b),
  ...CA_CDEC.filter((l) => !STATIONS[l.slug]).map((l) => ({ slug: l.slug, name: l.name, cdecId: l.cdec_id, reason: 'no CDEC monthly record in src/data/ca-history.json' })),
];

export function caChartFor(slug: string): CaChart | undefined {
  return CA_CHARTS.find((c) => c.slug === slug);
}

// "1st", "2nd", "3rd", "11th", "22nd".
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th'}`;
}
