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
  const strip = /<div class="status-strip[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>|<div class="status-strip[^"]*"[\s\S]{0,1500}/.exec(html);
  if (!strip) continue;
  live++;
  const h1 = html.indexOf('<h1');
  const s = html.indexOf('class="status-strip');
  assert.ok(h1 > 0 && s > h1 && s - html.indexOf('</h1>', h1) < 120, `${slug}: strip is not right under the H1`);
  // Title, strip and JSON-LD carry the same percent.
  const pctTitle = (/, ([\d.]+)% Full|\): ([\d.]+)% Full|Water Level ([\d.]+)%/.exec(title) || []).slice(1).find(Boolean);
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

// Lane H15 2026-11-09: the $25 Lake Mead slot was replaced at 05ee346 by the $199 listing directory
// (lane LD). Its full checks live in directory-lld.mjs and advertise-fix-h15.mjs. Here only the
// old slot must be gone everywhere and no lake page may show the old prices.
for (const slug of slugs) {
  const html = read(path.join(lakeDir, slug, 'index.html'));
  assert.ok(!html.includes('<aside class="spon-slot"'), `${slug}: old sponsor slot still shown`);
  assert.ok(!html.includes('$49'), `${slug}: old $49 price still shown`);
}

// /advertise/
const adv = read('dist/advertise/index.html');
assert.ok(!adv.includes('$25'), 'old $25 price gone from /advertise/');
const advTitle = decode((/<title>([^<]*)<\/title>/.exec(adv) || [])[1] || '');
assert.ok(advTitle.length <= 60, `/advertise/ title ${advTitle.length}`);
const sitemap = fs.readdirSync('dist').filter((f) => /^sitemap-\d+\.xml$/.test(f)).map((f) => read(path.join('dist', f))).join('');
assert.ok(sitemap.includes('https://lakelevelnow.com/advertise/'), '/advertise/ in the sitemap');
assert.ok(read('dist/index.html').includes('href="/advertise/"'), 'footer links /advertise/');

console.log(`PASS: ${slugs.length} lake titles <= 60 with "water level"; ${live} status strips under the H1 agree with title and JSON-LD; Almanac block below the chart; old sponsor slot gone; /advertise/ title and sitemap.`);
