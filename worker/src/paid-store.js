// Paid-session store, fed by a signed Stripe webhook (POST /stripe-webhook).
//
// Why it exists: the Worker's Stripe API key can be revoked or rotated, and then a buyer who
// paid gets an error instead of the file. Stripe signs every webhook with a per-endpoint secret
// (whsec_). That secret can only prove that a message came from Stripe. It cannot read or change
// anything at Stripe, so it is safe to hold here.
//
// The handler stores a paid Checkout Session only when the caller's accept() says it belongs to
// this Worker's own payment links. Rows live in D1 (binding PAID, table paid_sessions, see
// worker/paid-store.sql). D1 reads go to the primary, so a buyer who lands right after the
// webhook sees the row. Workers KV can cache a miss for up to 60 seconds, which is why it is
// not used here.
//
// This file is shared byte for byte by lake-level-almanac and ml0x-delivery.

export const WH_TOLERANCE_S = 300;
export const WH_MAX_BODY = 1048576;
// Rows older than this are deleted when a new row is stored (ml0x keeps orders as long).
export const KEEP_DAYS = 400;
// Waits (ms) between the second and later store reads when the first read missed and Stripe
// could not be asked. About 8 seconds in all. Stripe usually delivers within 1 to 3 seconds.
export const WAIT_MS = [1500, 2500, 4000];

const WH_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
const SESSION_RE = /^cs_(live|test)_[A-Za-z0-9]{8,200}$/;
const MAX_FIELDS = 10;
const MAX_VALUE = 200;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyStripeSignature(body, header, secret, nowS = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = String(header).split(",").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  });
  const t = (parts.find((p) => p[0] === "t") || [])[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!/^\d{1,12}$/.test(t || "") || !sigs.length || Math.abs(nowS - Number(t)) > WH_TOLERANCE_S) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, enc.encode(t + "." + body)));
  return sigs.some((s) => sameText(s, want));
}

export const linkOf = (v) =>
  typeof v === "string" ? v : (v && typeof v === "object" && typeof v.id === "string") ? v.id : null;

const cut = (v) => (v === null || v === undefined) ? null : String(v).slice(0, MAX_VALUE);
const num = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : null;

// Keep only the fields the delivery gates read. No name, no address, no phone.
// The email is kept only when the caller asks (ml0x writes it to its order record today).
export function trimSession(s, keepEmail = false) {
  const td = s.total_details && typeof s.total_details === "object" ? s.total_details : null;
  const fields = Array.isArray(s.custom_fields) ? s.custom_fields.slice(0, MAX_FIELDS) : [];
  const cc = s.currency_conversion && typeof s.currency_conversion === "object" ? s.currency_conversion : null;
  const out = {
    id: s.id,
    object: "checkout.session",
    livemode: s.livemode === true,
    status: cut(s.status),
    payment_status: cut(s.payment_status),
    payment_link: linkOf(s.payment_link),
    amount_total: num(s.amount_total),
    amount_subtotal: num(s.amount_subtotal),
    currency: s.currency ? String(s.currency).toLowerCase().slice(0, 10) : null,
    total_details: td ? {
      amount_discount: num(td.amount_discount),
      amount_shipping: num(td.amount_shipping),
      amount_tax: num(td.amount_tax)
    } : null,
    // Only the lake picker is read (almanac). Other custom-field answers are not kept.
    custom_fields: fields.filter((f) => f && typeof f === "object" && f.key === "lake").map((f) => ({
      key: cut(f.key),
      dropdown: f.dropdown && typeof f.dropdown === "object" ? { value: cut(f.dropdown.value) } : null,
      text: f.text && typeof f.text === "object" ? { value: cut(f.text.value) } : null
    })),
    // Present when Stripe shows the price in the buyer's currency (Adaptive Pricing).
    currency_conversion: cc ? {
      source_currency: cc.source_currency ? String(cc.source_currency).toLowerCase().slice(0, 10) : null,
      amount_subtotal: num(cc.amount_subtotal),
      amount_total: num(cc.amount_total)
    } : null,
    client_reference_id: cut(s.client_reference_id),
    created: num(s.created)
  };
  if (keepEmail) {
    const e = s.customer_details && typeof s.customer_details === "object" ? s.customer_details.email : "";
    out.customer_details = { email: typeof e === "string" ? e.slice(0, 320) : "" };
  }
  return out;
}

const plain = (status, body) => new Response(body, {
  status,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
});

// opts: { service, paidStates: string[], accept(session) -> boolean, keepEmail?: boolean }
// Answers 200 for every signed event it does not need, so Stripe does not retry those.
// A D1 failure throws, the caller answers 500, and Stripe retries for up to 3 days.
export async function handleStripeWebhook(request, env, opts) {
  if (request.method !== "POST") return plain(405, "POST only");
  if (!env.STRIPE_WEBHOOK_SECRET || !env.PAID) return plain(500, "not configured");
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > WH_MAX_BODY) return plain(413, "too large");
  const body = await request.text();
  if (body.length > WH_MAX_BODY) return plain(413, "too large");
  if (!(await verifyStripeSignature(body, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))) {
    return plain(400, "bad signature");
  }
  let event;
  try { event = JSON.parse(body); } catch { return plain(400, "bad json"); }
  if (!event || !WH_EVENTS.has(event.type)) return plain(200, "ignored");
  const s = event.data && event.data.object;
  if (!s || typeof s !== "object" || s.object !== "checkout.session") return plain(200, "ignored");
  if (typeof s.id !== "string" || !SESSION_RE.test(s.id)) return plain(200, "ignored");
  if (!opts.paidStates.includes(s.payment_status)) return plain(200, "ignored");
  if (!opts.accept(s)) return plain(200, "ignored");
  await env.PAID.prepare(
    "INSERT OR IGNORE INTO paid_sessions (session_id, service, session_json, event_id, received) VALUES (?1, ?2, ?3, ?4, ?5)"
  ).bind(
    s.id,
    opts.service,
    JSON.stringify(trimSession(s, opts.keepEmail === true)),
    typeof event.id === "string" ? event.id.slice(0, 100) : "",
    Math.floor(Date.now() / 1000)
  ).run();
  try {
    await env.PAID.prepare("DELETE FROM paid_sessions WHERE received < ?1")
      .bind(Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400).run();
  } catch (e) {
    console.error("paid_sessions cleanup failed", String(e && e.message || e));   // never block the store
  }
  return plain(200, "stored");
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads the stored session for this service. waits = [] reads one time. Each value in waits
// is a pause before one more read. Returns the session object or null.
export async function storedSession(env, id, service, waits = [], sleep = realSleep) {
  if (!env.PAID || typeof id !== "string" || !SESSION_RE.test(id)) return null;
  // A store failure counts as a miss, so the Stripe API path still runs when its key works.
  const read = async () => {
    try {
      const row = await env.PAID.prepare(
        "SELECT session_json FROM paid_sessions WHERE session_id = ?1 AND service = ?2"
      ).bind(id, service).first();
      if (!row || typeof row.session_json !== "string") return null;
      return JSON.parse(row.session_json);
    } catch (e) {
      console.error("paid_sessions read failed", String(e && e.message || e));
      return null;
    }
  };
  let got = await read();
  for (const ms of waits) {
    if (got) break;
    await sleep(ms);
    got = await read();
  }
  return got;
}
