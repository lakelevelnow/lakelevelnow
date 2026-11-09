// Local business directory (lane LD, 2026-11-09). Plain JS so the node tests can import it.
// A listing shows only when it is complete, belongs to this lake and has not expired.
export const DIRECTORY_LAKES = ['lake-mead', 'lake-powell'];

export function cleanPhone(p) {
  const d = String(p || '').replace(/[^0-9]/g, '').replace(/^1(?=\d{10}$)/, '');
  return /^\d{10}$/.test(d) ? d : '';
}
export function fmtPhone(d) {
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
/** Why a listing in directory.json is broken, or '' when it is complete. Dates in range are not checked here. */
export function listingProblem(l) {
  if (!l || typeof l !== 'object') return 'not an object';
  if (!/^[a-z0-9-]{1,40}$/.test(l.id || '')) return 'id must be a-z, 0-9 and dashes';
  if (typeof l.name !== 'string' || !l.name.trim() || l.name.length > 60) return 'name missing or over 60 characters';
  if (typeof l.line !== 'string' || !l.line.trim() || l.line.length > 90) return 'line missing or over 90 characters';
  const web = typeof l.website === 'string' && /^https:\/\/[^\s"'<>]+$/.test(l.website);
  if (!web && !cleanPhone(l.phone)) return 'needs an https website or a 10 digit US phone';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(l.end || '')) return 'start and end must be YYYY-MM-DD';
  if (!Array.isArray(l.lakes) || !l.lakes.length || l.lakes.some((k) => !DIRECTORY_LAKES.includes(k))) return 'lakes must be lake-mead and/or lake-powell';
  return '';
}
export function validListing(l, today) {
  return !listingProblem(l) && l.start <= today && today <= l.end;
}
/** Listings for one lake page, in file order. The page shows at most maxShown of them.
 *  A paid listing that is broken throws by default, so the test (directory-lld.mjs) fails loudly.
 *  The site build passes strict = false. It logs the error and skips only that listing, so one typo
 *  never stops the daily level update. Expired or not started yet only hides it. */
export function listingsFor(data, slug, today = new Date().toISOString().slice(0, 10), strict = true) {
  for (const l of data.listings || []) {
    const why = listingProblem(l);
    if (!why) continue;
    const msg = `src/data/directory.json listing ${JSON.stringify(l && l.id)} is broken, ${why}. Fix it, a paid listing must not vanish.`;
    if (strict) throw new Error(msg);
    console.error(msg);
  }
  return (data.listings || [])
    .filter((l) => validListing(l, today) && l.lakes.includes(slug))
    .map((l) => ({ id: l.id, name: l.name.trim(), line: l.line.trim(),
      website: /^https:\/\//.test(l.website || '') ? l.website : '',
      phone: cleanPhone(l.phone) }));
}
