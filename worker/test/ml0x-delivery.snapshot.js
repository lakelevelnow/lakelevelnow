// ml0x delivery gate.
//
// Contract: the zip is released only for a Checkout Session that Stripe confirms is (1) paid,
// (2) created through OUR payment link, and (3) for OUR price id. All three, every time.
//
// Amount is NOT a gate. As of 2026-08-09 this Stripe account carries six active one-time
// prices at 9900 usd (handsofflinks, ToolsThatRank, Zovo Lifetime Founding, two BeLikeNative
// lifetimes, one retired handsofflinks tier). An amount check would hand our product to every
// buyer of any of them, and hand theirs to ours.
//
// A session id is NOT a download credential. It appears in browser history, forwarded receipts
// and support threads. /claim exchanges it, once, for a short-lived signed token; /download
// accepts tokens only and never looks at session ids.

// A session is read first from the paid-session store (D1 PAID), which a signed Stripe webhook
// fills (POST /stripe-webhook, see paid-store.js). A webhook session has no line items, so a
// stored session passes storedRejectionReason instead: OUR payment link, and an amount_subtotal
// that is a whole multiple of that link's one fixed unit price in its currency. A payment link
// cannot change the price of its line item after creation, only the quantity (checked
// 2026-11-10 with GET /v1/payment_links/<id>/line_items: one item each, 9900 usd).
// The Stripe API (STRIPE_KEY) is the second source and keeps the full price id gate.
import { handleStripeWebhook, storedSession, linkOf, WAIT_MS } from "../src/paid-store.js";

const STORE_SERVICE = "ml0x";

// Two SKUs, one gate. A session is matched to a SKU by its payment link AND its price id,
// never by amount. Both SKUs are 9900 usd, and so are four other products on this Stripe
// account, so amount carries no information about what was bought.
const SKUS = {
  triage: {
    paymentLink: "plink_1U2Mw0JKCamubEm1sSSsTzmp",
    price:       "price_1U2MvzJKCamubEm18qajfbKH",
    unitAmount:  9900,
    currency:    "usd",
    version:     "1.0.0",
    key:         "product:1.0.0",
    filename:    "training-run-triage-v1.0.0.zip",
    title:       "Training Run Triage",
  },
  pipeline: {
    paymentLink: "plink_1U2NyJJKCamubEm1tYsVidqh",
    price:       "price_1U2NyIJKCamubEm1HJ8x4fY5",
    unitAmount:  9900,
    currency:    "usd",
    version:     "1.0.0",
    key:         "pipeline:1.0.0",
    filename:    "ml0x-pipeline-v1.0.0.zip",
    title:       "ml0x Pipeline",
  },
};

const TOKEN_TTL_S = 600;                 // 10 minutes: long enough to click, short enough to rot
const MAX_MINTS_PER_SESSION = 40;        // one buyer, several devices, years of re-downloads
const MAX_DOWNLOADS_PER_TOKEN = 5;
const ORDER_TTL = 60 * 60 * 24 * 400;    // keep the order record longer than any refund window
const MAX_SESSION_ID = 200;
const MAX_TOKEN = 512;

const SESSION_RE = /^cs_(live|test)_[A-Za-z0-9]{8,120}$/;

const enc = new TextEncoder();

/* ---------------------------------------------------------------- helpers */

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : (allowed[0] || "https://ml0x.com");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const json = (d, origin, env, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin, env) },
  });

const b64url = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (str) => {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Token = base64url(JSON payload) + "." + base64url(HMAC). Self-contained, no KV lookup. */
async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

async function verifyToken(token, secret) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  let sig;
  try { sig = unb64url(token.slice(dot + 1)); } catch { return null; }
  // crypto.subtle.verify is constant-time; never hand-roll the comparison.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(body));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(unb64url(body))); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.exp !== "number" || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

/** Retrieve the session WITH its line items. The price id is the only collision-proof fact. */
async function retrieveSession(env, sessionId) {
  const url =
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}` +
    `?expand[]=line_items`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.STRIPE_KEY}`,
      "stripe-version": "2024-06-20",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    let code = "";
    try { const b = await res.json(); code = (b && b.error && (b.error.code || b.error.type)) || ""; } catch { code = "unreadable"; }
    console.error("stripe retrieve failed", res.status, code);   // never log the key
    const err = new Error(`stripe responded ${res.status}`);
    err.upstream = res.status;
    throw err;
  }
  return res.json();
}

/**
 * The whole gate. Returns null when the session may be served, or a reason string.
 * Every check is a positive assertion about OUR product. Nothing here infers entitlement
 * from a price point, a currency or a mode.
 */
function rejectionReason(session, env) {
  if (!session) return "no such session";

  // 1. money actually moved
  if (session.payment_status !== "paid") return `not paid (${session.payment_status})`;
  if (session.status === "expired") return "session expired";

  // 2 and 3. It came through one of OUR links AND bought that link's price. Both, together.
  // A link can be edited; a price id cannot be faked. Neither alone is a gate.
  const rawLink = session.payment_link;
  const gotLink = typeof rawLink === "string" ? rawLink
    : (rawLink && typeof rawLink === "object" && typeof rawLink.id === "string") ? rawLink.id : "";
  if (!gotLink) return "no payment link on session";

  const items = (session.line_items && session.line_items.data) || [];
  if (items.length === 0) return "no line items on session";

  let sku = null;
  for (const name of Object.keys(SKUS)) {
    const s = SKUS[name];
    if (gotLink !== s.paymentLink) continue;
    if (!items.some((li) => li && li.price && li.price.id === s.price)) continue;
    sku = { name, ...s };
    break;
  }
  if (!sku) return "different product";

  // 4. age bound: a receipt from another era is not a standing key
  const maxDays = parseInt(env.MAX_SESSION_AGE_DAYS || "0", 10);
  if (maxDays > 0 && typeof session.created === "number") {
    if ((Date.now() / 1000 - session.created) > maxDays * 86400) return "session is too old; contact support";
  }

  return { sku };
}

export const skuForLink = (link) => {
  const id = linkOf(link);
  if (!id) return null;
  const name = Object.keys(SKUS).find((n) => SKUS[n].paymentLink === id);
  return name ? { name, ...SKUS[name] } : null;
};

function tooOld(session, env) {
  const maxDays = parseInt(env.MAX_SESSION_AGE_DAYS || "0", 10);
  return maxDays > 0 && typeof session.created === "number" &&
    (Date.now() / 1000 - session.created) > maxDays * 86400;
}

/** Gate for a session from the webhook store. Same contract, with the amount rule above. */
export function storedRejectionReason(session, env) {
  if (!session) return "no such session";
  if (session.payment_status !== "paid") return `not paid (${session.payment_status})`;
  if (session.status === "expired") return "session expired";
  if (session.livemode !== true) return "not a live session";
  const sku = skuForLink(session.payment_link);
  if (!sku) return "different product";
  // With Adaptive Pricing the buyer pays in their own currency and Stripe keeps the price's own
  // figures in currency_conversion. Either the session or that source must be our unit price.
  const cc = session.currency_conversion || null;
  const fits = (cur, sub) => cur === sku.currency && Number.isInteger(sub) && sub >= sku.unitAmount && sub % sku.unitAmount === 0;
  if (!fits(session.currency, session.amount_subtotal) &&
      !(cc && fits(cc.source_currency, cc.amount_subtotal))) return "different product";
  if (tooOld(session, env)) return "session is too old; contact support";
  return { sku };
}

/* ----------------------------------------------------------------- routes */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (url.pathname === "/stripe-webhook") {
      try {
        return await handleStripeWebhook(request, env, {
          service: STORE_SERVICE,
          paidStates: ["paid"],
          keepEmail: true,
          accept: (s) => skuForLink(s.payment_link) !== null
        });
      } catch (e) {
        console.error("webhook error", (e && e.message) || String(e));
        return new Response("store failed", { status: 500, headers: { "Cache-Control": "no-store" } });
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ ok: false, error: "use GET" }, origin, env, 405);
    }

    /* ---- health: reports WHETHER config exists, never any value ---------- */
    if (url.pathname === "/health") {
      const skus = {};
      for (const name of Object.keys(SKUS)) {
        let present = false;
        try {
          const blob = await env.ARCHIVE.get(SKUS[name].key, "arrayBuffer");
          present = !!blob && blob.byteLength > 0;
        } catch { /* report false rather than fail the probe */ }
        skus[name] = { version: SKUS[name].version, hasProduct: present };
      }
      return json({
        ok: true, service: "ml0x-delivery", skus,
        configured: {
          stripeKey: !!env.STRIPE_KEY, signingKey: !!env.SIGNING_KEY,
          webhookSecret: !!env.STRIPE_WEBHOOK_SECRET, paidStore: !!env.PAID,
        },
      }, origin, env);
    }

    /* ---- claim: session id -> short-lived token -------------------------- */
    if (url.pathname === "/claim") {
      const sid = url.searchParams.get("session_id") || "";
      if (!sid || sid.length > MAX_SESSION_ID || !SESSION_RE.test(sid)) {
        return json({ ok: false, error: "That is not a valid Stripe session id." }, origin, env, 400);
      }
      if (!env.SIGNING_KEY || (!env.STRIPE_KEY && !env.PAID)) {
        // Misconfiguration fails closed, never open.
        return json({ ok: false, error: "Delivery is temporarily unavailable. Reply to your Stripe receipt." }, origin, env, 503);
      }

      // 1. the webhook store, 2. the Stripe API, 3. a short wait for the webhook.
      let session = await storedSession(env, sid, STORE_SERVICE);
      let fromStore = Boolean(session);
      if (!session) {
        let asked = false;
        if (env.STRIPE_KEY) {
          try {
            session = await retrieveSession(env, sid);   // null means Stripe says no such session
            asked = true;
          } catch { /* dead or rotated key, or Stripe down: fall through to the store */ }
        }
        if (!asked) {
          session = await storedSession(env, sid, STORE_SERVICE, WAIT_MS);
          fromStore = Boolean(session);
          if (!session) {
            return json({ ok: false, error: "Your payment is still coming through. Reload this page in a minute. If this message stays, reply to your Stripe receipt and we will send the file." }, origin, env, 503);
          }
        }
      }

      const verdict = fromStore ? storedRejectionReason(session, env) : rejectionReason(session, env);
      const reason = (verdict && typeof verdict === "string") ? verdict : null;
      const sku = (verdict && verdict.sku) ? verdict.sku : null;
      if (reason || !sku) {
        console.warn("claim refused:", reason, sid.slice(0, 24));
        return json({ ok: false, error: "This order does not match this product. Reply to your Stripe receipt and we will sort it out." }, origin, env, 403);
      }

      // Mint budget per session. Bounds a link posted publicly without punishing a real buyer.
      const mkey = `mints:${sid}`;
      const used = parseInt((await env.ORDERS.get(mkey)) || "0", 10);
      if (used >= MAX_MINTS_PER_SESSION) {
        return json({ ok: false, error: "This receipt has been used too many times. Reply to your Stripe receipt and we will reissue." }, origin, env, 429);
      }
      await env.ORDERS.put(mkey, String(used + 1), { expirationTtl: ORDER_TTL });

      const now = Math.floor(Date.now() / 1000);
      const token = await signToken({ s: sid, k: sku.name, v: sku.version, iat: now, exp: now + TOKEN_TTL_S }, env.SIGNING_KEY);

      // Order record: support, refund handling, and knowing what actually shipped.
      try {
        await env.ORDERS.put(`order:${sid}`, JSON.stringify({
          session: sid,
          email: (session.customer_details && session.customer_details.email) || "",
          amount_total: session.amount_total ?? null,
          currency: session.currency || null,
          payment_link: typeof session.payment_link === "string" ? session.payment_link : null,
          created: session.created ?? null,
          livemode: session.livemode === true,
          sku: sku.name,
          version: sku.version,
          mints: used + 1,
          last_claim: new Date().toISOString(),
        }), { expirationTtl: ORDER_TTL });
      } catch { /* a logging failure must never block a paying customer */ }

      return json({ ok: true, token, expiresIn: TOKEN_TTL_S, filename: sku.filename, title: sku.title, sku: sku.name }, origin, env);
    }

    /* ---- download: tokens only, never a session id ----------------------- */
    if (url.pathname === "/download") {
      // Deliberately absent: any branch that reads session_id here. That is the whole bug class.
      const token = url.searchParams.get("token") || "";
      if (!env.SIGNING_KEY) {
        return json({ ok: false, error: "Delivery is temporarily unavailable." }, origin, env, 503);
      }
      const payload = await verifyToken(token, env.SIGNING_KEY);
      if (!payload) {
        return json({ ok: false, error: "This download link is not valid or has expired. Reopen the page from your Stripe receipt." }, origin, env, 403);
      }

      const dkey = `dl:${payload.s}:${payload.iat}`;
      const used = parseInt((await env.ORDERS.get(dkey)) || "0", 10);
      if (used >= MAX_DOWNLOADS_PER_TOKEN) {
        return json({ ok: false, error: "This link has been used its maximum number of times. Reload the page for a fresh one." }, origin, env, 429);
      }

      const dsku = SKUS[payload.k] || null;
      if (!dsku) {
        return json({ ok: false, error: "This download link is not valid or has expired. Reopen the page from your Stripe receipt." }, origin, env, 403);
      }
      const body = await env.ARCHIVE.get(dsku.key, "arrayBuffer");
      if (!body || body.byteLength === 0) {
        // Do not spend one of the buyer's downloads on our own outage.
        return json({ ok: false, error: "The file is not in storage. Reply to your Stripe receipt and we will send it directly." }, origin, env, 503);
      }
      await env.ORDERS.put(dkey, String(used + 1), { expirationTtl: TOKEN_TTL_S + 60 });

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${dsku.filename}"`,
          "Cache-Control": "no-store",
          "X-ML0X-Verified": "token",
          ...corsHeaders(origin, env),
        },
      });
    }

    return json({ ok: false, error: "not found" }, origin, env, 404);
  },
};
