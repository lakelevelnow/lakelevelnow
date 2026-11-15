/* LakeLevelNow lake alerts by Web Push (sprint-20261115, lane L, data-cro sprint-20261115-lln-push-alerts).
   Shared by the alerts box on lake pages (LevelAlerts.astro) and the /alerts/ page.
   The browser's push subscription goes only to lln-alerts.lipmichal.workers.dev. No email, no name. */
(function () {
  'use strict';
  if (window.LLNPush) return;
  var API = 'https://lln-alerts.lipmichal.workers.dev';
  var VAPID = 'BHiGHtIJBRwotk3uKLXsoljfbqWv_jZwWY7OzSRfvSpqA9IEQJmGRcV1te49QEkjcBjjkvFjdSEF16Cwuk6eV_g';
  var KEY = 'lln_push_v1';
  function load() { try { var s = JSON.parse(localStorage.getItem(KEY) || '{}'); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; } }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {} }
  function u8(b64) {
    var p = b64.replace(/-/g, '+').replace(/_/g, '/'); p += '==='.slice((p.length + 3) % 4);
    var bin = atob(p), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var ua = navigator.userAgent || '';
  var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function post(path, body) {
    return fetch(API + path, { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); });
  }
  function reg() { return navigator.serviceWorker.register('/lln-push-sw.js', { scope: '/' }).then(function () { return navigator.serviceWorker.ready; }); }
  function existing() {
    if (!supported()) return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration('/').then(function (r) { return r ? r.pushManager.getSubscription() : null; }).catch(function () { return null; });
  }
  function pro() { var s = load(); return !!(s.token && s.exp && s.exp * 1000 > Date.now()); }
  // rules: full list [{lake, level, name}]. Asks for notification permission (must run from a click).
  function subscribe(rules, digest) {
    if (!supported()) return Promise.reject(new Error(ios && !standalone ? 'ios_install' : 'unsupported'));
    var perm = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
    return Promise.resolve(perm).then(function (p) {
      if (p !== 'granted') throw new Error('denied');
      return reg();
    }).then(function (r) {
      return r.pushManager.getSubscription().then(function (sub) {
        return sub || r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(VAPID) });
      }).then(function (sub) {
        var s = load(), had = !!(s.rules && s.rules.length);
        return post('/subscribe', { sub: sub.toJSON(), rules: rules.map(function (x) { return { lake: x.lake, level: x.level }; }),
          digest: digest || s.digest || 'off', token: pro() ? s.token : undefined }).then(function (j) {
          if (j.ok) {
            // KV reads can be up to 60 s stale; count a lead only for a browser that had no alert before.
            j.new = !!j.new && !had;
            var names = {};
            rules.forEach(function (x) { names[x.lake] = x.name; });
            s.rules = (j.rules || []).map(function (x) { return { lake: x.lake, level: x.level, name: x.name || names[x.lake] || x.lake, now: x.now, side: x.side }; });
            s.digest = j.digest; save(s);
            r.showNotification('Lake alert set', { body: s.rules.map(function (x) { return x.name + ': ' + x.level + ' ft'; }).join('\n'), tag: 'lln-set', icon: '/favicon.svg' });
          }
          return j;
        });
      });
    });
  }
  function unsubscribe() {
    return existing().then(function (sub) {
      var s = load(); delete s.rules; delete s.digest; save(s);
      if (!sub) return { ok: true, deleted: false };
      var ep = sub.endpoint;
      return post('/unsubscribe', { endpoint: ep }).then(function (j) { return sub.unsubscribe().then(function () { return j; }, function () { return j; }); });
    });
  }
  function mine() {
    return existing().then(function (sub) { return sub ? post('/mine', { endpoint: sub.endpoint }) : { ok: true, found: false, rules: [] }; });
  }
  function unlock(sid) {
    return fetch(API + '/unlock?session_id=' + encodeURIComponent(sid), { mode: 'cors', credentials: 'omit' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); })
      .then(function (j) { if (j.ok && j.token) { var s = load(); s.token = j.token; s.exp = j.expires; save(s); } return j; });
  }
  function ga(name, params) {
    var p = Object.assign({ offer_id: 'alerts', site: 'lakelevelnow', product: 'lake-alerts' }, params || {});
    if (typeof window.__siteGA4Event === 'function') { window.__siteGA4Event(name, p); return; }
    document.addEventListener('site-ga4-ready', function () { if (typeof window.__siteGA4Event === 'function') window.__siteGA4Event(name, p); }, { once: true });
  }
  window.LLNPush = { supported: supported, ios: ios, standalone: standalone, iosNeedsInstall: ios && !standalone, state: load, save: save,
    pro: pro, subscribe: subscribe, unsubscribe: unsubscribe, mine: mine, unlock: unlock, existing: existing, ga: ga,
    BUY: 'https://buy.stripe.com/8x25kE3seek8fopebb43S3R' };
})();
