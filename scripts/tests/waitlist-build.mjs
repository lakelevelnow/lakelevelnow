// Checks the built site (dist/) for the waitlist fake-door test (a5-build 2026-11-03).
// Run after `npm run build`: node scripts/tests/waitlist-build.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const data = JSON.parse(fs.readFileSync('src/data/waitlist.json', 'utf8'));
const ids = data.offers.map((o) => o.id);
const lakeDir = 'dist/lake';
const slugs = fs.readdirSync(lakeDir).filter((s) => fs.existsSync(path.join(lakeDir, s, 'index.html')));
assert.ok(slugs.length >= 40, `expected 40+ lake pages, got ${slugs.length}`);
const count = (html, needle) => html.split(needle).length - 1;
let withMid = 0;
for (const slug of slugs) {
  const html = fs.readFileSync(path.join(lakeDir, slug, 'index.html'), 'utf8');
  assert.equal(count(html, 'id="wl-test"'), 1, `${slug}: component must appear exactly once`);
  assert.equal(count(html, 'class="wl-card"'), ids.length, `${slug}: ${ids.length} cards`);
  for (const id of ids) assert.equal(count(html, `data-wl="${id}"`), 1, `${slug}: card ${id}`);
  assert.ok(!html.includes('{Lake}'), `${slug}: unfilled {Lake}`);
  assert.equal(count(html, "'lln_wl_v'"), 1, `${slug}: one picker script`);
  const wl = html.indexOf('id="wl-test"');
  const gauge = html.indexOf('class="gauge-card"');
  if (gauge > 0) assert.ok(wl > gauge, `${slug}: waitlist must sit below the gauge`);
  const top = html.indexOf('data-ad-pos="top"');
  if (top > 0) assert.ok(wl > top, `${slug}: waitlist below the top ad`);
  const mid = html.indexOf('data-ad-pos="mid"');
  if (mid > 0) { withMid++; assert.ok(wl < mid, `${slug}: waitlist must sit above the mid ad slot`); }
  assert.ok(html.includes('href="/privacy/#waitlist"'), `${slug}: privacy link`);
  assert.ok(html.includes('data-wl-place="lake-waitlist"'), `${slug}: placement lake-waitlist`);
}
// Every lake sub-page (/lake/<slug>/<page>/) carries it once, with its page-type placement.
const PLACE = { chart: 'chart-waitlist', depth: 'depth-waitlist', 'boat-ramps': 'ramps-waitlist' };
const subs = [];
for (const slug of slugs) {
  for (const page of fs.readdirSync(path.join(lakeDir, slug))) {
    const f = path.join(lakeDir, slug, page, 'index.html');
    if (!fs.existsSync(f)) continue;
    const html = fs.readFileSync(f, 'utf8');
    const want = PLACE[page];
    assert.ok(want, `${slug}/${page}: unknown sub-page type, add it to PLACE`);
    assert.equal(count(html, 'id="wl-test"'), 1, `${slug}/${page}: exactly once`);
    assert.ok(html.includes(`data-wl-place="${want}"`), `${slug}/${page}: placement ${want}`);
    assert.ok(html.includes(`data-wl-lake="${slug}"`), `${slug}/${page}: lake slug`);
    const wl = html.indexOf('id="wl-test"');
    const top = html.indexOf('data-ad-pos="top"');
    if (top > 0) assert.ok(wl > top, `${slug}/${page}: below the top ad`);
    const mid = html.indexOf('data-ad-pos="mid"');
    if (mid > 0) assert.ok(wl < mid, `${slug}/${page}: above the mid ad`);
    const fig = html.indexOf('</figure>');
    if (page === 'chart' && fig > 0) assert.ok(wl > fig, `${slug}/${page}: below the chart`);
    subs.push(`${slug}/${page}`);
  }
}
assert.ok(subs.length >= 6, `expected 6+ sub-pages, got ${subs.length}`);
assert.ok(!fs.readFileSync('dist/index.html', 'utf8').includes('id="wl-test"'), 'home: no waitlist');
const privacy = fs.readFileSync('dist/privacy/index.html', 'utf8');
assert.ok(privacy.includes('id="waitlist"') && privacy.includes('Cloudflare KV'), 'privacy paragraph');
for (const v of [data.kicker, data.button, data.privacy, data.success, data.error, data.invalid, data.limit,
  ...data.offers.flatMap((o) => [o.title, o.body, o.price])]) {
  assert.ok(!/[:—]/.test(v), `no colon or em dash: ${v}`);
}
const all = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = path.join(d, e.name);
  if (e.isDirectory()) walk(f); else if (e.name.endsWith('.html') && fs.readFileSync(f, 'utf8').includes('id="wl-test"')) all.push(f);
} })('dist');
assert.equal(all.length, slugs.length + subs.length, 'no page outside /lake/ carries the card');
console.log(`PASS: waitlist on ${slugs.length} lake pages (lake-waitlist, ${withMid} with a mid ad, all above it, all below the gauge) + ${subs.length} sub-pages (${subs.join(', ')}); ${all.length} built HTML files in total; privacy paragraph present`);
