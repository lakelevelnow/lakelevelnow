/* support-v3.js v3.1 - tip card behaviour (no network, no cookies). 2026-10-17.
   v3.1: price A/B test on 4 sites (AB_SITES). Each browser gets arm 'a3' (Tip $3) or 'b5' (Tip $5), 50/50, stored in localStorage.
   Arm b5 rewrites ONLY the result card: paypal.me/najzzz/3USD -> 5USD, '$3' -> '$5', 'three months' -> 'five months' (true for $10-12/yr domains).
   GA4 sees the arm in outbound linkUrl (3USD vs 5USD) and in support_click {arm}.
   Markup contract:
   <div data-support-cta="result" data-sct-site="SITE" hidden?>
     <div data-sct-variant="first">...first-use copy...</div>
     <div data-sct-variant="returning" hidden>...copy with <span data-sct-uses></span>...</div>
     ...buttons (a[data-rail])...
     <button type="button" data-sct-dismiss>Not now</button>
   </div>
   Call window.sctShown() when the tool shows a result (or let the card count once per page view if it is always visible).
   Uses are counted only in this browser (localStorage). "Not now" hides the result card for 30 days; the footer block stays. */
(function () {
  var K = 'sct:' + (document.documentElement.getAttribute('data-sct-site') || location.hostname);
  function get(k, d) { try { var v = localStorage.getItem(K + ':' + k); return v === null ? d : v; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(K + ':' + k, String(v)); } catch (e) {} }
  var RETURNING_AT = 3, SNOOZE_MS = 30 * 864e5;
  var AB_SITES = ['ingredientcalculator.com', 'recipetool.net', 'lakelevelnow.com', 'goldgramprice.com'];
  var host = location.hostname.replace(/^www\./, '');
  var arm = 'na';
  if (AB_SITES.indexOf(host) !== -1) {
    arm = get('arm', '');
    if (arm !== 'a3' && arm !== 'b5') { arm = Math.random() < 0.5 ? 'a3' : 'b5'; set('arm', arm); }
    document.documentElement.setAttribute('data-sct-arm', arm);
  }
  function applyArm(card) {
    if (arm !== 'b5' || card.getAttribute('data-sct-armed')) return;
    card.setAttribute('data-sct-armed', '1');
    Array.prototype.forEach.call(card.querySelectorAll('a[href*="paypal.me/najzzz/3USD"]'), function (a) { a.setAttribute('href', a.getAttribute('href').replace('/3USD', '/5USD')); });
    var w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null), n;
    while ((n = w.nextNode())) { n.nodeValue = n.nodeValue.replace(/\$3\b/g, '$5').replace(/three months/g, 'five months'); }
  }
  function cards() { return Array.prototype.slice.call(document.querySelectorAll('[data-support-cta="result"]')); }
  function snoozed() { return Date.now() < Number(get('snooze', 0)); }
  function render(card) {
    applyArm(card);
    var uses = Number(get('uses', 0));
    var ret = uses >= RETURNING_AT;
    card.setAttribute('data-sct-state', ret ? 'returning' : 'first');
    Array.prototype.forEach.call(card.querySelectorAll('[data-sct-variant]'), function (v) {
      v.hidden = v.getAttribute('data-sct-variant') !== (ret ? 'returning' : 'first');
    });
    Array.prototype.forEach.call(card.querySelectorAll('[data-sct-uses]'), function (s) { s.textContent = String(uses); });
  }
  var counted = false;
  window.sctShown = function () {
    if (!counted) { counted = true; set('uses', Number(get('uses', 0)) + 1); }
    cards().forEach(function (c) { render(c); if (!snoozed()) c.hidden = false; });
  };
  document.addEventListener('click', function (e) {
    var t = e.target;
    var d = t && t.closest && t.closest('[data-sct-dismiss]');
    if (d) { set('snooze', Date.now() + SNOOZE_MS); var c = d.closest('[data-support-cta]'); if (c) c.hidden = true; return; }
    var a = t && t.closest && t.closest('[data-support-cta] a[data-rail]');
    if (a && typeof window.gtag === 'function') {
      var r = a.closest('[data-support-cta]');
      window.gtag('event', 'support_click', { cta_position: r.getAttribute('data-support-cta'), rail: a.getAttribute('data-rail'), variant: r.getAttribute('data-sct-state') || 'na', arm: arm });
    }
  }, true);
  function init() {
    cards().forEach(function (c) {
      render(c);
      if (snoozed()) c.hidden = true;
      if (c.hasAttribute('data-sct-always')) window.sctShown();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
