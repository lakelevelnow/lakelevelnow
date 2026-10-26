// Seasonal target pools (adsense-w3, 2026-10-26).
// Some operators lower a lake's target level every winter (TVA on Kentucky Lake, the Corps
// on Lanier, Allatoona, Wappapello, Nolin and Texoma, Alabama Power on Smith Lake). Against
// the fixed summer full pool those lakes read "X ft below full" for months while they sit
// exactly where the operator wants them. This module computes the operator's own target for
// the date of the reading, from the breakpoints in src/data/seasonal-pools.json, so a page can
// show "vs seasonal target" next to "vs full pool". No curve is estimated: a lake without
// published breakpoints gets no target (kind "note" carries the explanation instead).
import pools from '../data/seasonal-pools.json';
import type { Reading } from './lakes';
import { status } from './lakes';

export interface SeasonalCurve {
  kind: 'curve';
  interp: 'linear' | 'step';
  name: string;
  agency: string;
  agencyLong: string;
  points: [string, number][];
  summer: number;
  winter: number;
  datum: string;
  precision?: string;
  source: { label: string; url: string };
  operator?: { label: string; url: string };
  why: string;
}
export interface SeasonalNote {
  kind: 'note';
  name: string;
  agency: string;
  text: string;
  source: { label: string; url: string };
}
export type SeasonalEntry = SeasonalCurve | SeasonalNote;

const POOLS = pools as unknown as Record<string, SeasonalEntry>;

export function seasonalEntry(slug: string): SeasonalEntry | null {
  const e = POOLS[slug];
  return e && typeof e === 'object' && (e.kind === 'curve' || e.kind === 'note') ? e : null;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
// Day of a 365-day year (0-364) for "MM-DD". Feb 29 counts as Feb 28.
const doyMD = (md: string) => {
  const [m, d] = md.split('-').map(Number);
  return CUM[m - 1] + Math.min(d, m === 2 ? 28 : d) - 1;
};
export const fmtMD = (md: string) => { const [m, d] = md.split('-').map(Number); return `${MON[m - 1]} ${d}`; };

// Calendar date the feed wrote ("2026-10-26T07:00:00Z", "2026-10-25"), never shifted.
export function readingDoy(asOf: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(asOf || ''));
  if (!m) return null;
  return doyMD(`${m[2]}-${m[3]}`);
}

export type Phase = 'winter' | 'filling' | 'summer' | 'drawdown' | 'seasonal';

// Target elevation for a day of the year, plus the phase of the curve on that day.
export function curveAt(c: SeasonalCurve, doy: number): { target: number; phase: Phase } {
  const pts = c.points.map(([md, v]) => ({ d: doyMD(md), v })).sort((a, b) => a.d - b.d);
  // The curve repeats every year: the segment after the last point runs to the first point
  // of the next year.
  let prev = pts[pts.length - 1], next = pts[0];
  let prevD = prev.d - 365, nextD = next.d;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].d <= doy) { prev = pts[i]; prevD = pts[i].d; next = pts[(i + 1) % pts.length]; nextD = i + 1 < pts.length ? next.d : next.d + 365; }
  }
  if (doy < pts[0].d) { prev = pts[pts.length - 1]; prevD = prev.d - 365; next = pts[0]; nextD = next.d; }
  let target: number;
  if (c.interp === 'step' || nextD === prevD) target = prev.v;
  else target = prev.v + (next.v - prev.v) * ((doy - prevD) / (nextD - prevD));
  target = Math.round(target * 100) / 100;
  // Phase: words for the reader. Flat at the summer or winter value, or moving between them.
  let phase: Phase;
  const rising = c.interp === 'linear' && next.v > prev.v;
  const falling = c.interp === 'linear' && next.v < prev.v;
  if (rising) phase = 'filling';
  else if (falling) phase = 'drawdown';
  else if (Math.abs(target - c.summer) < 0.01) phase = 'summer';
  else if (Math.abs(target - c.winter) < 0.01) phase = 'winter';
  else phase = 'seasonal';
  return { target, phase };
}

export interface SeasonalRead {
  curve: SeasonalCurve;
  target: number;
  phase: Phase;
  // Positive = the surface is ABOVE the seasonal target (same sign convention as a gain).
  diff: number;
  // Feet the summer full pool sits above today's target (0 in summer).
  seasonalDrop: number;
}

export function seasonalRead(slug: string, reading: Reading | undefined | null): SeasonalRead | null {
  const e = seasonalEntry(slug);
  if (!e || e.kind !== 'curve' || !reading || reading.level_ft == null) return null;
  const doy = readingDoy(reading.as_of);
  if (doy == null) return null;
  const { target, phase } = curveAt(e, doy);
  return {
    curve: e,
    target,
    phase,
    diff: Math.round((reading.level_ft - target) * 100) / 100,
    seasonalDrop: Math.round((e.summer - target) * 100) / 100,
  };
}

// "0.2 ft above", "1.3 ft below", "at" (within 0.05 ft).
export function diffWords(diff: number): string {
  if (Math.abs(diff) < 0.05) return 'at';
  return `${Math.abs(diff).toFixed(1)} ft ${diff > 0 ? 'above' : 'below'}`;
}

// Status against the seasonal target, for lakes that have one. Replaces the full-pool
// bucket, which calls a lake at its normal winter level "below normal".
export function seasonalStatus(s: SeasonalRead): { label: string; tone: 'green' | 'cyan' | 'amber' | 'red' } {
  const d = s.diff;
  if (d >= 1) return { label: 'above seasonal target', tone: 'cyan' };
  if (d >= -1) return { label: 'at seasonal target', tone: 'green' };
  if (d >= -5) return { label: 'below seasonal target', tone: 'amber' };
  return { label: 'well below seasonal target', tone: 'red' };
}

export const phaseWords: Record<Phase, string> = {
  winter: 'holding at its winter level',
  filling: 'rising',
  summer: 'holding at its summer level',
  drawdown: 'falling',
  seasonal: 'holding at an in-between seasonal level',
};

// Status for lists and cards: the seasonal bucket for an elevation-only lake with a curve and
// a fresh reading, otherwise the usual percent-full / feet-from-full bucket.
export function levelStatus(slug: string, r: Reading | undefined | null) {
  const s = r && r.fresh && r.pct_full == null ? seasonalRead(slug, r) : null;
  return s ? seasonalStatus(s) : status(r?.pct_full ?? null, r?.feet_from_full ?? null);
}
