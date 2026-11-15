// Pro token round trip, tamper and expiry (node worker-alerts/test/token.mjs).
import { mintToken, readToken, validSub } from '../src/index.js';
const env = { TOKEN_KEY: 'test-key-' + Math.random() };
const now = Math.floor(Date.now() / 1000);
const t = await mintToken(env, 'cs_live_test123456789', now + 3600);
const ok = await readToken(env, t);
const tampered = await readToken(env, t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA'));
const expired = await readToken(env, await mintToken(env, 'cs_live_test123456789', now - 10));
const otherKey = await readToken({ TOKEN_KEY: 'other' }, t);
const badHost = validSub({ endpoint: 'https://evil.example/x', keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) } });
console.log({ ok: !!ok, tampered, expired, otherKey, badHost });
if (!ok || tampered || expired || otherKey || badHost) process.exit(1);
