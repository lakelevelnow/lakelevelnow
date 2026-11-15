/* Sprint 2026-11-15 lane L (data-cro sprint-20261115-lln-push-alerts): the alerts popup now points to the live
   web push alerts (1 free alert, Pro $19 for 12 months) instead of the "at launch" email waitlist.
   Lake sub-pages only (/lake/<slug>/...), skipped where the page has the alerts box (section.la).
   Shows after 30 s or 35% scroll, once per 7 days, 14 days after a close. No email, no network call.
   GA4 through window.__siteGA4Event: offer_view when shown, cta_click on the link (handed to /alerts/). */
(function () {
  'use strict';
  if (!/^(www\.)?lakelevelnow\.com$/.test(location.hostname) && !/[?&]lln_alerts=1\b/.test(location.search)) return;
  var m = location.pathname.match(/^\/lake\/([a-z0-9-]{1,60})(\/|$)/);
  if (!m || document.querySelector('section.la')) return;
  var slug = m[1];
  var KEY = 'lln_alerts_pop_v2', DAY = 864e5;
  try {
    var st = JSON.parse(localStorage.getItem(KEY) || '{}'), now = Date.now();
    if ((st.shown && now - st.shown < 7 * DAY) || (st.closed && now - st.closed < 14 * DAY)) return;
    var mine = JSON.parse(localStorage.getItem('lln_push_v1') || '{}');
    if (mine && mine.rules && mine.rules.length) return;
  } catch (_) {}
  function save(k) { try { var s = JSON.parse(localStorage.getItem(KEY) || '{}'); s[k] = Date.now(); localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {} }
  var h1 = document.querySelector('h1');
  var name = h1 ? h1.textContent.replace(/\s+(water level.*|right now.*)$/i, '').replace(/^How deep is\s+/i, '').trim() : '';
  if (!name || name.length > 60) name = 'this lake';
  var params = { offer_id: 'alerts', lake_slug: slug.slice(0, 40), placement: 'alerts-popup', site: 'lakelevelnow', product: 'lake_alerts', price: 19, currency: 'USD' };
  function ga(n) { if (typeof window.__siteGA4Event === 'function') window.__siteGA4Event(n, params); }
  var shown = false;
  function show() {
    if (shown) return; shown = true;
    detach(); save('shown');
    var css = document.createElement('style');
    css.textContent = '.lap{position:fixed;right:16px;bottom:16px;z-index:60;max-width:360px;width:calc(100% - 32px);box-sizing:border-box;background:var(--card,#fff);color:var(--t1,#16282f);border:1px solid var(--border,#d9d4cc);border-left:4px solid var(--teal,#0b7d6a);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:14px 16px;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.lap h2{font-size:17px;margin:0 28px 6px 0;line-height:1.3}.lap p{margin:0 0 8px}.lap .lap-x{position:absolute;top:4px;right:4px;width:40px;height:40px;border:0;background:none;font-size:22px;cursor:pointer;color:inherit}' +
      '.lap a.lap-s{display:inline-block;min-height:44px;box-sizing:border-box;padding:11px 16px;border-radius:6px;background:var(--teal,#0b7d6a);color:#fff;font-weight:600;text-decoration:none}.lap small{display:block;color:var(--t2,#5c6a70);font-size:12.5px;margin-top:6px}';
    document.head.appendChild(css);
    var box = document.createElement('aside');
    box.className = 'lap';
    box.setAttribute('data-cro', 'sprint-20261115-lln-push-alerts');
    box.setAttribute('aria-label', 'Level alerts');
    box.innerHTML = '<button type="button" class="lap-x" aria-label="Close">×</button><h2></h2><p class="lap-b"></p>' +
      '<a class="lap-s" data-cta="alerts_popup_free" href="/alerts/?lake=' + encodeURIComponent(slug) + '">Set my free alert</a>' +
      '<small>Browser notifications, no email. Chrome, Edge, Firefox; iPhone after Add to Home Screen (iOS 16.4+). Pro: all lakes, $19 for 12 months.</small>';
    box.querySelector('h2').textContent = 'Get a notification when ' + name + ' crosses your level';
    box.querySelector('.lap-b').textContent = 'Pick a level in feet. We check every 6 hours. One alert is free.';
    document.body.appendChild(box);
    ga('offer_view');
    box.querySelector('.lap-x').addEventListener('click', function () { save('closed'); box.remove(); });
  }
  function onScroll() {
    var d = document.documentElement, max = d.scrollHeight - d.clientHeight;
    if (max > 0 && (window.scrollY || d.scrollTop) / max >= 0.35) show();
  }
  var timer = setTimeout(show, 30000);
  function detach() { clearTimeout(timer); window.removeEventListener('scroll', onScroll); }
  window.addEventListener('scroll', onScroll, { passive: true });
})();
