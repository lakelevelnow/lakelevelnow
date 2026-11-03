// POST /waitlist validation, duplicate, rate limit and CORS; no wl_* KV beacon; GA4 guard.
// Run: node worker/test/waitlist.mjs (from the repo root or anywhere).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import worker, { WL_OFFERS } from '../src/index.js';

const BASE = 'https://lake-level-almanac.example';
const SITE = 'https://lakelevelnow.com';
const sha = (s) => createHash('sha256').update(s).digest('hex');
let passed = 0;
const ok = (name) => { passed++; console.log('ok   ', name); };

function makeEnv() {
  const store = new Map();
  const puts = [];
  return {
    store, puts,
    ALLOWED_ORIGINS: 'https://lakelevelnow.com,http://localhost:4321,http://localhost:4322',
    ALMANAC_ORDERS: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v, opts) => { puts.push([k, v, opts]); store.set(k, v); }
    }
  };
}

function post(body, { origin = SITE, ip = '203.0.113.1', type = 'application/json', method = 'POST', country = 'US' } = {}) {
  const headers = { 'content-type': type, 'cf-connecting-ip': ip };
  if (origin) headers.Origin = origin;
  const init = { method, headers };
  if (method === 'POST') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const req = new Request(BASE + '/waitlist', init);
  Object.defineProperty(req, 'cf', { value: { country } });
  return req;
}

const good = (over = {}) => ({ email: 'Angler@Example.com', offer_id: 'alerts', ab_variant: 'alerts',
  lake_slug: 'lake-mead', placement: 'chart-waitlist', hp: '', ...over });

// ---- offers match the site data file
const site = JSON.parse(readFileSync(new URL('../../src/data/waitlist.json', import.meta.url)));
assert.deepEqual(site.offers.map((o) => o.id), WL_OFFERS);
for (const s of JSON.stringify(site.offers).match(/"(?:title|body|price)":"[^"]*"/g)) {
  assert.ok(!/[:—]/.test(s.split('":"')[1]), 'no colon or em dash in visitor copy: ' + s);
}
ok('offer ids match src/data/waitlist.json, copy has no colon or em dash');

// ---- accepted signup
{
  const env = makeEnv();
  const r = await worker.fetch(post(good()), env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, dup: false });
  assert.equal(r.headers.get('access-control-allow-origin'), SITE);
  const key = 'wl:alerts:' + sha('angler@example.com');
  const rec = JSON.parse(env.store.get(key));
  assert.equal(rec.email, 'Angler@Example.com');
  assert.equal(rec.offer_id, 'alerts');
  assert.equal(rec.ab_variant, 'alerts');
  assert.equal(rec.lake_slug, 'lake-mead');
  assert.equal(rec.placement, 'chart-waitlist');
  assert.equal(rec.country, 'US');
  assert.ok(!Number.isNaN(Date.parse(rec.ts)));
  const day = new Date().toISOString().slice(0, 10);
  const rl = env.puts.find(([k]) => k === `wlrl:${day}:${sha('203.0.113.1')}`);
  assert.ok(rl && rl[1] === '1' && rl[2].expirationTtl > 0, 'rate key written on accept');
  assert.equal(env.puts.length, 2, 'exactly 2 KV writes per accepted signup');
  ok('valid signup -> 200, one wl:<offer>:<sha256(lower email)> record, one wlrl key');

  // ---- duplicate (case-insensitive), no rewrite
  const before = env.puts.length;
  const d = await worker.fetch(post(good({ email: ' angler@example.COM ' }), { ip: '203.0.113.2' }), env);
  assert.equal(d.status, 200);
  assert.deepEqual(await d.json(), { ok: true, dup: true });
  assert.equal(env.puts.length, before, 'duplicate writes nothing');
  ok('duplicate email -> 200 {ok:true, dup:true}, no KV write');

  // same email, other offer = separate signup
  const o = await worker.fetch(post(good({ offer_id: 'rent', ab_variant: 'rent' }), { ip: '203.0.113.3' }), env);
  assert.deepEqual(await o.json(), { ok: true, dup: false });
  ok('same email on another offer is its own key');
}

// ---- validation
{
  const env = makeEnv();
  const cases = [
    ['bad email', good({ email: 'not-an-email' }), 400, 'bad_email'],
    ['email with space', good({ email: 'a b@example.com' }), 400, 'bad_email'],
    ['email > 254', good({ email: 'a'.repeat(60) + '@' + 'b'.repeat(60) + '.' + 'c'.repeat(60) + '.' + 'd'.repeat(60) + '.' + 'e'.repeat(10) + '.com' }), 400, 'bad_email'],
    ['missing email', good({ email: undefined }), 400, 'bad_email'],
    ['offer not allowed', good({ offer_id: 'lifetime' }), 400, 'bad_offer'],
    ['variant not allowed', good({ ab_variant: 'x' }), 400, 'bad_variant'],
    ['slug uppercase', good({ lake_slug: 'Lake-Mead' }), 400, 'bad_lake'],
    ['slug too long', good({ lake_slug: 'a'.repeat(41) }), 400, 'bad_lake'],
    ['slug path', good({ lake_slug: '../x' }), 400, 'bad_lake'],
    ['honeypot filled', good({ hp: 'Acme' }), 400, 'bad_request'],
    ['placement free text', good({ placement: 'Hello World' }), 400, 'bad_placement'],
    ['array body', [], 400, 'bad_json'],
    ['broken json', '{"email":', 400, 'bad_json']
  ];
  for (const [name, body, status, error] of cases) {
    const r = await worker.fetch(post(body, { ip: '198.51.100.' + passed }), env);
    assert.equal(r.status, status, name);
    assert.equal((await r.json()).error, error, name);
  }
  const big = await worker.fetch(post(good({ email: 'x@example.com', pad: 'p'.repeat(3000) }), { ip: '198.51.100.90' }), env);
  assert.equal(big.status, 413);
  const txt = await worker.fetch(post(good(), { type: 'text/plain', ip: '198.51.100.91' }), env);
  assert.equal(txt.status, 415);
  const get = await worker.fetch(post(null, { method: 'GET', ip: '198.51.100.92' }), env);
  assert.equal(get.status, 405);
  assert.equal(env.puts.length, 0, 'rejected requests write nothing');
  ok(`validation: ${cases.length} bad payloads -> 400, oversize 413, text/plain 415, GET 405, 0 writes`);
}

// ---- origin and CORS
{
  const env = makeEnv();
  for (const origin of ['https://evil.example', 'http://localhost:4322', 'https://www.lakelevelnow.com', null]) {
    const r = await worker.fetch(post(good(), { origin, ip: '192.0.2.10' }), env);
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.headers.get('access-control-allow-origin'), null, String(origin));
  }
  assert.equal(env.puts.length, 0);
  const dev = await worker.fetch(post(good({ email: 'dev@example.com' }), { origin: 'http://localhost:4321', ip: '192.0.2.11' }), env);
  assert.equal(dev.status, 200);
  assert.equal(dev.headers.get('access-control-allow-origin'), 'http://localhost:4321');
  const pre = await worker.fetch(new Request(BASE + '/waitlist', { method: 'OPTIONS', headers: {
    Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
  const evilPre = await worker.fetch(new Request(BASE + '/waitlist', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(evilPre.status, 403);
  assert.equal(evilPre.headers.get('access-control-allow-origin'), null);
  ok('CORS: lakelevelnow.com + localhost:4321 allowed (POST + preflight), 4 other origins 403 without ACAO');
}

// ---- rate limit: 5 per IP per day
{
  const env = makeEnv();
  for (let i = 0; i < 5; i++) {
    const r = await worker.fetch(post(good({ email: `u${i}@example.com` }), { ip: '192.0.2.50' }), env);
    assert.equal(r.status, 200, 'signup ' + i);
  }
  const sixth = await worker.fetch(post(good({ email: 'u6@example.com' }), { ip: '192.0.2.50' }), env);
  assert.equal(sixth.status, 429);
  assert.equal((await sixth.json()).error, 'rate_limited');
  const other = await worker.fetch(post(good({ email: 'u6@example.com' }), { ip: '192.0.2.51' }), env);
  assert.equal(other.status, 200);
  // A fresh isolate (empty Map) still sees the KV counter written by another isolate.
  const day = new Date().toISOString().slice(0, 10);
  const env2 = makeEnv();
  env2.store.set(`wlrl:${day}:${sha('192.0.2.77')}`, '5');
  const cold = await worker.fetch(post(good({ email: 'cold@example.com' }), { ip: '192.0.2.77' }), env2);
  assert.equal(cold.status, 429);
  ok('rate limit: 5 accepted, 6th 429, other IP fine, KV counter honoured across isolates');
}

// ---- /hit: waitlist events are not beacon events (GA4 only), so they never write KV
{
  const env = makeEnv();
  for (const ev of ['wl_view', 'wl_click', 'wl_lead']) {
    const r = await worker.fetch(new Request(BASE + `/hit?e=${ev}&l=lake-mead&p=chart-waitlist&v=ramps`,
      { headers: { Origin: SITE } }), env);
    assert.equal(r.status, 204);
  }
  assert.equal(env.puts.length, 0);
  ok('/hit wl_view|wl_click|wl_lead -> 204 with 0 KV writes');
}

// ---- existing routes still answer
{
  const env = makeEnv();
  const r = await worker.fetch(new Request(BASE + '/hit?e=nope', { headers: { Origin: SITE } }), env);
  assert.equal(r.status, 204);
  const m = await worker.fetch(new Request(BASE + '/verify', { method: 'POST', headers: { Origin: SITE } }), env);
  assert.equal(m.status, 405);
  ok('other routes unchanged: unknown hit 204, POST /verify 405');
}

// ---- GA4 guard in public/ga4.js
{
  const listeners = {};
  const loc = { pathname: '/lake/lake-mead/', origin: SITE, search: '', href: SITE + '/lake/lake-mead/' };
  const document = { currentScript: { getAttribute: (k) => (k === 'data-site' ? 'lakelevelnow' : 'G-LYY6FMNH6R') },
    referrer: '', readyState: 'loading', head: { appendChild() {} }, createElement: () => ({ }),
    dispatchEvent() {}, addEventListener: (n, fn) => { (listeners[n] ??= []).push(fn); } };
  const src = readFileSync(new URL('../../public/ga4.js', import.meta.url), 'utf8');
  const run = (navigator) => {
    const window = {};
    vm.runInNewContext(src, { document, window, navigator, location: loc, URL, URLSearchParams,
      Event: class {}, Set, localStorage: { getItem: () => null, setItem() {} } });
    return window;
  };
  const w = run({});
  const p = { offer_id: 'alerts', ab_variant: 'alerts', lake_slug: 'lake-mead', placement: 'lake-waitlist',
    email: 'a@example.com', value: 3 };
  assert.equal(w.__siteGA4Event('view_promotion', p), true);
  assert.equal(w.__siteGA4Event('view_promotion', p), true);
  assert.equal(w.__siteGA4Event('select_promotion', p), true);
  assert.equal(w.__siteGA4Event('generate_lead', p), true);
  assert.equal(w.__siteGA4Event('purchase', p), false);
  assert.equal(w.__siteGA4Event('generate_lead', { offer_id: 'Bad Offer!' }), false);
  const evs = w.dataLayer.map((a) => Array.from(a)).filter((a) => a[0] === 'event');
  const promo = evs.filter((a) => /promotion|lead/.test(a[1]));
  assert.equal(promo.map((a) => a[1]).join(','), 'view_promotion,select_promotion,generate_lead');
  for (const [, , params] of promo) {
    assert.equal(params.email, undefined);
    assert.equal(params.value, undefined);
    assert.equal(params.offer_id, 'alerts');
    assert.equal(params.placement, 'lake-waitlist');
  }
  assert.equal(run({ globalPrivacyControl: true }).__siteGA4Event, undefined);
  ok('GA4 __siteGA4Event: 3 names only, 4 token params only, view_promotion once, absent under GPC');
}

console.log(`PASS: waitlist ${passed} groups`);
