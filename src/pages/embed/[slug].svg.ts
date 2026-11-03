// Embeddable level badge, one static SVG per lake (sprint2 2026-11-03).
// Built on every Pages build (daily cron), so the figure is as fresh as the lake page.
// Static file on GitHub Pages: no Worker, no KV, no per-request cost.
// The embed snippet on /embed/ wraps it in a plain link to the lake page (the backlink).
import type { APIRoute } from 'astro';
import { LAKES, getReading, fmtNum } from '../../lib/lakes';

export function getStaticPaths() {
  return LAKES.filter((l) => getReading(l.slug)?.level_ft != null).map((l) => ({ params: { slug: l.slug } }));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

function spark(series: { t: string; v: number; storage?: boolean }[], x: number, y: number, w: number, h: number): string {
  const pts = (series || []).filter((p) => !p.storage && Number.isFinite(p.v)).slice(-60);
  if (pts.length < 3) return '';
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(x + (i * w) / (pts.length - 1)).toFixed(1)} ${(y + h - ((p.v - lo) / span) * h).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const lx = x + w, ly = y + h - ((last.v - lo) / span) * h;
  return `<path d="${d}" fill="none" stroke="#0f8a8a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" fill="#0f8a8a" stroke="#ffffff" stroke-width="1.5"/>`;
}

export const GET: APIRoute = ({ params }) => {
  const lake = LAKES.find((l) => l.slug === params.slug)!;
  const r = getReading(lake.slug)!;
  const asOf = r.as_of ? new Date(r.as_of).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  const level = `${fmtNum(r.level_ft, 2)} ft`;
  const pct = r.pct_full != null ? `${r.pct_full}% full` : '';
  const dateLine = r.fresh ? `Reading of ${asOf}` : `Last reading ${asOf}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96" role="img" aria-label="${esc(`${lake.name} water level ${level}${pct ? ', ' + pct : ''}, ${dateLine}`)}">
<title>${esc(`${lake.name} water level today, from LakeLevelNow`)}</title>
<rect x="0.5" y="0.5" width="359" height="95" rx="10" fill="#ffffff" stroke="#d5dcdc"/>
<text x="16" y="25" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="11" font-weight="700" letter-spacing="1.1" fill="#4a5a5c">${esc(lake.name.toUpperCase())}</text>
<text x="16" y="56" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="26" font-weight="700" fill="#0d1b1e">${esc(level)}</text>
${pct ? `<text x="16" y="74" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="12" fill="#4a5a5c">${esc(pct)}</text>` : ''}
${r.series && r.series.length > 2 ? `<text x="344" y="17" text-anchor="end" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="9" fill="#6b7a7c">Recent trend</text>` : ''}
${spark(r.series, 200, 24, 140, 36)}
<text x="16" y="88" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="10" fill="#6b7a7c">${esc(dateLine)}</text>
<text x="344" y="88" text-anchor="end" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="10" font-weight="600" fill="#0f8a8a">lakelevelnow.com</text>
</svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } });
};
