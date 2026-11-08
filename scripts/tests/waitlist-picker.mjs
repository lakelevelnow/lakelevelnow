// Runs the built WaitlistTest inline script against a tiny fake DOM: uniform sticky pick,
// ?wl= override, storage failure, GA4 calls, Telegram popup hold, submit states.
// Run after `npm run build`: node scripts/tests/waitlist-picker.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Lake Havasu: one of the lakes with all five offers (forecast included). Lake Mead shows the
// poster card instead of the waitlist since 2026-11-08.
const html = fs.readFileSync('dist/lake/lake-havasu/index.html', 'utf8');
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("'lln_wl_v'"));
assert.ok(src, 'picker script in built page');
const ids = [...html.matchAll(/class="wl-card" data-wl="([a-z0-9-]+)"/g)].map((m) => m[1]);
assert.equal(ids.length, 5);

function el(attrs = {}) {
  const listeners = {};
  const cls = new Set();
  return { attrs, hidden: false, disabled: false, readOnly: false, value: '', textContent: '', dataset: {},
    classList: { add: (c) => cls.add(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(n, fn) { listeners[n] = fn; }, fire(n, ev) { return listeners[n](ev || { preventDefault() {} }); },
    focus() {} };
}
function page({ search = '', store = {}, storageThrows = false, response = { status: 200, body: { ok: true, dup: false } } } = {}) {
  const cards = ids.map((id) => {
    const c = el({ 'data-wl': id, 'aria-hidden': 'true' });
    c.parts = { '.wl-open': el({ tabindex: '-1' }), '.wl-form': el(), '.wl-email': el(), '.wl-send': el(),
      '.wl-status': el(), 'input[name="hp_wl"]': el(), '.wl-row': el() };
    c.parts['.wl-form'].hidden = true;
    c.parts['.wl-form'].querySelector = (q) => c.parts[q];
    c.querySelector = (q) => c.parts[q];
    return c;
  });
  const root = el({ 'data-wl-lake': 'lake-mead', 'data-wl-place': 'chart-waitlist',
    'data-wl-endpoint': 'https://w.example/waitlist', 'data-t-success': 'OK', 'data-t-error': 'ERR',
    'data-t-invalid': 'BAD', 'data-t-sending': '...', 'data-t-limit': 'LIM' });
  root.querySelectorAll = () => cards;
  root.querySelector = (q) => cards.find((c) => q === `.wl-card[data-wl="${c.attrs['data-wl']}"]`) || null;
  const mk = (obj) => ({ getItem: (k) => { if (storageThrows) throw new Error('x'); return k in obj ? obj[k] : null; },
    setItem: (k, v) => { if (storageThrows) throw new Error('x'); obj[k] = String(v); } });
  const ga = [];
  const posts = [];
  let observed = null;
  const window = { __siteGA4Event: (n, p) => ga.push([n, { ...p }]) };
  const ctx = {
    window, document: { getElementById: () => root, readyState: 'complete', addEventListener() {} },
    location: { search }, URLSearchParams, Math, Uint32Array, crypto: globalThis.crypto, Date, String, parseInt, JSON,
    localStorage: mk(store), sessionStorage: mk({}),
    IntersectionObserver: class { constructor(cb) { this.cb = cb; } observe(t) { observed = this; this.t = t; } disconnect() {} },
    fetch: (url, init) => { posts.push([url, JSON.parse(init.body)]); return Promise.resolve({ status: response.status, json: () => Promise.resolve(response.body) }); }
  };
  window.IntersectionObserver = ctx.IntersectionObserver;
  vm.runInNewContext(src, ctx);
  const shown = cards.filter((c) => c.classList.has('wl-on'));
  return { cards, shown, ga, posts, store, sess: ctx.sessionStorage, io: () => observed };
}

// Uniform pick: 5,000 fresh visitors, each offer within 17% to 23%.
const tally = Object.fromEntries(ids.map((i) => [i, 0]));
for (let i = 0; i < 5000; i++) {
  const p = page();
  assert.equal(p.shown.length, 1);
  tally[p.shown[0].attrs['data-wl']]++;
}
for (const id of ids) assert.ok(tally[id] > 850 && tally[id] < 1150, `${id}: ${tally[id]} of 5000`);
// Sticky: the stored value wins.
const store = {};
const first = page({ store }).shown[0].attrs['data-wl'];
assert.equal(store.lln_wl_v, first);
for (let i = 0; i < 20; i++) assert.equal(page({ store }).shown[0].attrs['data-wl'], first);
// ?wl= forces and does not overwrite the sticky pick.
const forced = ids.find((i) => i !== first);
assert.equal(page({ store, search: '?wl=' + forced }).shown[0].attrs['data-wl'], forced);
assert.equal(store.lln_wl_v, first);
assert.equal(page({ search: '?wl=bogus' }).shown.length, 1);
// Storage failure: still exactly one card.
assert.equal(page({ storageThrows: true }).shown.length, 1);

// Flow: view at 50%, click, submit.
const p = page({ search: '?wl=ramps' });
const card = p.shown[0];
assert.equal(card.attrs['aria-hidden'], undefined);
assert.equal(card.parts['.wl-open'].attrs.tabindex, undefined);
assert.equal(p.cards.filter((c) => 'inert' in c.attrs).length, 4);
p.io().cb([{ isIntersecting: true, intersectionRatio: 0.3 }]);
assert.equal(p.ga.length, 0);
p.io().cb([{ isIntersecting: true, intersectionRatio: 0.6 }]);
p.io().cb([{ isIntersecting: true, intersectionRatio: 0.9 }]);
assert.deepEqual(p.ga.map((g) => g[0]), ['view_promotion']);
assert.deepEqual(p.ga[0][1], { offer_id: 'ramps', ab_variant: 'ramps', lake_slug: 'lake-mead', placement: 'chart-waitlist' });
card.parts['.wl-open'].fire('click');
assert.equal(p.ga[1][0], 'select_promotion');
assert.equal(card.parts['.wl-form'].hidden, false);
assert.equal(card.parts['.wl-open'].attrs['aria-expanded'], 'true');
const last = parseInt(p.store['lln.last'], 10);
assert.ok(Math.abs(Date.now() - 6 * 864e5 - last) < 5000, 'Telegram popup held for 1 day');
assert.equal(p.sess.getItem('lln.seen'), '1');
card.parts['.wl-email'].value = 'nope';
card.parts['.wl-form'].fire('submit');
assert.equal(card.parts['.wl-status'].textContent, 'BAD');
assert.equal(p.posts.length, 0);
card.parts['.wl-email'].value = ' angler@example.com ';
card.parts['.wl-form'].fire('submit');
assert.equal(card.parts['.wl-send'].disabled, true, 'button disabled while sending');
card.parts['.wl-form'].fire('submit');
assert.equal(p.posts.length, 1, 'no double submit');
assert.deepEqual(p.posts[0][1], { email: 'angler@example.com', offer_id: 'ramps', ab_variant: 'ramps',
  lake_slug: 'lake-mead', placement: 'chart-waitlist', hp: '' });
await new Promise((r) => setTimeout(r, 10));
assert.equal(card.parts['.wl-status'].textContent, 'OK');
assert.equal(p.ga.at(-1)[0], 'generate_lead');
// Error and duplicate paths.
for (const [response, text, leads] of [[{ status: 500, body: { ok: false } }, 'ERR', 0], [{ status: 429, body: { ok: false } }, 'LIM', 0],
  [{ status: 200, body: { ok: true, dup: true } }, 'OK', 0]]) {
  const q = page({ search: '?wl=alerts', response });
  const c = q.shown[0];
  c.parts['.wl-open'].fire('click');
  c.parts['.wl-email'].value = 'a@example.com';
  c.parts['.wl-form'].fire('submit');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.parts['.wl-status'].textContent, text);
  assert.equal(q.ga.filter((g) => g[0] === 'generate_lead').length, leads);
  if (text !== 'OK') assert.equal(c.parts['.wl-send'].disabled, false, 're-enabled after error');
}
console.log(`PASS: picker uniform over 5,000 visitors (${ids.map((i) => i + ' ' + tally[i]).join(', ')}), sticky, ?wl= override, storage failure safe, view at 50% once, click, popup hold 1 day, submit states (invalid, sending, success, 500, 429, dup)`);
