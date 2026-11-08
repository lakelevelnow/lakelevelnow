// Checks the poster offer (sku llp, mobile money run 2026-11-08).
// Part 1 runs public/ga4.js in a VM: mm_cta_view / mm_cta_click are sent with sku and placement,
// junk is refused, DNT turns everything off, the llp Stripe link counts as a product.
// Part 2 runs the /posters/thanks/ script with stub DOM: the cs_test_demo branch works on
// localhost with no network and does not exist on lakelevelnow.com; the API reason is shown;
// only ingredientcalculator.com/posters-files/ URLs become links; a paid live session is sent
// to GA4 as a purchase once.
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
{
  // G2: /posters/thanks may report sku llp as a purchase, nothing else, and nowhere else.
  const sid = 'cs_live_a1B2c3';
  const receipt = { transaction_id: sid, payment_status: 'paid', amount_unit: 'stripe_minor', item_id: 'llp',
    amount_total: 900, amount_tax: 0, amount_shipping: 0, currency: 'usd' };
  {
    const { window, events } = loadGa4({ path: '/posters/thanks/' });
    window.__siteGA4Purchase(receipt, sid);
    window.__siteGA4Purchase(receipt, sid);
    const p = events().filter((e) => e[1] === 'purchase');
    assert.equal(p.length, 1, 'one purchase per session');
    assert.equal(p[0][2].value, 9); assert.equal(p[0][2].currency, 'USD');
    assert.equal(p[0][2].revenue_status, 'verified');
    assert.deepEqual(JSON.parse(JSON.stringify(p[0][2].items)), [{ item_id: 'llp', price: 9, quantity: 1 }]);
  }
  {
    const { window, events } = loadGa4({ path: '/posters/thanks/' });
    window.__siteGA4Purchase({ ...receipt, item_id: 'almanac_single' }, sid);
    window.__siteGA4Purchase(receipt, 'cs_test_demo');
    assert.equal(events().filter((e) => e[1] === 'purchase').length, 0, 'other items and test sessions refused');
  }
  for (const path of ['/almanac/thanks/', '/posters/', '/lake/lake-mead/']) {
    const { window, events } = loadGa4({ path });
    window.__siteGA4Purchase(receipt, sid);
    assert.equal(events().filter((e) => e[1] === 'purchase').length, 0, `llp refused on ${path}`);
  }
  {
    const { window, events } = loadGa4({ path: '/almanac/thanks/' });
    window.__siteGA4Purchase({ ...receipt, item_id: 'almanac_single', amount_total: 1900 }, sid);
    assert.equal(events().filter((e) => e[1] === 'purchase').length, 1, 'Almanac purchase still works');
  }
}
console.log('PASS: ga4.js mm events and llp purchase');

// ---------- part 2: thanks page script
const thanksSrc = fs.readFileSync('src/pages/posters/thanks.astro', 'utf8');
const script = /<script is:inline>([\s\S]*?)<\/script>/.exec(thanksSrc)[1];
function runThanks(hostname, hash, fetchReply, win = {}) {
  const els = {};
  const el = (id) => (els[id] ??= { id, textContent: '', hidden: id !== 'pt-form', value: '', href: '', attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, scrollIntoView() {} });
  const document = { getElementById: el, createElement: (t) => ({ tag: t, textContent: '', attrs: {}, children: [], className: '',
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; } }) };
  const calls = [];
  const fetch = (url) => { calls.push(url); return Promise.resolve({ status: fetchReply.status || 200, json: () => Promise.resolve(fetchReply.body) }); };
  vm.runInNewContext(script, { document, location: { hostname, hash }, fetch, window: win, setTimeout, clearTimeout, encodeURIComponent, Array, Number, AbortController });
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
  assert.equal(els['pt-help'].hidden, false, 'own email line shown when the reason has none');
}
{
  // G2: the API reason already ends with the email line, so the page does not repeat it.
  const reason = 'No completed payment matches this link. If you paid, email lipmichal@gmail.com and I will sort it out.';
  const { els } = runThanks('lakelevelnow.com', '#s=cs_live_abc123', { status: 404, body: { ok: false, reason } });
  await tick();
  assert.equal(els['pt-reason'].textContent, reason);
  assert.equal(els['pt-help'].hidden, true, 'email line said once');
}
{
  // G2: files come from the IngredientCalculator upload. Any other host, path, folder shape,
  // sub-folder, relative path or scheme is dropped. 0123... is a test folder, not the real one.
  const IC = 'https://ingredientcalculator.com/posters-files/0123456789abcdef0123/';
  const files = [
    { name: 'lake-level-posters-all.zip', url: IC + 'lake-level-posters-all.zip', bytes: 4200000 },
    { name: 'lake-mead-light-18x24.pdf', url: IC + 'lake-mead-light-18x24.pdf', bytes: 210000 },
    { name: 'lake-mead-dark-18x24.pdf', url: 'javascript:alert(1)', bytes: 1 },
    { name: 'lake-mead-dark-11x14.pdf', url: 'https://evil.example/posters-files/0123456789abcdef0123/a.pdf', bytes: 1 },
    { name: 'lake-mead-dark-8x10.pdf', url: 'https://ingredientcalculator.com.evil.example/posters-files/0123456789abcdef0123/a.pdf', bytes: 1 },
    { name: 'lake-mead-dark-a3.pdf', url: 'http://ingredientcalculator.com/posters-files/0123456789abcdef0123/a.pdf', bytes: 1 },
    { name: 'lake-powell-dark-a3.pdf', url: 'https://www.ingredientcalculator.com/posters-files/0123456789abcdef0123/a.pdf', bytes: 1 },
    { name: 'lake-powell-dark-8x10.pdf', url: 'https://ingredientcalculator.com/other/0123456789abcdef0123/a.pdf', bytes: 1 },
    { name: 'lake-powell-dark-11x14.pdf', url: IC + 'sub/a.pdf', bytes: 1 },
    { name: 'lake-powell-dark-18x24.pdf', url: IC + '../a.pdf', bytes: 1 },
    { name: 'two-lakes-dark-a3.pdf', url: 'https://ingredientcalculator.com/posters-files/short/a.pdf', bytes: 1 },
    { name: 'two-lakes-dark-8x10.pdf', url: '/posters/img/room-600.webp', bytes: 1 },
  ];
  const ga = [];
  const win = { __siteGA4Purchase: (r, sid) => ga.push([r, sid]) };
  const { els } = runThanks('lakelevelnow.com', '#s=cs_live_abc123', { body: { ok: true, p: 'llp', email: 'a@b.co', files, amount_total: 900, currency: 'usd' } }, win);
  await tick();
  assert.equal(els['pt-zip'].hidden, false);
  assert.equal(els['pt-zip'].href, IC + 'lake-level-posters-all.zip');
  assert.equal(els['pt-zip'].attrs.download, undefined, 'plain cross-origin link');
  const groups = els['pt-groups'].children;
  assert.equal(groups.length, 1, 'unsafe URLs dropped, one group left');
  assert.equal(groups[0].children[0].textContent, 'Lake Mead, light');
  assert.equal(groups[0].children[1].children.length, 1, 'one safe file');
  // GA4 purchase from the unlock reply.
  assert.equal(ga.length, 1, 'purchase sent once');
  assert.equal(ga[0][1], 'cs_live_abc123');
  assert.deepEqual(JSON.parse(JSON.stringify(ga[0][0])), { transaction_id: 'cs_live_abc123', payment_status: 'paid', amount_unit: 'stripe_minor',
    item_id: 'llp', amount_total: 900, amount_tax: 0, amount_shipping: 0, currency: 'usd' });
}
{
  // No purchase for a refused session, for the demo, or for an email restore.
  const ga = [];
  const win = { __siteGA4Purchase: (r, sid) => ga.push([r, sid]) };
  runThanks('lakelevelnow.com', '#s=cs_live_abc123', { status: 402, body: { ok: false, reason: 'Not paid.' } }, win);
  runThanks('localhost', '#s=cs_test_demo', { body: {} }, win);
  await tick();
  assert.equal(ga.length, 0, 'no purchase without a paid live session');
}
{
  // F2: JPGs for photo counters get their own group, and groups follow a fixed order
  // (posters, calendar, JPGs, guide) whatever order the API sends.
  const files = [
    { name: 'PRINT-GUIDE.txt', url: 'https://ingredientcalculator.com/posters-files/0123456789abcdef0123/PRINT-GUIDE.txt', bytes: 3000 },
    { name: 'lake-mead-dark-11x14.jpg', url: 'https://ingredientcalculator.com/posters-files/0123456789abcdef0123/lake-mead-dark-11x14.jpg', bytes: 600000 },
    { name: 'lake-mead-calendar-2027.pdf', url: 'https://ingredientcalculator.com/posters-files/0123456789abcdef0123/lake-mead-calendar-2027.pdf', bytes: 165000 },
    { name: 'two-lakes-dark-a3.pdf', url: 'https://ingredientcalculator.com/posters-files/0123456789abcdef0123/two-lakes-dark-a3.pdf', bytes: 250000 },
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
// The paid files are not in this repo or its build. Any 20-hex folder under posters-files/ would be
// the download folder, so no built text file may name one.
const FOLDER_RE = /posters-files\/[a-f0-9]{20}|posters\/d\/[a-f0-9]{20}/;
assert.ok(!fs.existsSync('dist/posters/d'), 'no download folder in dist');
assert.ok(/^public\/posters\/d\/$/m.test(read('.gitignore')), '.gitignore keeps public/posters/d/ out');
// G2: the owner's Almanac CTAs on these pages are all present (the base cce3d0b set), and the poster
// card comes after the last of them.
const ALMANAC = {
  'dist/lake/lake-mead/index.html': ['mead_hero_powell', 'mead_almanac_powell', 'mead_almanac_all'],
  'dist/lake/lake-mead/chart/index.html': ['mead_chart_almanac_powell', 'mead_chart_almanac_all'],
  'dist/lake/lake-powell/index.html': ['lake_hero_almanac', 'peek_almanac_single', 'lake_almanac_single', 'lake_almanac_bundle'],
  'dist/lake/lake-powell/chart/index.html': ['lake_almanac_single', 'lake_almanac_bundle'],
};
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
  const card = main.indexOf('<aside class="pst"');
  assert.ok(main.includes(`data-pst-place="${place}"`), `${page} placement`);
  assert.ok(main.indexOf(chartMark) < card, `${page} card after the chart`);
  for (const id of ALMANAC[page]) {
    const at = main.indexOf(`data-cta="${id}"`);
    assert.ok(at > 0, `${page} keeps Almanac CTA ${id}`);
    assert.ok(at < card, `${page} poster card after ${id}`);
  }
  assert.ok(!main.includes('id="wl-test"'), `${page} waitlist test stands down next to the poster card`);
  assert.ok(main.slice(card).includes('within 14 days for a full refund'), `${page} refund line in the card`);
  assert.ok(!FOLDER_RE.test(h), `${page} does not name a download folder`);
  // Footer names both paid things on these pages.
  assert.ok(h.includes('data-cta="footer_almanac"') && h.includes('data-cta="footer_posters"'), `${page} footer lists the Almanac and the posters`);
  assert.ok(!h.includes('is the paid tier'), `${page} footer no longer says the Almanac is the only paid thing`);
}
{
  // The Lake Mead first screen is the owner's Powell Almanac line, word for word, and nothing else paid.
  const h = read('dist/lake/lake-mead/index.html');
  const main = h.slice(h.indexOf('<main'), h.indexOf('</main>'));
  const hero = main.indexOf('data-alm-place="mead-hero"');
  assert.ok(hero > 0 && hero < main.indexOf('class="chartcard"'), 'owner hero line above the gauge');
  assert.ok(main.slice(hero, main.indexOf('</p>', hero)).includes('One payment, 60-day refund.'), 'owner hero line unchanged');
  assert.ok(!main.includes('data-pst-place="mead-hero"'), 'no poster pointer in the first screen');
}
// Other lakes keep their offers and the owner's footer line.
const pine = read('dist/lake/pine-flat-lake/index.html');
assert.ok(pine.includes('id="wl-test"'), 'waitlist stays on other lakes');
assert.ok(!pine.includes('class="pst"'), 'no poster card on other lakes');
assert.ok(pine.includes('The Lake Level Almanac is the paid tier') && !pine.includes('footer_posters'), 'other footers unchanged');
const landing = read('dist/posters/index.html');
for (const s of ['https://buy.stripe.com/eVqeVe6Eq4Jy5NP2st43S0L', 'Apple Pay or Google Pay', 'AUTOM8 LLC', 'BeLikeNative',
  'Not useful? Email lipmichal@gmail.com within 14 days for a full refund.', 'If someone in your family boats',
  'Staples takes JPG, PNG or PDF files', 'Walgreens does not list 18 x 24', '/posters/img/room-1200.webp', 'Drawn in code, to scale']) {
  assert.ok(landing.includes(s), `/posters/ has ${s}`);
}
const thanks = read('dist/posters/thanks/index.html');
assert.ok(/<meta name="robots" content="noindex/.test(thanks), 'thanks is noindex');
assert.ok(thanks.includes('https:\\/\\/ingredientcalculator\\.com\\/posters-files\\/[a-f0-9]{20}\\/'), 'thanks accepts the IC files prefix');
let scanned = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = d + '/' + e.name;
  if (e.isDirectory()) walk(f);
  else if (/\.(html|xml|txt|js|json|css|webmanifest)$/.test(e.name) || e.name === '_headers' || e.name === '_redirects') {
    assert.ok(!FOLDER_RE.test(read(f)), `${f} does not name a download folder`); scanned++;
  }
  else assert.ok(!/\.(pdf|zip)$/i.test(e.name) && !(f.startsWith('dist/posters/') && /\.jpe?g$/i.test(e.name)), `${f} is a paid file type`);
} })('dist');
const sm = fs.readdirSync('dist').filter((f) => /^sitemap-\d+\.xml$/.test(f)).map((f) => read('dist/' + f)).join('');
assert.ok(sm.includes('https://lakelevelnow.com/posters/</loc>'), 'sitemap has /posters/');
assert.ok(!sm.includes('/posters/thanks'), 'sitemap has no thanks page');
assert.ok(/connect-src[^;]* https:\/\/ingredientcalculator\.com[ ;]/.test(read('dist/_headers')), 'CSP connect-src allows the unlock API host');
console.log(`PASS: built pages (${scanned} text files scanned for a download folder)`);
