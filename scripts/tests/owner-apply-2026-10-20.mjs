// Checks the built site (dist/) for owner apply #5 (lake template) and #3 (Lake Mead
// sponsor slot + /advertise/). Run after `npm run build`: node scripts/tests/owner-apply-2026-10-20.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const read = (p) => fs.readFileSync(p, 'utf8');
const lakeDir = 'dist/lake';
const slugs = fs.readdirSync(lakeDir).filter((s) => fs.existsSync(path.join(lakeDir, s, 'index.html')));
assert.ok(slugs.length >= 40, `expected 40+ lake pages, got ${slugs.length}`);
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

let live = 0;
for (const slug of slugs) {
  const html = read(path.join(lakeDir, slug, 'index.html'));
  const title = decode((/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '');
  assert.ok(title.length > 0 && title.length <= 60, `${slug}: title length ${title.length}: ${title}`);
  assert.ok(/water level/i.test(title), `${slug}: title lacks "water level"`);
  const strip = /<div class="status-strip"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>|<div class="status-strip"[\s\S]{0,1500}/.exec(html);
  if (!strip) continue;
  live++;
  const h1 = html.indexOf('<h1');
  const s = html.indexOf('class="status-strip"');
  assert.ok(h1 > 0 && s > h1 && s - html.indexOf('</h1>', h1) < 120, `${slug}: strip is not right under the H1`);
  // Title, strip and JSON-LD carry the same percent.
  const pctTitle = (/, ([\d.]+)% Full|Water Level ([\d.]+)%/.exec(title) || []).slice(1).find(Boolean);
  if (pctTitle) {
    assert.ok(strip[0].includes(`>${pctTitle}%<`), `${slug}: strip % differs from title ${pctTitle}`);
    assert.ok(new RegExp(`"value":${pctTitle}[,}]`).test(html), `${slug}: JSON-LD % differs from title ${pctTitle}`);
  }
  // Ramp cell only where a published ramp table exists.
  if (slug !== 'lake-powell') assert.ok(!/ramps open/.test(strip[0]), `${slug}: ramp cell without ramp data`);
  // The $19 Almanac block sits below the gauge and its chart.
  const peek = html.indexOf('class="alm-peek"');
  const hero = html.indexOf('class="lake-hero"');
  const chart = html.indexOf('class="chartcard"');
  if (peek > 0) {
    assert.ok(peek > hero, `${slug}: Almanac block above the gauge`);
    if (chart > 0) assert.ok(peek > chart, `${slug}: Almanac block above the chart`);
  }
}
assert.ok(live >= 5, `expected 5+ live lakes with a strip, got ${live}`);

// Sponsor slot: Lake Mead only, labelled, after the chart, before the first AdSense unit.
for (const slug of slugs) {
  const html = read(path.join(lakeDir, slug, 'index.html'));
  const has = html.includes('<aside class="spon-slot"');
  assert.equal(has, slug === 'lake-mead', `${slug}: sponsor slot presence`);
  assert.ok(!html.includes('$49'), `${slug}: old $49 price still shown`);
}
const mead = read(path.join(lakeDir, 'lake-mead', 'index.html'));
const slot = mead.indexOf('<aside class="spon-slot"');
assert.ok(/<aside class="spon-slot"[^>]*>\s*<p class="spon-label"[^>]*>Advertisement<\/p>/.test(mead), 'label "Advertisement" first in the slot');
assert.ok(mead.includes('Your marina or rental here</span>. Reach people checking Lake Mead before a trip. $25/month.'), 'house ad copy');
assert.ok(/href="\/advertise\/" data-spon="lake-mead"/.test(mead), 'house ad links to /advertise/');
assert.ok(slot > mead.indexOf('class="chartcard"') && mead.indexOf('class="chartcard"') > 0, 'slot below the chart');
const firstAd = mead.indexOf('class="ad-slot"');
assert.ok(firstAd < 0 || firstAd > slot, 'slot above the first AdSense unit');
assert.ok(!mead.includes('class="affil"'), 'Mead drops the generic sponsor invitation');

// /advertise/
const adv = read('dist/advertise/index.html');
assert.ok(adv.includes('href="mailto:support@zovo.one?subject=Lake%20Mead%20sponsor%20slot"'), 'mailto button');
assert.ok(!/href="https:\/\/buy\.stripe\.com/.test(adv), 'no payment link yet');
for (const t of ['590', '42%', '98%', '$25', '$199', 'rel="sponsored"', 'Advertisement', '550', '392']) assert.ok(adv.includes(t), `/advertise/ lacks ${t}`);
const advTitle = decode((/<title>([^<]*)<\/title>/.exec(adv) || [])[1] || '');
assert.ok(advTitle.length <= 60, `/advertise/ title ${advTitle.length}`);
const sitemap = fs.readdirSync('dist').filter((f) => /^sitemap-\d+\.xml$/.test(f)).map((f) => read(path.join('dist', f))).join('');
assert.ok(sitemap.includes('https://lakelevelnow.com/advertise/'), '/advertise/ in the sitemap');
assert.ok(read('dist/index.html').includes('href="/advertise/"'), 'footer links /advertise/');

console.log(`PASS: ${slugs.length} lake titles <= 60 with "water level"; ${live} status strips under the H1 agree with title and JSON-LD; Almanac block below the chart; sponsor slot only on Lake Mead, labelled, below the chart, above AdSense; /advertise/ numbers, mailto and sitemap.`);
