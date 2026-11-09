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
export function validListing(l, today) {
  if (!l || typeof l !== 'object') return false;
  if (!/^[a-z0-9-]{1,40}$/.test(l.id || '')) return false;
  if (typeof l.name !== 'string' || !l.name.trim() || l.name.length > 60) return false;
  if (typeof l.line !== 'string' || !l.line.trim() || l.line.length > 90) return false;
  const web = typeof l.website === 'string' && /^https:\/\/[^\s"'<>]+$/.test(l.website);
  const tel = !!cleanPhone(l.phone);
  if (!web && !tel) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(l.end || '')) return false;
  return l.start <= today && today <= l.end;
}
/** Listings for one lake page, in file order. The page shows at most maxShown of them. */
export function listingsFor(data, slug, today = new Date().toISOString().slice(0, 10)) {
  return (data.listings || [])
    .filter((l) => validListing(l, today) && Array.isArray(l.lakes) && l.lakes.includes(slug))
    .map((l) => ({ id: l.id, name: l.name.trim(), line: l.line.trim(),
      website: /^https:\/\//.test(l.website || '') ? l.website : '',
      phone: cleanPhone(l.phone) }));
}
