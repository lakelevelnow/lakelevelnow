// Round-trip test: encrypt with the Worker code, decrypt as a browser would (RFC 8291).
import { encryptPayload } from '../src/index.js';
const { subtle } = globalThis.crypto;
const b64u = (b) => Buffer.from(b).toString('base64url');
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
const auth = crypto.getRandomValues(new Uint8Array(16));
const body = await encryptPayload(JSON.stringify({ title: 'T', body: 'hello lake' }), b64u(uaPub), b64u(auth));
const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
const hk = async (s, i, info, l) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await subtle.importKey('raw', i, 'HKDF', false, ['deriveBits']), l * 8));
const te = new TextEncoder();
const ikm = await hk(auth, ecdh, Buffer.concat([te.encode('WebPush: info\0'), uaPub, asPub]), 32);
const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
if (pt[pt.length - 1] !== 2) throw new Error('no delimiter');
console.log('decrypted:', new TextDecoder().decode(pt.slice(0, -1)), 'rs=', new DataView(body.buffer).getUint32(16));
