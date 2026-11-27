/* Sprint 9 L9 (2026-11-26): Bot Click-Gate + optional email prefill & async fleet-leads beacon.
   - Any <a href="#..." data-checkout-url="https://buy.stripe.com/..."> stays free of bare Stripe
     URLs in static HTML so crawlers do not open phantom Stripe Checkout sessions.
   - On real user interaction (pointerdown/keydown/click/auxclick with isTrusted !== false),
     hydrates a.href from data-checkout-url (preserving client_reference_id for lake delivery).
   - When data-s8-email-from="#input" is present and a valid email is typed, appends prefilled_email
     to the Stripe URL and fires a non-blocking keepalive POST beacon to fleet-leads. */
(function () {
  'use strict';
  if (window.__s8WInit) return;
  window.__s8WInit = 1;

  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var LEADS_URL = 'https://fleet-leads.lipmichal.workers.dev/lead';

  function sendLeadBeacon(email, offerId, lake) {
    try {
      var body = JSON.stringify({
        email: email,
        offer_id: offerId || 'lln-checkout-email',
        page: location.href,
        lake: lake || '',
        hp: ''
      });
      fetch(LEADS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (_) {}
  }

  function hydrateUrl(a) {
    var raw = a.getAttribute('data-checkout-url');
    if (!raw) return null;
    try {
      var u = new URL(raw);
      if (u.hostname !== 'buy.stripe.com') return null;
      return u;
    } catch (_) {
      return null;
    }
  }

  // Pre-hydrate on real pointer/keyboard intent so ga4.js & BaseLayout capture listeners see the real URL.
  function onIntent(ev) {
    if (ev.isTrusted === false) return;
    var a = ev.target && ev.target.closest && ev.target.closest('a[data-checkout-url]');
    if (!a) return;
    var u = hydrateUrl(a);
    if (u) a.href = u.toString();
  }
  document.addEventListener('pointerdown', onIntent, true);
  document.addEventListener('touchstart', onIntent, { capture: true, passive: true });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') onIntent(ev);
  }, true);

  function onClick(ev) {
    if (ev.isTrusted === false) return;
    var a = ev.target && ev.target.closest && ev.target.closest('a[data-checkout-url], a[data-s8-email-from]');
    if (!a) return;

    var u = hydrateUrl(a);
    if (!u) {
      try {
        u = new URL(a.href);
        if (u.hostname !== 'buy.stripe.com') return;
      } catch (_) { return; }
    }

    var emailSel = a.getAttribute('data-s8-email-from');
    if (emailSel) {
      var input = document.querySelector(emailSel);
      var e = input ? (input.value || '').trim() : '';
      var msg = a.parentNode && a.parentNode.querySelector('[data-s8-msg]');
      if (e) {
        if (!EMAIL.test(e)) {
          ev.preventDefault();
          if (msg) msg.textContent = 'Please check the email, or leave it empty.';
          if (input) input.focus();
          return;
        }
        u.searchParams.set('prefilled_email', e);
        sendLeadBeacon(e, a.getAttribute('data-s8-offer') || 'almanac_single', a.getAttribute('data-lake') || '');
        try {
          if (typeof window.__siteGA4Event === 'function') {
            window.__siteGA4Event('generate_lead', {
              offer_id: a.getAttribute('data-s8-offer') || 'almanac_single',
              site: 'lakelevelnow',
              placement: a.getAttribute('data-cro') || 's8-w',
              lake_slug: a.getAttribute('data-lake') || ''
            });
          }
        } catch (_) {}
      }
    }

    a.href = u.toString();
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', function (ev) {
    if (ev.button === 1) onClick(ev);
  }, true);

  /* Sprint 10 S10-8: auto-expiring 1-line dismissible Zovo Black Friday $79 bar
     (2026-11-27T00:00:00Z to 2026-12-02T00:00:00Z UTC ONLY). */
  (function () {
    var now = Date.now();
    var START = Date.UTC(2026, 10, 27, 0, 0, 0); // 2026-11-27T00:00:00Z
    var END = Date.UTC(2026, 11, 2, 0, 0, 0);    // 2026-12-02T00:00:00Z
    if (now < START || now >= END) return;
    var KEY = 'lln_zovo_bfcm_2026_dismissed';
    try { if (localStorage.getItem(KEY) === '1') return; } catch (_) {}

    function mountBar() {
      if (document.getElementById('zovo-bfcm-bar') || !document.body) return;
      var bar = document.createElement('div');
      bar.id = 'zovo-bfcm-bar';
      bar.setAttribute('data-cro', 'sprint10-bfcm-bar');
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'Zovo Black Friday offer');
      bar.style.cssText = 'position:relative;background:#111;color:#fff;font:500 13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-align:center;padding:8px 36px 8px 14px;border-bottom:1px solid rgba(255,255,255,0.12);';
      bar.innerHTML = 'Black Friday (Nov 27\u2013Dec 1 UTC): Zovo Pro Lifetime (all 15 Chrome extensions) is <strong>$79</strong> once (reg. $99) \u2014 <a href="https://zovo.one/pricing?utm_source=lakelevelnow&amp;utm_medium=bfcm_bar" target="_blank" rel="noopener" style="color:#fff;text-decoration:underline;font-weight:700;">Claim $79 Lifetime &rarr;</a>';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Dismiss Black Friday banner');
      btn.textContent = '\u00d7';
      btn.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:0;color:rgba(255,255,255,0.75);font:700 18px/1 sans-serif;cursor:pointer;padding:4px 6px;';
      btn.addEventListener('click', function () {
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        try { localStorage.setItem(KEY, '1'); } catch (_) {}
      });
      bar.appendChild(btn);

      document.body.insertBefore(bar, document.body.firstChild);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBar);
    else mountBar();
  })();
})();
