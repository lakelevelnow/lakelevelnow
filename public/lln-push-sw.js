/* LakeLevelNow push service worker (sprint-20261115, lane L). Shows lake level alerts sent by
   lln-alerts.lipmichal.workers.dev. It has no fetch handler: it never caches or changes page loads. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var m = {};
  try { m = e.data ? e.data.json() : {}; } catch (_) { m = { body: e.data ? e.data.text() : '' }; }
  var url = typeof m.url === 'string' && m.url.charAt(0) === '/' ? m.url : '/alerts/';
  e.waitUntil(self.registration.showNotification(String(m.title || 'Lake level alert').slice(0, 80), {
    body: String(m.body || 'A lake you watch crossed your level.').slice(0, 900),
    tag: String(m.tag || 'lln-alert').slice(0, 40), icon: '/favicon.svg', badge: '/favicon.svg', data: { url: url }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/alerts/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if (list[i].url.indexOf(self.location.origin) === 0 && 'focus' in list[i]) { list[i].navigate(url); return list[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
