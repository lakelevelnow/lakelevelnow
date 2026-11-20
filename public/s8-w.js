/* Sprint 8 (2026-11-20) lane W: optional email next to an existing Payment Link (data-cro="sprint-20261120-w-lln-<slug>").
   <a href="https://buy.stripe.com/...?client_reference_id=<slug>" data-s8-email-from="#id">: on click, a valid typed email
   is added as prefilled_email; the link keeps its own client_reference_id (it picks the lake for delivery).
   An invalid email stops the click and asks again; an empty field changes nothing. No email is stored.
   email_submit goes through the site tracker (window.__siteGA4Event); begin_checkout stays with ga4.js. */
(function () {
  'use strict';
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('a[data-s8-email-from]');
    if (!a) return;
    var input = document.querySelector(a.getAttribute('data-s8-email-from'));
    var e = input ? (input.value || '').trim() : '';
    if (!e) return;
    var msg = a.parentNode && a.parentNode.querySelector('[data-s8-msg]');
    if (!EMAIL.test(e)) { ev.preventDefault(); if (msg) msg.textContent = 'Please check the email, or leave it empty.'; input.focus(); return; }
    try {
      var u = new URL(a.href);
      if (u.hostname !== 'buy.stripe.com') return;
      u.searchParams.set('prefilled_email', e);
      a.href = u.toString();
    } catch (_) { return; }
    try {
      if (typeof window.__siteGA4Event === 'function') window.__siteGA4Event('email_submit', { site: location.hostname, product: 'almanac_single',
        placement: a.getAttribute('data-cro') || 's8-w', lake: a.getAttribute('data-lake') || '', transport_type: 'beacon' });
    } catch (_) {}
  }, true);
})();
