/* CRO 2026-11-13 (livedata impl): replaces the Telegram community popup (lln-ui.js, 816 shown,
   5 clicks in 28 days) with a level-alerts waitlist card for the lake on the page.
   Lake pages only (/lake/<slug>/...). Skipped where the page already has the inline alerts box.
   Shows after 30 s or 35% scroll, once per 7 days, 14 days after a close. Email goes only to
   the waitlist Worker (offer_id alerts). GA4 through window.__siteGA4Event: view_promotion,
   select_promotion, generate_lead, placement alerts-popup. */
(function () {
  'use strict';
  if (!/^(www\.)?lakelevelnow\.com$/.test(location.hostname) && !/[?&]lln_alerts=1\b/.test(location.search)) return;
  var m = location.pathname.match(/^\/lake\/([a-z0-9-]{1,60})(\/|$)/);
  if (!m || document.querySelector('section.la')) return;
  var slug = m[1];
  var KEY = 'lln_alerts_pop_v1', DAY = 864e5;
  try {
    var st = JSON.parse(localStorage.getItem(KEY) || '{}');
    var now = Date.now();
    if (st.joined || (st.shown && now - st.shown < 7 * DAY) || (st.closed && now - st.closed < 14 * DAY)) return;
  } catch (_) {}
  function save(k) { try { var s = JSON.parse(localStorage.getItem(KEY) || '{}'); s[k] = Date.now(); localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {} }
  var h1 = document.querySelector('h1');
  var name = h1 ? h1.textContent.replace(/\s+(water level.*|right now.*)$/i, '').replace(/^How deep is\s+/i, '').trim() : '';
  if (!name || name.length > 60) name = 'this lake';
  var biz = slug === 'lake-mead' || slug === 'lake-powell';
  var params = { offer_id: 'alerts', ab_variant: 'alerts', lake_slug: slug.slice(0, 40), placement: 'alerts-popup',
    site: 'lakelevelnow', product: 'lake-level-alerts', price: 19, currency: 'USD' };
  function ga(n) { if (typeof window.__siteGA4Event === 'function') window.__siteGA4Event(n, params); }
  var shown = false;
  function show() {
    if (shown) return; shown = true;
    detach();
    save('shown');
    var css = document.createElement('style');
    css.textContent = '.lap{position:fixed;right:16px;bottom:16px;z-index:60;max-width:360px;width:calc(100% - 32px);box-sizing:border-box;background:var(--card,#fff);color:var(--t1,#16282f);border:1px solid var(--border,#d9d4cc);border-left:4px solid var(--teal,#0b7d6a);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:14px 16px;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.lap h2{font-size:17px;margin:0 28px 6px 0;line-height:1.3}.lap p{margin:0 0 8px}.lap .lap-x{position:absolute;top:4px;right:4px;width:40px;height:40px;border:0;background:none;font-size:22px;cursor:pointer;color:inherit}' +
      '.lap-row{display:flex;gap:6px;flex-wrap:wrap}.lap input{flex:1 1 170px;min-width:0;min-height:44px;padding:8px 10px;border:1px solid var(--border,#d9d4cc);border-radius:6px;font:16px system-ui,sans-serif}' +
      '.lap button.lap-s{min-height:44px;padding:8px 14px;border:0;border-radius:6px;background:var(--teal,#0b7d6a);color:#fff;font-weight:600;cursor:pointer}.lap small{display:block;color:var(--t2,#5c6a70);font-size:12.5px;margin-top:6px}' +
      '.lap .lap-biz{border-top:1px solid var(--border,#d9d4cc);padding-top:8px;margin-top:8px;font-size:14px}.lap [hidden]{display:none!important}';
    document.head.appendChild(css);
    var box = document.createElement('aside');
    box.className = 'lap';
    box.setAttribute('data-cro', 'lln-alerts-popup');
    box.setAttribute('aria-label', 'Level alerts');
    box.innerHTML = '<button type="button" class="lap-x" aria-label="Close">×</button>' +
      '<h2></h2><p class="lap-b"></p>' +
      '<form novalidate><div class="lap-row"><input type="email" name="email" autocomplete="email" maxlength="254" aria-label="Your email address" placeholder="you@example.com">' +
      '<button type="submit" class="lap-s">Get it first</button></div>' +
      '<input type="text" name="hp_wl" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px">' +
      '<small>One email when alerts start. Nothing else. <a href="/privacy/#waitlist">Privacy</a></small><p class="lap-st" role="status" aria-live="polite"></p></form>' +
      (biz ? '<p class="lap-biz">Marina or boat rental? <a href="/advertise/" data-cta="alerts_popup_advertise">List your business under the level, $199 a year</a></p>' : '');
    box.querySelector('h2').textContent = 'Email me when ' + name + ' crosses a level';
    box.querySelector('.lap-b').textContent = 'Level alerts are being built: $19/yr at launch. Join the waitlist free and get one email when they start.';
    box.setAttribute('data-cro-sprint', 'sprint-20261113-lln-alerts-price');
    document.body.appendChild(box);
    ga('view_promotion');
    ga('offer_view');
    var form = box.querySelector('form'), input = form.querySelector('input[name=email]'), stt = box.querySelector('.lap-st'),
        btn = form.querySelector('.lap-s'), picked = false, busy = false;
    box.querySelector('.lap-x').addEventListener('click', function () { save('closed'); box.remove(); });
    input.addEventListener('focus', function () { if (!picked) { picked = true; ga('select_promotion'); } });
    var RE = /^[^\s@"<>()[\]\\,;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/i;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      var v = String(input.value || '').trim();
      if (v.length > 254 || !RE.test(v)) { stt.textContent = 'Please enter a valid email address.'; input.focus(); return; }
      ga('cta_click');
      busy = true; btn.disabled = true; stt.textContent = 'Sending';
      fetch('https://lake-level-almanac.lipmichal.workers.dev/waitlist', { method: 'POST', mode: 'cors', credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: v, offer_id: 'alerts', ab_variant: 'alerts', lake_slug: params.lake_slug, placement: 'alerts-popup', hp: form.hp_wl.value })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (res.status === 200 && j && j.ok) {
            if (!j.dup) ga('generate_lead');
            save('joined');
            form.querySelector('.lap-row').hidden = true;
            stt.textContent = 'Thanks. You are on the list.';
            return;
          }
          busy = false; btn.disabled = false;
          stt.textContent = res.status === 429 ? 'Too many sign-ups today. Please try again tomorrow.' : 'Sorry, that did not work. Please try again.';
        });
      }).catch(function () { busy = false; btn.disabled = false; stt.textContent = 'Sorry, that did not work. Please try again.'; });
    });
  }
  var timer = setTimeout(show, 30000);
  function onScroll() {
    var d = document.documentElement;
    var max = Math.max(1, d.scrollHeight - window.innerHeight);
    if (window.scrollY / max >= 0.35) show();
  }
  function detach() { clearTimeout(timer); window.removeEventListener('scroll', onScroll); }
  window.addEventListener('scroll', onScroll, { passive: true });
})();
