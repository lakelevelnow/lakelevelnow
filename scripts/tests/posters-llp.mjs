// Checks the poster offer (sku llp, mobile money run 2026-11-08).
// Part 1 runs public/ga4.js in a VM: mm_cta_view / mm_cta_click are sent with sku and placement,
// junk is refused, DNT turns everything off, the llp Stripe link counts as a product.
// Part 2 runs the /posters/thanks/ script with stub DOM: the cs_test_demo branch works on
// localhost with no network and does not exist on lakelevelnow.com; the API reason is shown.
// Part 3 (after `npm run build`) checks the built pages.
// Run: node scripts/tests/posters-llp.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';

// ---------- part 1: ga4.js
function loadGa4({ dnt = false, path = '/lake/lake-mead/chart/' } = {}) {
  const listeners = {};
  const store = {};
  const loc = { pathname: path, origin: 'https://lakelevelnow.com', search: '', href: 'https://lakelevelnow.com' + path };
  const document = {
    currentScript: { getAttribute: (k) => (k === 'data-site' ? 'lakelevelnow' : 'G-LYY6FMNH6R') },
    referrer: '', readyState: 'complete', head: { appendChild() {} }, createElement: () => ({}),
    dispatchEvent() {}, addEventListener: (n, fn) => { (listeners[n] ??= []).push(fn); }, body: {},
  };
  const window = {};
  vm.runInNewContext(fs.readFileSync('public/ga4.js', 'utf8'), {
    document, window, navigator: dnt ? { doNotTrack: '1' } : {}, location: loc, URL, URLSearchParams, Event: class {}, Set,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
  });
  const events = () => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event');
  return { window, events, listeners, store };
}

{
  const { window, events, store } = loadGa4();
  assert.equal(typeof window.__siteGA4Event, 'function');
  assert.equal(window.__siteGA4Event('mm_cta_view', { sku: 'llp', placement: 'mead-chart' }), true);
  assert.equal(window.__siteGA4Event('mm_cta_view', { sku: 'llp', placement: 'mead-chart' }), true); // deduped
  const views = events().filter((e) => e[1] === 'mm_cta_view');
  assert.equal(views.length, 1, 'one mm_cta_view per placement');
  assert.equal(views[0][2].sku, 'llp');
  assert.equal(views[0][2].placement, 'mead-chart');
  assert.equal(window.__siteGA4Event('mm_cta_view', { sku: 'LLP; drop', placement: 'x' }), false, 'bad sku refused');
  assert.equal(window.__siteGA4Event('mm_cta_view', { placement: 'x' }), false, 'sku required');
  assert.equal(window.__siteGA4Event('mm_other', { sku: 'llp' }), false, 'name allowlist');
  // Click to Stripe (no anchor) is sent right away.
  window.__siteGA4Event('mm_cta_click', { sku: 'llp', placement: 'posters-hero' });
  assert.ok(events().some((e) => e[1] === 'mm_cta_click' && e[2].placement === 'posters-hero'));
  // Click to a same-site page is handed over through sessionStorage.
  window.__siteGA4Event('mm_cta_click', { sku: 'llp', placement: 'mead-chart' }, { href: 'https://lakelevelnow.com/posters/', target: '' });
  const held = JSON.parse(store.lln_ga4_next_v1 || '[]');
  assert.ok(held.some((h) => h.n === 'mm_cta_click' && h.p.sku === 'llp' && h.p.placement === 'mead-chart'), 'hand-over stored');
  // The old waitlist events still work.
  assert.equal(window.__siteGA4Event('view_promotion', { offer_id: 'alerts', placement: 'lake-waitlist' }), true);
}
{
  const { window } = loadGa4({ dnt: true });
  assert.equal(window.__siteGA4Event, undefined, 'DNT: no wrapper, nothing sent');
}
{
  // The /posters/ landing replays a handed-over click, and the llp link is a known product.
  const src = fs.readFileSync('public/ga4.js', 'utf8');
  assert.ok(src.includes("'eVqeVe6Eq4Jy5NP2st43S0L': { item_id: 'llp'"), 'llp product in ga4.js');
}
console.log('PASS: ga4.js mm events');

// ---------- part 2: thanks page script
const thanksSrc = fs.readFileSync('src/pages/posters/thanks.astro', 'utf8');
const script = /<script is:inline>([\s\S]*?)<\/script>/.exec(thanksSrc)[1];
function runThanks(hostname, hash, fetchReply) {
  const els = {};
  const el = (id) => (els[id] ??= { id, textContent: '', hidden: id !== 'pt-form', value: '', href: '', attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, scrollIntoView() {} });
  const document = { getElementById: el, createElement: (t) => ({ tag: t, textContent: '', attrs: {}, children: [], className: '',
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; } }) };
  const calls = [];
  const fetch = (url) => { calls.push(url); return Promise.resolve({ status: fetchReply.status || 200, json: () => Promise.resolve(fetchReply.body) }); };
  vm.runInNewContext(script, { document, location: { hostname, hash }, fetch, window: {}, setTimeout, clearTimeout, encodeURIComponent, Array, Number, AbortController });
  return { els, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
{
  const { els, calls } = runThanks('localhost', '#s=cs_test_demo', { body: {} });
  assert.equal(calls.length, 0, 'demo branch makes no network call');
  assert.equal(els['pt-ok'].hidden, false);
  assert.equal(els['pt-h'].textContent, 'Your posters are ready');
}
{
  const { calls } = runThanks('lakelevelnow.com', '#s=cs_test_demo', { body: { ok: false, reason: 'No such session.' } });
  assert.equal(calls.length, 1, 'no demo branch on the live host');
  assert.ok(calls[0].startsWith('https://ingredientcalculator.com/api/unlock?p=llp&s=cs_test_demo'));
}
{
  const { els } = runThanks('lakelevelnow.com', '#s=cs_live_abc123', { status: 402, body: { ok: false, reason: 'This payment has not been completed.' } });
  await tick();
  assert.equal(els['pt-err'].hidden, false);
  assert.equal(els['pt-reason'].textContent, 'This payment has not been completed.');
}
{
  const files = [
    { name: 'lake-level-posters-all.zip', url: '/posters/d/x/lake-level-posters-all.zip', bytes: 4200000 },
    { name: 'lake-mead-light-18x24.pdf', url: '/posters/d/x/lake-mead-light-18x24.pdf', bytes: 210000 },
    { name: 'evil.pdf', url: 'javascript:alert(1)', bytes: 1 },
  ];
  const { els } = runThanks('lakelevelnow.com', '#s=cs_live_abc123', { body: { ok: true, p: 'llp', email: 'a@b.co', files } });
  await tick();
  assert.equal(els['pt-zip'].hidden, false);
  assert.equal(els['pt-zip'].href, '/posters/d/x/lake-level-posters-all.zip');
  const groups = els['pt-groups'].children;
  assert.equal(groups.length, 1, 'unsafe URL dropped, one group left');
  assert.equal(groups[0].children[0].textContent, 'Lake Mead, light');
}
{
  // F2: JPGs for photo counters get their own group, and groups follow a fixed order
  // (posters, calendar, JPGs, guide) whatever order the API sends.
  const files = [
    { name: 'PRINT-GUIDE.txt', url: '/posters/d/x/PRINT-GUIDE.txt', bytes: 3000 },
    { name: 'lake-mead-dark-11x14.jpg', url: '/posters/d/x/lake-mead-dark-11x14.jpg', bytes: 600000 },
    { name: 'lake-mead-calendar-2027.pdf', url: '/posters/d/x/lake-mead-calendar-2027.pdf', bytes: 165000 },
    { name: 'two-lakes-dark-a3.pdf', url: '/posters/d/x/two-lakes-dark-a3.pdf', bytes: 250000 },
  ];
  const { els } = runThanks('lakelevelnow.com', '#s=cs_live_abc123', { body: { ok: true, p: 'llp', email: 'a@b.co', files } });
  await tick();
  const names = els['pt-groups'].children.map((g) => g.children[0].textContent);
  assert.deepEqual(names, ['Two Lakes, dark', 'Calendar', 'Photo counter JPGs, for Walgreens or CVS', 'Print guide']);
  const jpg = els['pt-groups'].children[2].children[1].children[0].children[0];
  assert.equal(jpg.children[0].textContent, 'Lake Mead dark, 11 x 14 in');
  assert.equal(jpg.children[1].textContent, 'JPG 600 KB');
}
console.log('PASS: thanks page script');

// ---------- part 3: built pages
if (!fs.existsSync('dist/posters/index.html')) {
  console.log('SKIP: dist not built');
  process.exit(0);
}
const read = (p) => fs.readFileSync(p, 'utf8');
const FOLDER = fs.readdirSync('public/posters/d')[0];
for (const [page, place, chartMark] of [
  ['dist/lake/lake-mead/chart/index.html', 'mead-chart', '<figure'],
  ['dist/lake/lake-mead/index.html', 'mead-lake', 'class="chartcard"'],
  ['dist/lake/lake-powell/index.html', 'powell-lake', 'class="chartcard"'],
  ['dist/lake/lake-powell/chart/index.html', 'powell-chart', '<figure'],
]) {
  const h = read(page);
  const main = h.slice(h.indexOf('<main'), h.indexOf('</main>'));
  const cards = main.match(/<aside class="pst"/g) || [];
  assert.equal(cards.length, 1, `${page} one poster card`);
  assert.ok(main.includes(`data-pst-place="${place}"`), `${page} placement`);
  assert.ok(main.indexOf(chartMark) < main.indexOf('<aside class="pst"'), `${page} card after the chart`);
  // F2: one price per page view for the visitor. The only other dollar figure allowed is the owner's
  // labelled advertiser slot on Lake Mead ($25 a month, for marinas), and on Lake Powell the owner's
  // first-screen Almanac line, which is kept and sits two screens above the poster card.
  const text = main.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
  const prices = [...new Set(text.match(/\$\d+/g) || [])].sort();
  const allowed = page.includes('lake-mead') ? ['$25', '$9'] : page === 'dist/lake/lake-powell/index.html' ? ['$19', '$9'] : ['$9'];
  assert.ok(prices.includes('$9') && prices.every((p) => allowed.includes(p)), `${page} prices ${prices}`);
  if (page.includes('lake-mead')) assert.ok(/\$25\/month/.test(text), `${page} $25 is the advertiser slot`);
  for (const paid of ['class="mead-alm"', 'id="wl-test"', 'class="alm-peek"', 'class="alm-ctx-cta"']) {
    assert.ok(!main.includes(paid), `${page} has no second paid card (${paid})`);
  }
  assert.ok(main.includes('within 14 days for a full refund'), `${page} refund line`);
  assert.ok(!h.includes(FOLDER), `${page} does not name the download folder`);
}
// F2: Lake Mead's first screen points to the posters with no price, and the owner's Powell Almanac
// line sits below the poster card with no price.
{
  const h = read('dist/lake/lake-mead/index.html');
  const main = h.slice(h.indexOf('<main'), h.indexOf('</main>'));
  const hero = main.indexOf('data-pst-place="mead-hero"');
  assert.ok(hero > 0 && hero < main.indexOf('class="chartcard"'), 'mead-hero pointer above the gauge');
  const heroP = main.slice(hero, main.indexOf('</p>', hero));
  assert.ok(heroP.includes('href="/posters/"') && !/\$\d/.test(heroP), 'mead-hero links to /posters/ without a price');
  const pl = main.indexOf('data-alm-place="mead-powell-line"');
  assert.ok(pl > main.indexOf('<aside class="pst"'), 'Powell Almanac line below the poster card');
  assert.ok(main.slice(pl, main.indexOf('</p>', pl)).includes('data-cta="mead_hero_powell"'), 'owner cta id kept');
}
// F2: on Lake Powell the owner's first-screen Almanac line is unchanged and the poster card comes
// after the free "normal for the date" answer.
{
  const h = read('dist/lake/lake-powell/index.html');
  const main = h.slice(h.indexOf('<main'), h.indexOf('</main>'));
  assert.ok(main.includes('data-alm-place="lake-hero"') && main.includes('data-cta="lake_hero_almanac"'), 'Powell Almanac first-screen line kept');
  assert.ok(main.indexOf('alm-ctx') > 0 && main.indexOf('alm-ctx') < main.indexOf('<aside class="pst"'), 'Powell card after the free answer');
}
// Other lakes keep their offers.
assert.ok(read('dist/lake/pine-flat-lake/index.html').includes('id="wl-test"'), 'waitlist stays on other lakes');
assert.ok(!read('dist/lake/pine-flat-lake/index.html').includes('class="pst"'), 'no poster card on other lakes');
const landing = read('dist/posters/index.html');
for (const s of ['https://buy.stripe.com/eVqeVe6Eq4Jy5NP2st43S0L', 'Apple Pay or Google Pay', 'AUTOM8 LLC', 'BeLikeNative',
  'Not useful? Email lipmichal@gmail.com within 14 days for a full refund.', 'If someone in your family boats',
  'Staples takes JPG, PNG or PDF files', 'Walgreens does not list 18 x 24', '/posters/img/room-1200.webp', 'Drawn in code, to scale']) {
  assert.ok(landing.includes(s), `/posters/ has ${s}`);
}
assert.ok(!landing.includes(FOLDER), '/posters/ does not name the download folder');
const thanks = read('dist/posters/thanks/index.html');
assert.ok(/<meta name="robots" content="noindex/.test(thanks), 'thanks is noindex');
assert.ok(!thanks.includes(FOLDER), 'thanks does not name the download folder');
for (const f of fs.readdirSync('dist').filter((n) => n.endsWith('.html') || n.endsWith('.xml') || n.endsWith('.txt'))) {
  assert.ok(!read('dist/' + f).includes(FOLDER), `dist/${f} does not name the folder`);
}
const robots = read('dist/robots.txt');
assert.equal((robots.match(/^User-agent:/gm) || []).length, (robots.match(/^Disallow: \/posters\/d\/$/gm) || []).length, 'Disallow in every group');
const sm = fs.readdirSync('dist').filter((f) => /^sitemap-\d+\.xml$/.test(f)).map((f) => read('dist/' + f)).join('');
assert.ok(sm.includes('https://lakelevelnow.com/posters/</loc>'), 'sitemap has /posters/');
assert.ok(!sm.includes('/posters/thanks'), 'sitemap has no thanks page');
assert.ok(!sm.includes('/posters/d/'), 'sitemap has no download folder');
assert.ok(read('dist/_headers').includes('https://ingredientcalculator.com'), 'CSP allows the unlock API');
// Every file in the download folder is built into dist, and the set stays under 40 MB.
const dl = fs.readdirSync('public/posters/d/' + FOLDER);
let bytes = 0;
for (const f of dl) { assert.ok(fs.existsSync(`dist/posters/d/${FOLDER}/${f}`), `download built ${f}`); bytes += fs.statSync(`dist/posters/d/${FOLDER}/${f}`).size; }
assert.equal(dl.length, 39, '24 posters, 12 photo counter JPGs, calendar, print guide, zip');
assert.equal(dl.filter((f) => f.endsWith('.jpg')).length, 12, '12 JPGs');
assert.ok(bytes < 40e6, 'downloads under 40 MB');
console.log('PASS: built pages');
