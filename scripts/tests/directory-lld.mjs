// Lane LD 2026-11-09. Checks the poster nav link and home entry (sku llp) and the local business
// directory (sku lld). Part 1 unit-tests src/lib/directory.mjs. Part 2 runs the Header tracker
// with a stub DOM. Part 3 (after `npm run build`) checks the built pages.
// Run: node scripts/tests/directory-lld.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { listingsFor, validListing, cleanPhone, fmtPhone } from '../../src/lib/directory.mjs';

// ---------- part 1: listing rules
const today = '2026-11-09';
const ok = { id: 'boat-harbor', name: 'Example Harbor', line: 'Boat rentals at the lake.', lakes: ['lake-mead'],
  phone: '(702) 555-0100', website: 'https://example.com/', start: '2026-11-01', end: '2027-11-01' };
assert.equal(validListing(ok, today), true);
assert.equal(validListing({ ...ok, website: 'http://example.com/' , phone: '' }, today), false, 'http only and no phone');
assert.equal(validListing({ ...ok, website: '' }, today), true, 'phone only is enough');
assert.equal(validListing({ ...ok, phone: '', website: 'javascript:alert(1)' }, today), false, 'no script links');
assert.equal(validListing({ ...ok, end: '2026-11-08' }, today), false, 'expired');
assert.equal(validListing({ ...ok, start: '2026-11-10' }, today), false, 'not started');
assert.equal(validListing({ ...ok, line: 'x'.repeat(91) }, today), false, 'line too long');
assert.equal(validListing({ ...ok, id: 'Bad Id' }, today), false, 'bad id');
assert.equal(cleanPhone('+1 702-555-0100'), '7025550100');
assert.equal(cleanPhone('555-0100'), '');
assert.equal(fmtPhone('7025550100'), '(702) 555-0100');
const data = { listings: [ok, { ...ok, id: 'p', lakes: ['lake-powell'] }, { ...ok, id: 'old', end: '2026-01-01' }] };
assert.deepEqual(listingsFor(data, 'lake-mead', today).map((l) => l.id), ['boat-harbor']);
assert.deepEqual(listingsFor(data, 'lake-powell', today).map((l) => l.id), ['p']);
assert.deepEqual(listingsFor({ listings: [] }, 'lake-mead', today), []);
// The real file holds no sample or fake business, and its buy link is the live one.
const dir = JSON.parse(fs.readFileSync('src/data/directory.json', 'utf8'));
assert.equal(dir.buyUrl, 'https://buy.stripe.com/4gMfZi3se1xm3FHaYZ43S0M');
assert.equal(dir.priceUsd, 199); assert.equal(dir.months, 12); assert.equal(dir.maxShown, 3);
for (const l of dir.listings) assert.ok(!/example|sample|test|demo/i.test(JSON.stringify(l)), `fake listing ${l.id}`);
// Component source keeps the rules (rendered only when a real listing exists).
const comp = fs.readFileSync('src/components/LocalDirectory.astro', 'utf8');
assert.ok(comp.includes('rel="sponsored nofollow noopener"'), 'website link rel');
assert.ok(/class="ldir-label">Sponsor</.test(comp), 'Sponsor label');
assert.ok(/\.ldir-btn \{[^}]*min-height: 44px/.test(comp), 'buttons at least 44 px');
assert.ok(comp.includes('hidden={i >= max}'), 'at most 3 shown without JS');
console.log('PASS: listing rules (https or phone, dates, 90 chars, no fake listing, live buy link, rel, label, 44 px, max 3)');

// ---------- part 2: Header tracker sends mm_cta_view and mm_cta_click through __siteGA4Event
const hdr = fs.readFileSync('src/components/Header.astro', 'utf8');
const js = hdr.match(/<script is:inline>([\s\S]*?)<\/script>/)[1];
function el(attrs, children = []) {
  const ls = {};
  return { attrs, children, ls, href: attrs.href,
    getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs, setAttribute: (k, v) => { attrs[k] = v; },
    querySelectorAll: () => children, addEventListener: (n, f) => { (ls[n] ??= []).push(f); } };
}
const link = el({ href: '/advertise/', 'data-mm-link': '' });
const box = el({ 'data-mm-sku': 'lld', 'data-mm-place': 'mead-lake-dir' }, [link]);
const nav = el({ href: '/posters/', 'data-mm-sku': 'llp', 'data-mm-place': 'nav-menu', 'data-mm-link': '' });
const bad = el({ 'data-mm-sku': 'llp', 'data-mm-place': 'Bad Place!' });
const sent = []; const observers = [];
const window = { __siteGA4Event: (n, p, a) => sent.push([n, p.sku, p.placement, a ? a.href : null]) };
window.IntersectionObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe(t) { this.t = t; } disconnect() { this.off = true; } };
const document = { readyState: 'complete', querySelectorAll: () => [box, nav, bad], addEventListener() {} };
vm.runInNewContext(js, { window, document, IntersectionObserver: window.IntersectionObserver });
assert.equal(observers.length, 2, 'bad placement token is ignored');
for (const o of observers) { o.cb([{ isIntersecting: true, intersectionRatio: 0.6 }]); if (!o.off) o.cb([{ isIntersecting: true, intersectionRatio: 0.6 }]); }
link.ls.click[0](); nav.ls.click[0]();
assert.deepEqual(sent, [['mm_cta_view', 'lld', 'mead-lake-dir', null], ['mm_cta_view', 'llp', 'nav-menu', null],
  ['mm_cta_click', 'lld', 'mead-lake-dir', '/advertise/'], ['mm_cta_click', 'llp', 'nav-menu', '/posters/']]);
// ga4.js knows the new placements' shape and the lld Stripe link as a product.
const ga4 = fs.readFileSync('public/ga4.js', 'utf8');
assert.ok(ga4.includes("'4gMfZi3se1xm3FHaYZ43S0M': { item_id: 'lld'"), 'lld product in ga4.js');
console.log('PASS: tracker views once per placement, clicks with the anchor, refuses junk tokens; lld product known to ga4.js');

// ---------- part 3: built pages
if (!fs.existsSync('dist/index.html')) { console.log('SKIP part 3: run npm run build first'); process.exit(0); }
const read = (p) => fs.readFileSync(p, 'utf8');
const home = read('dist/index.html');
for (const [place, href] of [['nav-desktop', '/posters/'], ['nav-menu', '/posters/'], ['home-top', '/posters/']]) {
  assert.ok(new RegExp(`href="${href}"[^>]*data-mm-sku="llp" data-mm-place="${place}"`).test(home), `home ${place}`);
}
assert.ok(home.includes('Posters $9'), 'nav label with price');
assert.ok(/class="home-pst-h"[^>]*>Lake Mead and Lake Powell posters, \$9</.test(home), 'home entry with price');
assert.ok(home.includes('Not useful? Email lipmichal@gmail.com within 14 days for a full refund.'), 'home refund line');
// The entry sits in the hero, before the short answer and the first ad unit.
const pst = home.indexOf('class="home-pst"');
assert.ok(pst > home.indexOf('<h1') && pst < home.indexOf('class="hero-offer"') + 3000 && (home.indexOf('class="ad-slot') < 0 || pst < home.indexOf('class="ad-slot')), 'home entry high in the hero');
assert.ok(!/<dialog|class="[^"]*(modal|popup)/i.test(home.slice(pst - 200, pst + 1500)), 'no pop-up');
assert.ok(read('dist/posters/index.html').includes('data-mm-place="nav-menu"'), 'nav on other pages too');

const pages = { 'dist/lake/lake-mead/index.html': 'mead-lake-dir', 'dist/lake/lake-mead/chart/index.html': 'mead-chart-dir', 'dist/lake/lake-powell/index.html': 'powell-lake-dir' };
for (const [f, place] of Object.entries(pages)) {
  const h = read(f);
  const i = h.indexOf(`data-mm-place="${place}"`);
  assert.ok(i > 0, `${f} directory present`);
  const anchor = f.includes('chart') ? h.indexOf('<figure') : h.indexOf('class="gauge-card"');
  assert.ok(anchor > 0 && i > anchor, `${f} directory under the level`);
  if (dir.listings.length === 0) {
    assert.ok(/class="ldir-empty"[\s\S]{0,400}href="\/advertise\/"/.test(h), `${f} honest invite line`);
    assert.ok(!h.includes('class="ldir-card"'), `${f} no fake listing`);
  }
  assert.ok(!h.includes('spon-slot'), `${f} old $25 slot removed`);
}
for (const f of ['dist/lake/lake-powell/chart/index.html', 'dist/lake/lake-travis/index.html']) assert.ok(!read(f).includes('data-ldir='), `${f} has no directory`);

const adv = read('dist/advertise/index.html');
const a = dir.audience;
for (const t of [a.pageViews.toLocaleString('en-US'), `${a.usPct}%`, `${a.phonePct}%`, a.pageViewsListingPages.toLocaleString('en-US'), '$199', '12 months', 'No auto renew', 'AUTOM8 LLC', 'Apple Pay', 'lipmichal@gmail.com within 14 days for a full refund', 'Sponsor'])
  assert.ok(adv.includes(t), `/advertise/ lacks ${t}`);
assert.equal((adv.match(/href="https:\/\/buy\.stripe\.com\/4gMfZi3se1xm3FHaYZ43S0M"/g) || []).length, 2, 'two buy buttons, exact link');
assert.ok(!adv.includes('$25'), 'old $25 price gone');
const thanks = read('dist/advertise/thanks/index.html');
for (const t of ['by hand', 'within 2 business days', 'lipmichal@gmail.com', 'within 14 days for a full refund', 'Nothing renews'])
  assert.ok(thanks.includes(t), `/advertise/thanks/ lacks ${t}`);
assert.ok(/<meta name="robots" content="noindex/.test(thanks), 'thanks noindex');
const sm = fs.readdirSync('dist').filter((f) => f.startsWith('sitemap')).map((f) => read('dist/' + f)).join('');
assert.ok(sm.includes('/advertise/') && !sm.includes('/advertise/thanks'), 'sitemap has /advertise/ and not thanks');
console.log('PASS: built pages (nav and home poster entry with price and refund line, directory under the level on 3 pages with the honest empty line, /advertise/ numbers and exact buy link, thanks page, sitemap)');
