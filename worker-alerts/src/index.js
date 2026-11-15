// lln-alerts Worker (sprint-20261115, lane L): lake level alerts by Web Push for lakelevelnow.com.
// No third-party push service: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291) in WebCrypto.
//
// Routes
//   GET  /health                      -> {ok, version, configured:{...}}
//   POST /subscribe   {sub, rules:[{lake, level}], digest, token?}  -> one KV put
//   POST /unsubscribe {endpoint}      -> one KV delete
//   POST /mine        {endpoint}      -> the rules stored for this browser (KV read only)
//   GET  /unlock?session_id=cs_live_  -> Stripe-verified Pro token (12 months from purchase) + GA4 receipt
//   GET  /admin/dry-run               -> Authorization: Bearer <ADMIN_TOKEN>; what the cron would send, sends nothing, writes nothing
//   cron (wrangler.toml, every 6 h)   -> reads https://lakelevelnow.com/alerts/levels.json, sends pushes
//
// KV LLN_ALERTS: key s:<sha256(endpoint)> = {sub, rules:[{lake, level, side}], digest, pro, created, last_digest}.
// KV is written only on subscribe, unsubscribe, a threshold crossing, a sent digest or a dead endpoint. Never per page view.
// Secrets: VAPID_PRIVATE_JWK, TOKEN_KEY, STRIPE_KEY (restricted, Checkout Sessions read), ADMIN_TOKEN.

const VERSION = '1.0.0';
const ORIGINS = ['https://lakelevelnow.com', 'https://www.lakelevelnow.com', 'http://localhost:4321'];
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const SID_RE = /^cs_live_[A-Za-z0-9]{10,200}$/;
const FREE_RULES = 1;
const PRO_RULES = 25;
const PRO_DAYS = 365;
const PRICE_MINOR = 1900;
const DAY = 86400;
const enc = new TextEncoder();

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => {
  const p = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '==='.slice((p.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const concat = (...parts) => {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

function cors(request) {
  const o = request.headers.get('Origin') || '';
  return ORIGINS.includes(o) ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400' } : null;
}
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

// ---- in-memory rate limit (per isolate; never KV) ----
const RL = new Map();
function limited(ip, bucket, max) {
  const k = bucket + ':' + ip + ':' + Math.floor(Date.now() / 600000);
  const n = (RL.get(k) || 0) + 1;
  RL.set(k, n);
  if (RL.size > 5000) RL.clear();
  return n > max;
}

// ---- level feed (the site's own data, rebuilt daily by GitHub Pages CI) ----
async function levels(env, fresh) {
  const res = await fetch(env.LEVELS_URL, fresh ? { cf: { cacheTtl: 0 } } : { cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok) throw new Error('levels ' + res.status);
  const j = await res.json();
  if (!j || typeof j.lakes !== 'object') throw new Error('levels shape');
  return j;
}

// ---- Pro token: HMAC(TOKEN_KEY) over {s: sha256(session)[:24], e: expiry unix} ----
async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.TOKEN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function mintToken(env, sid, exp) {
  const body = b64u(enc.encode(JSON.stringify({ s: (await sha256hex(sid)).slice(0, 24), e: exp })));
  const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)));
  return body + '.' + sig;
}
async function readToken(env, token) {
  if (typeof token !== 'string' || token.length > 400 || !env.TOKEN_KEY) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(sig), enc.encode(body)); } catch (_) { return null; }
  if (!ok) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return Number.isFinite(p.e) && p.e > Date.now() / 1000 ? { s: String(p.s), exp: p.e } : null;
  } catch (_) { return null; }
}

// ---- Stripe verification (restricted key, Checkout Sessions read) ----
const VERIFIED = new Map();
async function verifySession(env, sid) {
  if (VERIFIED.has(sid)) return VERIFIED.get(sid);
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sid), {
    headers: { Authorization: 'Bearer ' + env.STRIPE_KEY } });
  if (res.status === 404 || res.status === 400) return { ok: false, status: 404, reason: 'unknown_session' };
  if (!res.ok) return { ok: false, status: 502, reason: 'stripe_' + res.status, retry: true };
  const s = await res.json();
  const links = String(env.PLINK_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!s.livemode) return { ok: false, status: 403, reason: 'not_live' };
  if (!links.includes(s.payment_link)) return { ok: false, status: 403, reason: 'other_product' };
  if (s.status !== 'complete' || s.payment_status !== 'paid') return { ok: false, status: 402, reason: 'not_paid' };
  if (String(s.currency).toLowerCase() !== 'usd' || !(s.amount_total >= PRICE_MINOR)) return { ok: false, status: 403, reason: 'amount' };
  const exp = s.created + PRO_DAYS * DAY;
  const out = { ok: true, exp, receipt: { transaction_id: sid, payment_status: 'paid', amount_unit: 'stripe_minor',
    amount_total: s.amount_total, amount_tax: (s.total_details && s.total_details.amount_tax) || 0, amount_shipping: 0,
    currency: s.currency, item_id: 'lake_alerts' } };
  VERIFIED.set(sid, out);
  if (VERIFIED.size > 500) VERIFIED.clear();
  return out;
}

// ---- Web Push: RFC 8291 encryption + RFC 8292 VAPID ----
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
async function encryptPayload(text, p256dh, auth) {
  const uaPub = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPub.length !== 65 || authSecret.length !== 16) throw new Error('bad keys');
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  return concat(header, asPub, ct);
}
let VAPID_KEY = null;
async function vapidAuth(env, endpoint) {
  if (!VAPID_KEY) {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    VAPID_KEY = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://lakelevelnow.com/contact/' })));
  const sig = b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, VAPID_KEY, enc.encode(head + '.' + body)));
  return 'vapid t=' + head + '.' + body + '.' + sig + ', k=' + env.VAPID_PUBLIC;
}
async function sendPush(env, sub, msg) {
  const body = await encryptPayload(JSON.stringify(msg), sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, { method: 'POST', body, headers: {
    Authorization: await vapidAuth(env, sub.endpoint), TTL: '86400', Urgency: 'normal',
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Topic: 'lln-' + String(msg.tag || 'alert').slice(0, 20) } });
  return res.status;
}

// ---- validation ----
function validSub(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return null;
  let u;
  try { u = new URL(sub.endpoint); } catch (_) { return null; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(u.hostname))) return null;
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 120 || k.auth.length > 40) return null;
  try { if (unb64u(k.p256dh).length !== 65 || unb64u(k.auth).length !== 16) return null; } catch (_) { return null; }
  return { endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

async function readBody(request, max = 4096) {
  const t = await request.text();
  if (t.length > max) throw new Error('too big');
  return JSON.parse(t);
}

async function subscribe(request, env, h) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (limited(ip, 'sub', 20)) return json({ ok: false, error: 'rate' }, 429, h);
  let b;
  try { b = await readBody(request); } catch (_) { return json({ ok: false, error: 'body' }, 400, h); }
  const sub = validSub(b.sub);
  if (!sub) return json({ ok: false, error: 'subscription' }, 400, h);
  const tok = b.token ? await readToken(env, b.token) : null;
  const pro = !!tok;
  const raw = Array.isArray(b.rules) ? b.rules : [];
  const max = pro ? PRO_RULES : FREE_RULES;
  if (raw.length < 1) return json({ ok: false, error: 'no_rules' }, 400, h);
  if (raw.length > max) return json({ ok: false, error: pro ? 'too_many' : 'need_pro', max }, 402, h);
  let feed;
  try { feed = await levels(env, false); } catch (_) { return json({ ok: false, error: 'levels_unavailable' }, 503, h); }
  const seen = new Set();
  const rules = [];
  for (const r of raw) {
    const lake = String(r && r.lake || '');
    const level = Math.round(Number(r && r.level) * 10) / 10;
    const L = feed.lakes[lake];
    if (!SLUG_RE.test(lake) || !L || !Number.isFinite(level) || level <= 0 || level > 20000) return json({ ok: false, error: 'rule', lake }, 400, h);
    const key = lake + '@' + level;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ lake, level, side: L.level_ft >= level ? 'above' : 'below' });
  }
  const digest = pro && (b.digest === 'daily' || b.digest === 'weekly') ? b.digest : 'off';
  const id = 's:' + await sha256hex(sub.endpoint);
  const prev = await env.LLN_ALERTS.get(id, 'json');
  const rec = { sub, rules, digest, pro: tok ? { exp: tok.exp, s: tok.s } : null, created: prev ? prev.created : Date.now(),
    last_digest: prev ? prev.last_digest || 0 : 0, updated: Date.now() };
  await env.LLN_ALERTS.put(id, JSON.stringify(rec));
  return json({ ok: true, new: !prev, pro, digest, rules: rules.map(({ lake, level, side }) => ({ lake, level, side,
    now: feed.lakes[lake].level_ft, name: feed.lakes[lake].name })) }, 200, h);
}

async function byEndpoint(request, env, h, del) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (limited(ip, del ? 'unsub' : 'mine', 30)) return json({ ok: false, error: 'rate' }, 429, h);
  let b;
  try { b = await readBody(request, 2048); } catch (_) { return json({ ok: false, error: 'body' }, 400, h); }
  if (typeof b.endpoint !== 'string' || b.endpoint.length > 1000) return json({ ok: false, error: 'endpoint' }, 400, h);
  const id = 's:' + await sha256hex(b.endpoint);
  const rec = await env.LLN_ALERTS.get(id, 'json');
  if (del) {
    if (rec) await env.LLN_ALERTS.delete(id);
    return json({ ok: true, deleted: !!rec }, 200, h);
  }
  if (!rec) return json({ ok: true, found: false, rules: [] }, 200, h);
  return json({ ok: true, found: true, digest: rec.digest, pro: !!(rec.pro && rec.pro.exp > Date.now() / 1000),
    rules: rec.rules.map(({ lake, level, side }) => ({ lake, level, side })) }, 200, h);
}

// ---- the check (cron and dry run) ----
async function runCheck(env, { send }) {
  const feed = await levels(env, true);
  const now = Date.now();
  const out = { generated: feed.generated, subs: 0, crossings: 0, digests: 0, sent: 0, gone: 0, writes: 0, errors: 0, items: [] };
  let cursor;
  do {
    const page = await env.LLN_ALERTS.list({ prefix: 's:', cursor, limit: 1000 });
    cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) {
      const rec = await env.LLN_ALERTS.get(k.name, 'json');
      if (!rec || !rec.sub || !Array.isArray(rec.rules)) continue;
      out.subs++;
      const pro = !!(rec.pro && rec.pro.exp > now / 1000);
      const active = pro ? rec.rules : rec.rules.slice(0, FREE_RULES);
      const lines = [];
      let changed = false;
      let firstLake = '';
      for (const r of active) {
        const L = feed.lakes[r.lake];
        if (!L || !L.fresh || !Number.isFinite(L.level_ft)) continue;
        const side = L.level_ft >= r.level ? 'above' : 'below';
        if (r.side && side !== r.side) {
          lines.push(`${L.name} is now ${fmt(L.level_ft)} ft, ${side} your ${fmt(r.level)} ft level (reading ${String(L.as_of).slice(0, 10)}).`);
          firstLake = firstLake || r.lake;
          out.crossings++;
        }
        if (r.side !== side) { r.side = side; changed = true; }
      }
      let digestDue = false;
      if (pro && rec.digest !== 'off') {
        const gap = rec.digest === 'daily' ? 20 * 3600e3 : 6.5 * DAY * 1000;
        digestDue = now - (rec.last_digest || 0) >= gap;
      }
      let msg = null;
      if (lines.length) {
        msg = { title: lines.length === 1 ? 'Lake level alert' : `${lines.length} lake level alerts`, body: lines.join('\n').slice(0, 900),
          url: '/lake/' + firstLake + '/?utm_source=push&utm_medium=alert', tag: 'cross-' + firstLake };
      } else if (digestDue) {
        const parts = [...new Set(active.map((r) => r.lake))].map((s) => feed.lakes[s]).filter(Boolean)
          .map((L) => `${L.name}: ${fmt(L.level_ft)} ft${Number.isFinite(L.delta_24h) ? ` (${L.delta_24h >= 0 ? '+' : ''}${L.delta_24h} ft in 24 h)` : ''}`);
        if (parts.length) msg = { title: rec.digest === 'daily' ? 'Daily lake levels' : 'Weekly lake levels', body: parts.join('\n').slice(0, 900),
          url: '/alerts/?utm_source=push&utm_medium=digest', tag: 'digest' };
      }
      if (msg && digestDue) { rec.last_digest = now; changed = true; out.digests++; }
      out.items.push({ id: k.name.slice(2, 12), pro, rules: active.length, msg: msg ? msg.title : null });
      if (!send) continue;
      let gone = false;
      if (msg) {
        try {
          const st = await sendPush(env, rec.sub, msg);
          if (st === 404 || st === 410) gone = true;
          else if (st >= 200 && st < 300) out.sent++;
          else out.errors++;
        } catch (_) { out.errors++; }
      }
      if (gone) { await env.LLN_ALERTS.delete(k.name); out.gone++; out.writes++; }
      else if (changed) { await env.LLN_ALERTS.put(k.name, JSON.stringify(rec)); out.writes++; }
    }
  } while (cursor);
  return out;
}

async function timingSafeEq(a, b) {
  const [x, y] = await Promise.all([sha256hex(String(a)), sha256hex(String(b))]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const h = cors(request) || {};
    if (request.method === 'OPTIONS') return new Response(null, { status: h['Access-Control-Allow-Origin'] ? 204 : 403, headers: h });
    if (url.pathname === '/health') {
      return json({ ok: true, version: VERSION, configured: { vapid: !!(env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC), token: !!env.TOKEN_KEY,
        stripe: !!env.STRIPE_KEY, admin: !!env.ADMIN_TOKEN, plink: !!env.PLINK_IDS }, free_rules: FREE_RULES, pro_rules: PRO_RULES }, 200, h);
    }
    if (url.pathname === '/admin/dry-run') {
      const auth = request.headers.get('Authorization') || '';
      if (!env.ADMIN_TOKEN || !auth.startsWith('Bearer ') || !(await timingSafeEq(auth.slice(7), env.ADMIN_TOKEN))) return json({ ok: false }, 401);
      try { return json({ ok: true, dry_run: true, ...(await runCheck(env, { send: false })) }); }
      catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
    }
    if (url.pathname === '/unlock' && request.method === 'GET') {
      const sid = url.searchParams.get('session_id') || '';
      if (!SID_RE.test(sid)) return json({ ok: false, error: 'session_id' }, 400, h);
      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (limited(ip, 'unlock', 20)) return json({ ok: false, error: 'rate' }, 429, h);
      if (!env.STRIPE_KEY || !env.TOKEN_KEY) return json({ ok: false, error: 'not_configured' }, 503, h);
      const v = await verifySession(env, sid);
      if (!v.ok) return json({ ok: false, error: v.reason, retry: !!v.retry }, v.status, h);
      if (v.exp < Date.now() / 1000) return json({ ok: false, error: 'expired', expires: v.exp }, 403, h);
      return json({ ok: true, token: await mintToken(env, sid, v.exp), expires: v.exp, payment_receipt: v.receipt }, 200, h);
    }
    if (request.method === 'POST' && ['/subscribe', '/unsubscribe', '/mine'].includes(url.pathname)) {
      if (!h['Access-Control-Allow-Origin']) return json({ ok: false, error: 'origin' }, 403);
      if (url.pathname === '/subscribe') return subscribe(request, env, h);
      return byEndpoint(request, env, h, url.pathname === '/unsubscribe');
    }
    return json({ ok: false, error: 'not_found' }, 404, h);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env, { send: true }).then((r) => console.log(JSON.stringify({ cron: event.cron, ...r, items: undefined }))));
  },
};

export { encryptPayload, runCheck, readToken, mintToken, validSub };
