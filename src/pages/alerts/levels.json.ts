// Level feed for the lln-alerts Worker (sprint-20261115, lane L). One static JSON file, rebuilt by
// the daily Pages build, so alerts use the same reading as the lake page. No Worker or KV on page views.
import type { APIRoute } from 'astro';
import { LAKES, getReading } from '../../lib/lakes';

export const GET: APIRoute = () => {
  const lakes: Record<string, unknown> = {};
  for (const l of LAKES) {
    const r = getReading(l.slug);
    if (!r || r.level_ft == null || !Number.isFinite(r.level_ft)) continue;
    lakes[l.slug] = { name: l.name, state: l.state, level_ft: r.level_ft, as_of: r.as_of, fresh: !!r.fresh,
      delta_24h: r.delta_24h ?? null, pct_full: r.pct_full ?? null };
  }
  return new Response(JSON.stringify({ v: 1, generated: new Date().toISOString(), lakes }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } });
};
