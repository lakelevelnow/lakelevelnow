/* Sprint 13 S13-8 (2026-11-27): Strict Bot Click-Gate + optional email prefill & async fleet-leads beacon.
   - Zero bare href="https://buy.stripe.com/..." in rendered HTML. Every checkout CTA uses
     href="#lake-checkout" + data-checkout="https://buy.stripe.com/...".
   - Only genuine user interactions (ev.isTrusted === true) open Stripe Checkout.
   - Preserves or attaches client_reference_id=s13_lln_<slug>.
   - When data-s8-email-from="#input" is present and a valid email is typed, appends prefilled_email
     and fires a non-blocking keepalive POST beacon to fleet-leads. */
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

  function parseCheckoutUrl(a) {
    var raw = a.getAttribute('data-checkout') || a.getAttribute('data-checkout-url');
    if (!raw) return null;
    try {
      var u = new URL(raw);
      if (u.hostname !== 'buy.stripe.com') return null;
      return u;
    } catch (_) {
      return null;
    }
  }

  function handleCheckout(ev, forceNewTab) {
    if (ev.isTrusted !== true) return;
    var a = ev.target && ev.target.closest && ev.target.closest('a[data-checkout], a[data-checkout-url]');
    if (!a) return;

    var u = parseCheckoutUrl(a);
    if (!u) return;

    ev.preventDefault();

    var lake = a.getAttribute('data-lake') || 'site';
    if (!u.searchParams.get('client_reference_id')) {
      u.searchParams.set('client_reference_id', 's13_lln_' + lake);
    }

    var emailSel = a.getAttribute('data-s8-email-from');
    if (emailSel) {
      var input = document.querySelector(emailSel);
      var e = input ? (input.value || '').trim() : '';
      var msg = a.parentNode && a.parentNode.querySelector('[data-s8-msg]');
      if (e) {
        if (!EMAIL.test(e)) {
          if (msg) msg.textContent = 'Please check the email, or leave it empty.';
          if (input) input.focus();
          return;
        }
        u.searchParams.set('prefilled_email', e);
        sendLeadBeacon(e, a.getAttribute('data-s8-offer') || 'lln_checkout', lake);
        try {
          if (typeof window.__siteGA4Event === 'function') {
            window.__siteGA4Event('generate_lead', {
              offer_id: a.getAttribute('data-s8-offer') || 'lln_checkout',
              site: 'lakelevelnow',
              placement: a.getAttribute('data-cro') || 's13-8',
              lake_slug: lake
            });
          }
        } catch (_) {}
      }
    }

    try {
      if (typeof window.__siteGA4Event === 'function') {
        window.__siteGA4Event('begin_checkout', {
          offer_id: a.getAttribute('data-s8-offer') || 'lln_checkout',
          site: 'lakelevelnow',
          placement: a.getAttribute('data-cro') || 's13-8',
          lake_slug: lake
        });
      }
      if (typeof window.__almHit === 'function') {
        var w = a.closest && a.closest('[data-alm-place]');
        window.__almHit('checkout_open', lake, w ? w.getAttribute('data-alm-place') : '', '');
      }
    } catch (_) {}

    var dest = u.toString();
    if (forceNewTab || ev.metaKey || ev.ctrlKey || ev.shiftKey) {
      window.open(dest, '_blank', 'noopener');
    } else {
      window.location.assign(dest);
    }
  }

  document.addEventListener('click', function (ev) {
    handleCheckout(ev, false);
  }, true);

  document.addEventListener('auxclick', function (ev) {
    if (ev.button === 1) handleCheckout(ev, true);
  }, true);

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') handleCheckout(ev, false);
  }, true);
})();
