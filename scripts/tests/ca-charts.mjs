// Checks the built California chart pages (/lake/<slug>/chart/ for CDEC lakes).
// Run after `npm run build`: node scripts/tests/ca-charts.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const MIN_YEARS = 15;                                    // same rule as src/lib/cahistory.ts
const hist = JSON.parse(fs.readFileSync('src/data/ca-history.json', 'utf8'));
const lakes = JSON.parse(fs.readFileSync('src/data/lakes.json', 'utf8'));
assert.ok(fs.statSync('src/data/ca-history.json').size < 2 * 1024 * 1024, 'ca-history.json under 2 MB');

const sitemap = fs.readdirSync('dist').filter((f) => /^sitemap-\d+\.xml$/.test(f))
  .map((f) => fs.readFileSync(path.join('dist', f), 'utf8')).join('\n');
assert.ok(sitemap.length > 0, 'sitemap files exist');
const count = (s, needle) => s.split(needle).length - 1;
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

const expected = [];
const skipped = [];
for (const lake of lakes.filter((l) => l.state === 'CA' && l.cdec_id)) {
  const s = hist.stations[lake.slug];
  const n = s ? s.values.filter((v) => typeof v === 'number').length : 0;
  const span = s ? Math.floor(s.values.length / 12) : 0;
  if (!s || n < 2 || span < MIN_YEARS) { skipped.push(`${lake.slug} (${s ? `${span} years` : 'no record'})`); continue; }
  expected.push({ slug: lake.slug, name: lake.name });
}
assert.ok(expected.length >= 1, 'at least one California chart page');

for (const { slug, name } of expected) {
  const f = path.join('dist/lake', slug, 'chart/index.html');
  assert.ok(fs.existsSync(f), `${slug}: chart page built`);
  const html = fs.readFileSync(f, 'utf8');
  assert.equal(count(html, '<h1'), 1, `${slug}: one H1`);
  assert.ok(html.includes(`>${name} water level chart</h1>`), `${slug}: H1 text`);
  const svg = /<svg id="ca-chart"[\s\S]*?<\/svg>/.exec(html);
  assert.ok(svg, `${slug}: SVG chart`);
  const d = /<path d="M[\d.]+,[\d.]+ (L[\d.]+,[\d.]+ ?){100,}/.test(svg[0]);
  assert.ok(d, `${slug}: chart line has 100+ points`);
  const latest = /<p class="readable" data-latest-reading[^>]*>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(latest && /\d{1,3}(,\d{3})* acre-feet for [A-Z][a-z]+ \d{4}/.test(latest[1]), `${slug}: non-empty latest reading`);
  const title = /<title>([^<]*)<\/title>/.exec(html)[1];
  assert.ok(title.length <= 60, `${slug}: title ${title.length} chars`);
  assert.ok(html.includes('href="https://cdec.water.ca.gov/dynamicapp/staMeta?station_id='), `${slug}: CDEC station link`);
  assert.ok(html.includes('data-wl-place="chart-waitlist"'), `${slug}: waitlist placement`);
  for (const pos of ['top', 'mid', 'end']) assert.ok(html.includes(`data-ad-pos="${pos}"`), `${slug}: ad ${pos}`);
  const paras = [...text(html).matchAll(/<p class="(?:readable|qas)"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  for (const p of paras) assert.ok(!/[:—]/.test(p), `${slug}: no colon or em dash in "${p.slice(0, 80)}"`);
  const lakePage = fs.readFileSync(path.join('dist/lake', slug, 'index.html'), 'utf8');
  assert.ok(lakePage.includes(`href="/lake/${slug}/chart/"`), `${slug}: linked from its lake page`);
  assert.ok(sitemap.includes(`<loc>https://lakelevelnow.com/lake/${slug}/chart/</loc>`), `${slug}: in the sitemap`);
}
console.log(`PASS: ${expected.length} California chart pages (${expected.map((e) => e.slug).join(', ')}) built with one H1, the SVG chart, a latest reading, a lake page link and a sitemap entry.${skipped.length ? ` Skipped ${skipped.join(', ')}.` : ''}`);
