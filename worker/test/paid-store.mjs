// Tests for the signed-webhook paid-session store in lake-level-almanac and ml0x-delivery.
// Run: node test/fix.test.mjs  (from lanes/G10/FIX). Uses only fakes. No network.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import almanac from "../src/index.js";
import ml0x, { storedRejectionReason } from "./ml0x-delivery.snapshot.js";
import { verifyStripeSignature, storedSession, trimSession } from "../src/paid-store.js";

const SECRET = "whsec_test_" + "a".repeat(32);
const now = () => Math.floor(Date.now() / 1000);
let passed = 0;
const ok = (name) => { passed++; console.log("ok   " + name); };

// ---------- fakes
class FakeD1 {
  constructor() { this.rows = new Map(); this.reads = 0; this.hideReads = 0; this.fail = false; this.failReads = false; this.deletes = 0; }
  prepare(sql) {
    const db = this;
    return { bind(...a) { return {
      async run() {
        if (db.fail) throw new Error("D1 down");
        if (/^DELETE FROM paid_sessions WHERE received < \?1$/.test(sql)) {
          db.deletes++;
          for (const [k, r] of db.rows) if (r.received < a[0]) db.rows.delete(k);
          return { success: true };
        }
        assert.match(sql, /^INSERT OR IGNORE INTO paid_sessions/);
        if (!db.rows.has(a[0])) db.rows.set(a[0], { session_id: a[0], service: a[1], session_json: a[2], event_id: a[3], received: a[4] });
        return { success: true };
      },
      async first() {
        db.reads++;
        if (db.failReads) throw new Error("D1_ERROR: no such table: paid_sessions");
        if (db.hideReads > 0) { db.hideReads--; return null; }
        const r = db.rows.get(a[0]);
        return r && r.service === a[1] ? { session_json: r.session_json } : null;
      }
    }; } };
  }
}
class FakeKV {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); }
  async get(k, type) { const v = this.m.get(k); if (v === undefined) return null; return type === "arrayBuffer" ? v : v; }
  async put(k, v) { this.m.set(k, v); }
}
let stripeCalls = 0;
let stripeAnswer = { status: 401, body: { error: { type: "invalid_request_error", code: "api_key_expired" } } };
globalThis.fetch = async (url) => {
  assert.match(String(url), /^https:\/\/api\.stripe\.com\//);
  stripeCalls++;
  return new Response(JSON.stringify(stripeAnswer.body), { status: stripeAnswer.status, headers: { "content-type": "application/json" } });
};

function sign(body, secret = SECRET, t = now()) {
  const v1 = crypto.createHmac("sha256", secret).update(t + "." + body).digest("hex");
  return `t=${t},v1=${v1}`;
}
function hook(path, obj, { secret = SECRET, t, type = "checkout.session.completed", raw } = {}) {
  const body = raw ?? JSON.stringify({ id: "evt_" + crypto.randomBytes(6).toString("hex"), type, data: { object: obj } });
  return new Request("https://w.example" + path, { method: "POST", body, headers: { "stripe-signature": sign(body, secret, t), "content-type": "application/json" } });
}
const sid = () => "cs_live_" + crypto.randomBytes(20).toString("hex");

// ---------- almanac env
const ALM_SINGLE = "plink_1U1veWJKCamubEm1PGbmVIAx";
const ALM_BUNDLE = "plink_1U9ZakJKCamubEm1QrZZtgog";
const catalog = { lakes: [{ slug: "lake-mead", name: "Lake Mead", zip: "Lake-Mead.zip", bytes: 1000 }], bundleBytes: 5000 };
function almEnv(over = {}) {
  return {
    PAID: new FakeD1(), STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: "rk_live_dead", SIGNING_KEY: "k".repeat(40),
    ALMANAC_ASSETS: new FakeKV({ "catalog.json": JSON.stringify(catalog) }), ALMANAC_ORDERS: new FakeKV(),
    ALLOWED_ORIGINS: "https://lakelevelnow.com", ALMANAC_MODE: "live",
    LINK_SINGLE_ID: ALM_SINGLE, LINK_BUNDLE_ID: ALM_BUNDLE + ",plink_1U1veYJKCamubEm1TwmO7yDa", ...over
  };
}
const almSession = (id, o = {}) => ({
  id, object: "checkout.session", livemode: true, status: "complete", payment_status: "paid",
  payment_link: ALM_BUNDLE, amount_total: 7900, amount_subtotal: 7900, currency: "usd",
  total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 }, custom_fields: [],
  client_reference_id: null, created: now(), customer_details: { email: "buyer@example.com", name: "B", address: { line1: "x" } }, ...o
});

// ---------- ml0x env
const ML_TRIAGE = "plink_1U2Mw0JKCamubEm1sSSsTzmp";
function mlEnv(over = {}) {
  return {
    PAID: new FakeD1(), STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_KEY: "rk_live_dead", SIGNING_KEY: "s".repeat(40),
    ARCHIVE: new FakeKV({ "product:1.0.0": new Uint8Array([80, 75, 3, 4, 9]).buffer, "pipeline:1.0.0": new Uint8Array([80, 75, 3, 4, 8]).buffer }),
    ORDERS: new FakeKV(), ALLOWED_ORIGINS: "https://ml0x.com", MAX_SESSION_AGE_DAYS: "365", ...over
  };
}
const mlSession = (id, o = {}) => ({
  id, object: "checkout.session", livemode: true, status: "complete", payment_status: "paid",
  payment_link: ML_TRIAGE, amount_total: 9900, amount_subtotal: 9900, currency: "usd", created: now(),
  customer_details: { email: "buyer@example.com" }, ...o
});
const get = (w, env, path) => w.fetch(new Request("https://w.example" + path, { headers: { origin: "https://example.org" } }), env);

// ================= signature
{
  const body = '{"a":1}';
  assert.equal(await verifyStripeSignature(body, sign(body), SECRET), true);
  assert.equal(await verifyStripeSignature(body, sign(body, "whsec_other"), SECRET), false);
  assert.equal(await verifyStripeSignature(body + " ", sign(body), SECRET), false);
  assert.equal(await verifyStripeSignature(body, sign(body, SECRET, now() - 301), SECRET), false);
  assert.equal(await verifyStripeSignature(body, sign(body, SECRET, now() + 301), SECRET), false);
  assert.equal(await verifyStripeSignature(body, "", SECRET), false);
  assert.equal(await verifyStripeSignature(body, sign(body), ""), false);
  const t = now();
  assert.equal(await verifyStripeSignature(body, `t=${t},v1=deadbeef,` + sign(body, SECRET, t).split(",")[1], SECRET), true);
  assert.equal(await verifyStripeSignature(body, `t=${t}`, SECRET), false);
  ok("signature: valid, wrong secret, edited body, stale, future, empty, second v1, no v1");
}

// ================= trim
{
  const tr = trimSession(almSession("cs_live_abcdefgh12", { custom_fields: [{ key: "lake", dropdown: { value: "lake-mead", options: [1, 2] }, label: { custom: "x" } }] }));
  assert.equal(tr.customer_details, undefined);
  assert.deepEqual(tr.custom_fields, [{ key: "lake", dropdown: { value: "lake-mead" }, text: null }]);
  assert.equal(JSON.stringify(tr).includes("line1"), false);
  const tr2 = trimSession(mlSession("cs_live_abcdefgh12", { payment_link: { id: ML_TRIAGE } }), true);
  assert.deepEqual(tr2.customer_details, { email: "buyer@example.com" });
  assert.equal(tr2.payment_link, ML_TRIAGE);
  const tr3 = trimSession(almSession("cs_live_abcdefgh12", { custom_fields: [{ key: "phone_note", text: { value: "secret" } }, { key: "lake", text: { value: "lake-mead" } }] }));
  assert.deepEqual(tr3.custom_fields, [{ key: "lake", dropdown: null, text: { value: "lake-mead" } }]);
  ok("trim: no name or address, email only on request, expanded link object, lake field only");
}

// ================= almanac webhook
{
  const env = almEnv();
  const id = sid();
  let r = await almanac.fetch(hook("/stripe-webhook", almSession(id)), env);
  assert.equal(r.status, 200); assert.equal(await r.text(), "stored");
  assert.equal(env.PAID.rows.get(id).service, "almanac");
  assert.equal(env.PAID.rows.get(id).session_json.includes("buyer@example.com"), false);
  // replay is harmless
  r = await almanac.fetch(hook("/stripe-webhook", almSession(id, { payment_status: "paid", amount_total: 1 })), env);
  assert.equal(r.status, 200); assert.equal(JSON.parse(env.PAID.rows.get(id).session_json).amount_total, 7900);
  // other product, unpaid, other event, unsigned, bad JSON, GET, not configured
  const other = sid();
  r = await almanac.fetch(hook("/stripe-webhook", almSession(other, { payment_link: ML_TRIAGE })), env);
  assert.equal(await r.text(), "ignored"); assert.equal(env.PAID.rows.has(other), false);
  r = await almanac.fetch(hook("/stripe-webhook", almSession(other, { payment_status: "unpaid" })), env);
  assert.equal(await r.text(), "ignored"); assert.equal(env.PAID.rows.has(other), false);
  r = await almanac.fetch(hook("/stripe-webhook", almSession(other), { type: "charge.succeeded" }), env);
  assert.equal(await r.text(), "ignored");
  r = await almanac.fetch(hook("/stripe-webhook", almSession(other, { object: "payment_intent" })), env);
  assert.equal(await r.text(), "ignored");
  r = await almanac.fetch(hook("/stripe-webhook", almSession("cs_live_x")), env);
  assert.equal(await r.text(), "ignored");
  r = await almanac.fetch(hook("/stripe-webhook", almSession(other), { secret: "whsec_forged" }), env);
  assert.equal(r.status, 400); assert.equal(env.PAID.rows.has(other), false);
  r = await almanac.fetch(hook("/stripe-webhook", null, { raw: "{not json" }), env);
  assert.equal(r.status, 400);
  r = await almanac.fetch(new Request("https://w.example/stripe-webhook"), env);
  assert.equal(r.status, 405);
  r = await almanac.fetch(hook("/stripe-webhook", almSession(other)), almEnv({ STRIPE_WEBHOOK_SECRET: "" }));
  assert.equal(r.status, 500);
  const bad = almEnv(); bad.PAID.fail = true;
  r = await almanac.fetch(hook("/stripe-webhook", almSession(other)), bad);
  assert.equal(r.status, 500);
  // async payment that settles later
  const asyncId = sid();
  r = await almanac.fetch(hook("/stripe-webhook", almSession(asyncId, { payment_status: "unpaid" })), env);
  assert.equal(await r.text(), "ignored");
  r = await almanac.fetch(hook("/stripe-webhook", almSession(asyncId), { type: "checkout.session.async_payment_succeeded" }), env);
  assert.equal(await r.text(), "stored");
  // cleanup: rows older than 400 days go when a new row is stored
  env.PAID.rows.set("cs_live_oldrow000000000", { session_id: "cs_live_oldrow000000000", service: "almanac", session_json: "{}", received: now() - 401 * 86400 });
  await almanac.fetch(hook("/stripe-webhook", almSession(sid())), env);
  assert.equal(env.PAID.rows.has("cs_live_oldrow000000000"), false); assert.ok(env.PAID.deletes >= 1);
  assert.equal(env.PAID.rows.has(id), true);
  ok("almanac webhook: stores own paid link only, replay safe, rejects forged/unsigned/bad, 500 on store failure, 400-day cleanup");
}

// ================= almanac verify
{
  const env = almEnv();
  const id = sid();
  await almanac.fetch(hook("/stripe-webhook", almSession(id)), env);
  stripeCalls = 0;
  let r = await get(almanac, env, "/verify?session_id=" + id);
  let j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.sku, "bundle");
  assert.equal(j.payment_receipt.transaction_id, id); assert.equal(j.payment_receipt.amount_total, 7900);
  assert.match(j.url, /\/file\?t=/);
  assert.equal(stripeCalls, 0, "a stored session never calls Stripe");
  // single lake via client reference
  const id2 = sid();
  await almanac.fetch(hook("/stripe-webhook", almSession(id2, { payment_link: ALM_SINGLE, amount_total: 1900, amount_subtotal: 1900, client_reference_id: "lake-mead--0123456789abcdef0123456789abcdef" })), env);
  j = await (await get(almanac, env, "/verify?session_id=" + id2)).json();
  assert.equal(j.ok, true); assert.equal(j.sku, "single"); assert.equal(j.lake, "lake-mead");
  // single lake via dropdown
  const id3 = sid();
  await almanac.fetch(hook("/stripe-webhook", almSession(id3, { payment_link: ALM_SINGLE, custom_fields: [{ key: "lake", dropdown: { value: "lake-mead" } }] })), env);
  j = await (await get(almanac, env, "/verify?session_id=" + id3)).json();
  assert.equal(j.lake, "lake-mead");
  // a row stored by ml0x is invisible to the almanac
  env.PAID.rows.set("cs_live_mlrow0000000000", { session_id: "cs_live_mlrow0000000000", service: "ml0x", session_json: JSON.stringify(almSession("cs_live_mlrow0000000000")) });
  stripeAnswer = { status: 404, body: {} };
  r = await get(almanac, env, "/verify?session_id=cs_live_mlrow0000000000");
  assert.equal(r.status, 502);
  ok("almanac verify: stored bundle, single by reference and by dropdown, no Stripe call, service isolation");
}
{
  // dead key, webhook arrives during the wait
  stripeAnswer = { status: 401, body: {} };
  const env = almEnv();
  const id = sid();
  env.PAID.rows.set(id, { session_id: id, service: "almanac", session_json: JSON.stringify(trimSession(almSession(id))) });
  env.PAID.hideReads = 2;   // the first two reads miss, as if the webhook were late
  const t0 = Date.now();
  const j = await (await get(almanac, env, "/verify?session_id=" + id)).json();
  assert.equal(j.ok, true);
  assert.ok(Date.now() - t0 >= 1400, "waited for the late webhook");
  // no row at all: pending, not a crash
  const t1 = Date.now();
  const r = await get(almanac, env, "/verify?session_id=" + sid());
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { ok: false, error: "confirming" });
  assert.ok(Date.now() - t1 >= 7900 && Date.now() - t1 < 12000, "about 8 seconds of waiting");
  // working key still works and keeps the old gate
  stripeAnswer = { status: 200, body: almSession("cs_live_viaapi000000000", { payment_status: "unpaid" }) };
  const r2 = await get(almanac, almEnv(), "/verify?session_id=cs_live_viaapi000000000");
  assert.equal(r2.status, 402); assert.equal((await r2.json()).status, "unpaid");
  stripeAnswer = { status: 200, body: almSession("cs_live_viaapi000000000") };
  assert.equal((await (await get(almanac, almEnv(), "/verify?session_id=cs_live_viaapi000000000")).json()).ok, true);
  stripeAnswer = { status: 200, body: almSession("cs_live_viaapi000000000", { payment_link: ML_TRIAGE }) };
  assert.equal((await get(almanac, almEnv(), "/verify?session_id=cs_live_viaapi000000000")).status, 403);
  // no key and no store binding: pending (fails closed)
  stripeAnswer = { status: 401, body: {} };
  const r3 = await get(almanac, almEnv({ STRIPE_SECRET_KEY: "", PAID: undefined }), "/verify?session_id=" + sid());
  assert.equal(r3.status, 503);
  // D1 read failure with a working key: the API path still delivers
  const broken = almEnv(); broken.PAID.failReads = true;
  stripeAnswer = { status: 200, body: almSession("cs_live_viaapi000000000") };
  const r4 = await get(almanac, broken, "/verify?session_id=cs_live_viaapi000000000");
  assert.equal(r4.status, 200);
  // D1 read failure and dead key: a JSON 503 with CORS headers, not a crash
  stripeAnswer = { status: 401, body: {} };
  const r5 = await get(almanac, broken, "/verify?session_id=" + sid());
  assert.equal(r5.status, 503); assert.ok(r5.headers.get("access-control-allow-origin"));
  ok("almanac verify: late webhook found, 'confirming' after ~8 s, API path unchanged, D1 read failure, fails closed");
}
{
  const h = await (await get(almanac, almEnv(), "/health")).json();
  assert.equal(h.configured.webhookSecret, true); assert.equal(h.configured.paidStore, true); assert.equal(h.version, "1.3.0");
  ok("almanac health reports webhook secret and store");
}

// ================= ml0x webhook + claim
{
  stripeAnswer = { status: 401, body: {} };
  const env = mlEnv();
  const id = sid();
  let r = await ml0x.fetch(hook("/stripe-webhook", mlSession(id)), env);
  assert.equal(r.status, 200); assert.equal(await r.text(), "stored");
  assert.equal(JSON.parse(env.PAID.rows.get(id).session_json).customer_details.email, "buyer@example.com");
  r = await ml0x.fetch(hook("/stripe-webhook", mlSession(sid(), { payment_link: ALM_BUNDLE })), env);
  assert.equal(await r.text(), "ignored");
  r = await ml0x.fetch(hook("/stripe-webhook", mlSession(sid(), { payment_status: "no_payment_required" })), env);
  assert.equal(await r.text(), "ignored");
  r = await ml0x.fetch(hook("/stripe-webhook", mlSession(sid()), { secret: "whsec_forged" }), env);
  assert.equal(r.status, 400);
  // claim -> download
  stripeCalls = 0;
  r = await get(ml0x, env, "/claim?session_id=" + id);
  let j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.sku, "triage");
  assert.equal(stripeCalls, 0);
  const order = JSON.parse(env.ORDERS.m.get("order:" + id));
  assert.equal(order.sku, "triage"); assert.equal(order.amount_total, 9900);
  r = await get(ml0x, env, "/download?token=" + encodeURIComponent(j.token));
  assert.equal(r.status, 200);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [80, 75, 3, 4, 9]);
  ok("ml0x webhook stores own paid link only; claim and download from the store, no Stripe call");
}
{
  const env = mlEnv();
  const put = (o) => { const id = sid(); env.PAID.rows.set(id, { session_id: id, service: "ml0x", session_json: JSON.stringify(trimSession(mlSession(id, o), true)) }); return id; };
  const claim = async (id) => { const r = await get(ml0x, env, "/claim?session_id=" + id); return [r.status, await r.json()]; };
  assert.equal((await claim(put({ amount_subtotal: 19800, amount_total: 19800 })))[0], 200, "quantity 2");
  assert.equal((await claim(put({ amount_subtotal: 9900, amount_total: 4900 })))[0], 200, "promo code lowers total, not subtotal");
  assert.equal((await claim(put({ amount_subtotal: 4900 })))[0], 403, "different price on our link");
  assert.equal((await claim(put({ amount_subtotal: 14850 })))[0], 403, "not a whole multiple");
  assert.equal((await claim(put({ amount_subtotal: 0 })))[0], 403);
  assert.equal((await claim(put({ amount_subtotal: null })))[0], 403);
  assert.equal((await claim(put({ currency: "eur" })))[0], 403);
  assert.equal((await claim(put({ currency: "eur", amount_subtotal: 9150, amount_total: 9150, currency_conversion: { source_currency: "usd", amount_subtotal: 9900, amount_total: 9900 } })))[0], 200, "adaptive pricing");
  assert.equal((await claim(put({ currency: "eur", amount_subtotal: 9150, currency_conversion: { source_currency: "usd", amount_subtotal: 4900 } })))[0], 403);
  assert.equal((await claim(put({ currency: "eur", amount_subtotal: 9900, currency_conversion: { source_currency: "eur", amount_subtotal: 9900 } })))[0], 403);
  assert.equal((await claim(put({ livemode: false })))[0], 403);
  assert.equal((await claim(put({ payment_status: "unpaid" })))[0], 403);
  assert.equal((await claim(put({ status: "expired" })))[0], 403);
  assert.equal((await claim(put({ created: now() - 400 * 86400 })))[0], 403);
  const pid = put({ payment_link: "plink_1U2NyJJKCamubEm1tYsVidqh" });
  const [ps, pj] = await claim(pid);
  assert.equal(ps, 200); assert.equal(pj.sku, "pipeline");
  assert.equal(storedRejectionReason(null, env), "no such session");
  // a row stored by the almanac is invisible to ml0x
  const aid = sid();
  env.PAID.rows.set(aid, { session_id: aid, service: "almanac", session_json: JSON.stringify(mlSession(aid)) });
  stripeAnswer = { status: 404, body: {} };
  assert.equal((await claim(aid))[0], 403);
  ok("ml0x stored gate: quantity, promo, wrong price, currency, test mode, unpaid, expired, age, both SKUs, isolation");
}
{
  stripeAnswer = { status: 401, body: {} };
  const t0 = Date.now();
  const r = await get(ml0x, mlEnv(), "/claim?session_id=" + sid());
  const j = await r.json();
  assert.equal(r.status, 503); assert.match(j.error, /still coming through/);
  assert.ok(Date.now() - t0 >= 7900);
  // no key at all, store present: still serves stored sessions
  const env = mlEnv({ STRIPE_KEY: "" });
  const id = sid();
  await ml0x.fetch(hook("/stripe-webhook", mlSession(id)), env);
  assert.equal((await get(ml0x, env, "/claim?session_id=" + id)).status, 200);
  // neither key nor store: 503 at once
  assert.equal((await get(ml0x, mlEnv({ STRIPE_KEY: "", PAID: undefined }), "/claim?session_id=" + sid())).status, 503);
  // working key keeps the full price-id gate
  stripeAnswer = { status: 200, body: { ...mlSession("cs_live_viaapi000000000"), line_items: { data: [{ price: { id: "price_1U2MvzJKCamubEm18qajfbKH" } }] } } };
  assert.equal((await get(ml0x, mlEnv(), "/claim?session_id=cs_live_viaapi000000000")).status, 200);
  stripeAnswer = { status: 200, body: { ...mlSession("cs_live_viaapi000000000"), line_items: { data: [{ price: { id: "price_other" } }] } } };
  assert.equal((await get(ml0x, mlEnv(), "/claim?session_id=cs_live_viaapi000000000")).status, 403);
  stripeAnswer = { status: 404, body: {} };
  assert.equal((await get(ml0x, mlEnv(), "/claim?session_id=cs_live_viaapi000000000")).status, 403);
  const h = await (await get(ml0x, mlEnv(), "/health")).json();
  assert.equal(h.configured.webhookSecret, true); assert.equal(h.configured.paidStore, true);
  // other methods still refused on normal routes
  assert.equal((await ml0x.fetch(new Request("https://w.example/claim", { method: "POST" }), mlEnv())).status, 405);
  // D1 read failure with a working key still delivers; with a dead key it is a JSON 503
  const broken = mlEnv(); broken.PAID.failReads = true;
  stripeAnswer = { status: 200, body: { ...mlSession("cs_live_viaapi000000000"), line_items: { data: [{ price: { id: "price_1U2MvzJKCamubEm18qajfbKH" } }] } } };
  assert.equal((await get(ml0x, broken, "/claim?session_id=cs_live_viaapi000000000")).status, 200);
  stripeAnswer = { status: 401, body: {} };
  const r6 = await get(ml0x, broken, "/claim?session_id=" + sid());
  assert.equal(r6.status, 503); assert.match((await r6.json()).error, /still coming through/);
  ok("ml0x claim: pending after ~8 s, works without key, fails closed, API gate unchanged, D1 read failure, health, 405");
}
{
  const env = { PAID: new FakeD1() };
  assert.equal(await storedSession(env, "not-a-session", "ml0x"), null);
  assert.equal(env.PAID.reads, 0);
  ok("store lookup ignores malformed ids without a query");
}
// ================= one endpoint, passed on to ml0x over the service binding
{
  stripeAnswer = { status: 401, body: {} };
  const mEnv = mlEnv();
  const passes = [];
  const binding = { fetch: async (u, init) => {
    passes.push(u);
    return ml0x.fetch(new Request(u, init), mEnv);
  } };
  const aEnv = almEnv({ ML0X_HOOK: binding });
  aEnv.PAID = mEnv.PAID;   // one shared D1 database
  const mid = sid(), aid = sid();
  let r = await almanac.fetch(hook("/stripe-webhook", mlSession(mid)), aEnv);
  assert.equal(r.status, 200); assert.equal(await r.text(), "ignored");
  assert.equal(aEnv.PAID.rows.get(mid).service, "ml0x", "ml0x stored it through the pass");
  r = await almanac.fetch(hook("/stripe-webhook", almSession(aid)), aEnv);
  assert.equal(await r.text(), "stored"); assert.equal(aEnv.PAID.rows.get(aid).service, "almanac");
  assert.equal(passes.length, 2);
  assert.equal((await get(ml0x, mEnv, "/claim?session_id=" + mid)).status, 200);
  // forged events are not passed on
  r = await almanac.fetch(hook("/stripe-webhook", mlSession(sid()), { secret: "whsec_forged" }), aEnv);
  assert.equal(r.status, 400); assert.equal(passes.length, 2);
  // ml0x refuses (wrong secret there): 500 so Stripe retries, almanac row still stored once
  const aEnv2 = almEnv({ ML0X_HOOK: { fetch: async (u, init) => ml0x.fetch(new Request(u, init), mlEnv({ STRIPE_WEBHOOK_SECRET: "whsec_other" })) } });
  const aid2 = sid();
  r = await almanac.fetch(hook("/stripe-webhook", almSession(aid2)), aEnv2);
  assert.equal(r.status, 500); assert.equal(aEnv2.PAID.rows.has(aid2), true);
  r = await almanac.fetch(hook("/stripe-webhook", almSession(aid2)), aEnv2);
  assert.equal(r.status, 500); assert.equal(aEnv2.PAID.rows.size, 1);
  // binding throws: 500
  const aEnv3 = almEnv({ ML0X_HOOK: { fetch: async () => { throw new Error("down"); } } });
  assert.equal((await almanac.fetch(hook("/stripe-webhook", almSession(sid())), aEnv3)).status, 500);
  // no binding (test twin): own result only
  assert.equal((await almanac.fetch(hook("/stripe-webhook", almSession(sid())), almEnv())).status, 200);
  ok("one endpoint: almanac stores its own, passes signed events to ml0x, 500 on pass failure, forged not passed");
}
console.log(`\n${passed} groups passed`);
