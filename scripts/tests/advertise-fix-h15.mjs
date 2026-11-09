// Lane H15 2026-11-09. Fixes from review V25 for the $199 lake listing (sku lld).
// Part 1 checks src/lib/directory.mjs and the source CSS. Part 2 (after `npm run build`) checks
// the built pages. Every check here failed at 05ee346.
// Run: node scripts/tests/advertise-fix-h15.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as dirlib from '../../src/lib/directory.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');
const fails = [];
const check = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { fails.push(name); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); } };

// ---------- part 1: source
const today = '2026-11-09';
const ok = { id: 'boat-harbor', name: 'Harbor Co', line: 'Boat rentals at the lake.', lakes: ['lake-mead'],
  phone: '(702) 555-0100', website: 'https://harbor.invalid/', start: '2026-11-01', end: '2027-11-01' };

check('P1-4 a paid listing that is broken stops the build, an expired one does not', () => {
  assert.equal(typeof dirlib.listingProblem, 'function', 'listingProblem exported');
  assert.equal(dirlib.listingProblem(ok), '');
  for (const bad of [{ ...ok, line: 'x'.repeat(92) }, { ...ok, start: '2026-11-1' }, { ...ok, phone: '702555010', website: '' },
    { ...ok, lakes: ['lake-travis'] }, { ...ok, lakes: [] }]) {
    assert.notEqual(dirlib.listingProblem(bad), '', JSON.stringify(bad));
    assert.throws(() => dirlib.listingsFor({ listings: [ok, bad] }, 'lake-mead', today), /directory\.json/);
  }
  // Expired or not started yet is normal and only hides the listing.
  assert.deepEqual(dirlib.listingsFor({ listings: [ok, { ...ok, id: 'old', end: '2026-11-08' }, { ...ok, id: 'new', start: '2026-12-01' }] }, 'lake-mead', today).map((l) => l.id), ['boat-harbor']);
  // The real file is clean, so the build passes today.
  const dir = JSON.parse(read('src/data/directory.json'));
  for (const l of dir.listings) assert.equal(dirlib.listingProblem(l), '', `directory.json ${l.id}`);
});

const px = (src, sel) => { const m = new RegExp(`\\${sel} \\{[^}]*font-size: (\\d+)px`).exec(src); return m ? Number(m[1]) : null; };
check('P1-6 refund, statement, source and Sponsor lines are at least 16 px', () => {
  const adv = read('src/pages/advertise/index.astro');
  for (const sel of ['.adv-l', '.adv-src', '.adv-small', '.adv-note', '.adv-demo-l']) assert.ok(px(adv, sel) >= 16, `${sel} is ${px(adv, sel)} px`);
  assert.ok(px(read('src/pages/index.astro'), '.home-pst-small') >= 16, '.home-pst-small');
  assert.ok(px(read('src/components/LocalDirectory.astro'), '.ldir-label') >= 16, '.ldir-label');
});

check('P2-1 the desktop nav gap shrinks between 768 and 899 px so the header stays one row', () => {
  assert.ok(/@media \(min-width: 768px\) and \(max-width: 899px\) \{[^}]*nav\.main \{ gap: 1[0-6]px/.test(read('src/styles/global.css')));
});

check('P2-6 the old owner-apply test no longer asserts the removed $25 slot', () => {
  const t = read('scripts/tests/owner-apply-2026-10-20.mjs');
  assert.ok(!t.includes('$25/month') && !t.includes("'no payment link yet'"));
});

// ---------- part 2: built pages
if (!fs.existsSync('dist/advertise/index.html')) { console.log('SKIP part 2: run npm run build first'); }
else {
  const text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const adv = read('dist/advertise/index.html');
  const advT = text(adv);
  const thanksT = text(read('dist/advertise/thanks/index.html'));
  const a = JSON.parse(read('src/data/directory.json')).audience;
  const n = (x) => x.toLocaleString('en-US');

  check('P1-1 no promise of a lake choice that checkout never asks, thanks page says how to pick one lake', () => {
    assert.ok(!/You pick Lake Mead/.test(advT), '/advertise/ still says You pick');
    assert.ok(advT.includes('It shows on both lakes unless you tell me otherwise'), '/advertise/ default both lakes');
    assert.ok(/Want only Lake Mead or only Lake Powell\? Email me at lipmichal@gmail\.com and say which/.test(thanksT), 'thanks page lake line');
  });

  check('P1-5 the largest number is the views on the pages that show listings, with the per-lake split', () => {
    const first = /<span class="adv-n"[^>]*>([^<]+)<\/span>/.exec(adv)[1];
    assert.equal(first, n(a.pageViewsListingPages), `first tile is ${first}`);
    assert.ok(advT.includes(`Lake Mead ${n(a.pageViewsMeadChart + a.pageViewsMeadLevel)} and Lake Powell ${n(a.pageViewsPowellLevel)}`), 'per-lake split');
    assert.ok(advT.includes(n(a.pageViews)), 'whole-site figure kept in the source line');
    const desc = /<meta name="description" content="([^"]+)"/.exec(adv)[1];
    assert.ok(desc.includes(n(a.pageViewsListingPages)) && !desc.includes(n(a.pageViews)), `description ${desc}`);
  });

  check('P2-4 and P2-5 no unsourced behaviour claim, Call or Website matches the one checkout field', () => {
    assert.ok(!advT.includes('then they look for a boat'), 'unsourced claim');
    assert.ok(advT.includes('a Call button or a Website button (send me both and you get both)'), 'button line');
    assert.ok(!/Call and Website buttons/.test(adv), 'description says both buttons');
  });

  check('P1-2 disclosure and contact describe the listing offer, not the old one-sponsor slot', () => {
    const disc = text(read('dist/disclosure/index.html'));
    const con = read('dist/contact/index.html');
    assert.ok(!/One local business per lake|one local sponsor per lake|"Advertisement"/.test(disc), 'old slot on disclosure');
    assert.ok(disc.includes('Up to 3 local businesses show under the level on the Lake Mead and Lake Powell pages'), 'disclosure new text');
    assert.ok(disc.includes('rel="sponsored nofollow"'), 'disclosure rel');
    assert.ok(!/One local business per lake|sponsor slot/i.test(text(con)), 'old slot on contact');
    assert.ok(/href="mailto:lipmichal@gmail\.com\?subject=Lake%20listing"/.test(con), 'contact listing mailto');
    assert.ok(/listing[^.]*refund|refund[^.]*listing/i.test(text(con)) && /poster/i.test(text(con)), 'contact mentions listing and poster refunds');
  });

  check('P1-3 the privacy policy covers listing buyers', () => {
    const p = read('dist/privacy/index.html');
    assert.ok(p.includes('id="listings"'), 'Business listings section');
    const pt = text(p);
    for (const t of ['business name', 'website or phone', '12 months', 'lipmichal@gmail.com']) assert.ok(pt.includes(t), `privacy lacks ${t}`);
    assert.ok(!pt.includes('We never ask for your name'), 'privacy still says we never ask for a name');
  });

  check('P2-3 the home poster entry gives no Lake Powell year count that clashes with 64 years', () => {
    const h = text(read('dist/index.html'));
    assert.ok(!/63 years of Lake Powell/.test(h), 'home says 63 years');
    assert.ok(h.includes('Lake Mead since 1935 and Lake Powell since 1963'), 'home start years');
  });
}

if (fails.length) { console.log(`FAIL ${fails.length} check(s)`); process.exit(1); }
console.log('PASS: all V25 fixes hold');
