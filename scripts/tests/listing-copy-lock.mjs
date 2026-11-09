// Locks the listing and checkout-name copy (2026-11-09). Run after `npm run build`:
// node scripts/tests/listing-copy-lock.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { listingsFor } from '../../src/lib/directory.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');
const NAME = 'Checkout is handled by Stripe. The checkout page shows the name BeLikeNative and your statement shows AUTOM8 LLC. Both belong to the small company behind this site.';
assert.ok(read('src/consts.ts').includes(NAME), 'CHECKOUT_NAME in consts.ts');
const count = (s, sub) => s.split(sub).length - 1;
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

// /advertise/ short H1 with both lakes, title, checkout name twice, source window, website or phone.
const adv = read('dist/advertise/index.html');
assert.ok(/<h1[^>]*>Your business under the Lake Mead and Lake Powell level<\/h1>/.test(adv), '/advertise/ H1');
const title = decode((/<title>([^<]*)<\/title>/.exec(adv) || [])[1] || '');
assert.ok(title.includes('lake business') && title.length <= 60, `/advertise/ title ${title}`);
assert.equal(count(adv, NAME), 2, '/advertise/ checkout name in both buy boxes');
assert.ok(adv.includes('(Search Console, 30 days to November 7)') && !adv.includes('same 30 days'), 'Search Console window');
assert.ok(adv.includes('Want both? Email me the other one and you get both.'), 'one website or phone field');
assert.ok(/class="adv-ask[^"]*"/.test(adv), '"Questions first?" link has a tall tap area');

// One wording everywhere the checkout name shows. Old wording gone.
const pages = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : f.endsWith('.html') && pages.push(p); } };
walk('dist');
let named = 0;
for (const p of pages) {
  const html = read(p);
  assert.ok(!html.includes('parent company, BeLikeNative'), `${p} old checkout wording`);
  assert.ok(!/Warsaw/.test(html), `${p} names a city with no source`);
  if (/The checkout page shows|Checkout runs on Stripe|Checkout is handled by Stripe/.test(html)) {
    assert.ok(html.includes(NAME), `${p} uses a different checkout wording`);
    named++;
  }
}
assert.ok(named >= 4, `checkout name on ${named} pages`);
assert.ok(read('dist/advertise/thanks/index.html').includes(NAME), '/advertise/thanks/ checkout name');

// No internal ids in public data.
const dir = read('src/data/directory.json');
assert.ok(!/555976683|pull_numbers|lanes\//.test(dir), 'directory.json internal ids');

// Phone menu 16 px. Listing lines wrap. Rotation reorders cards.
assert.ok(/\.nav-m nav a \{[^}]*font-size: 16px/.test(read('src/styles/global.css')), 'phone menu links 16 px');
const comp = read('src/components/LocalDirectory.astro');
assert.ok(comp.includes('.ldir-name, .ldir-line { overflow-wrap: anywhere; }'), 'long listing lines wrap');
assert.ok(comp.includes('box[b].insertBefore(cards[idx[k]], foot)'), 'rotation also shuffles position');

// With no listings, the invite sits after the Almanac block, and no listing section renders.
const data = JSON.parse(dir);
if ((data.listings || []).length === 0) {
  for (const [p, alm] of [['dist/lake/lake-mead/index.html', 'class="mead-alm'], ['dist/lake/lake-powell/index.html', 'class="alm-'], ['dist/lake/lake-mead/chart/index.html', 'class="mead-alm']]) {
    const html = read(p);
    const inv = html.indexOf('class="ldir-empty');
    assert.equal(count(html, 'class="ldir-empty'), 1, `${p} one invite`);
    assert.ok(!html.includes('<section class="ldir'), `${p} no empty listing section`);
    const a = html.indexOf(alm);
    assert.ok(a > 0 && inv > a, `${p} invite after the Almanac block`);
  }
}

// A broken listing throws in strict mode (tests) and is skipped at build time.
const bad = { listings: [{ id: 'x', name: 'A', line: 'y'.repeat(95), lakes: ['lake-mead'], website: 'https://a.example', start: '2026-01-01', end: '2027-01-01' }] };
assert.throws(() => listingsFor(bad, 'lake-mead', '2026-06-01'));
const err = console.error; let logged = 0; console.error = () => { logged++; };
try { assert.deepEqual(listingsFor(bad, 'lake-mead', '2026-06-01', false), []); } finally { console.error = err; }
assert.equal(logged, 1, 'build mode logs the broken listing');

console.log(`PASS: /advertise/ H1, title and copy; one checkout wording on ${named} pages; invite after the Almanac; broken listing skipped at build.`);
