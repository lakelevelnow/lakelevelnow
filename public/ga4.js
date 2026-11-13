/* GA4 funnel: public page context and allowlisted product metadata only.
   Checkout clicks express intent, never confirmed payment. */
(function () {
  'use strict';
  var script = document.currentScript;
  var measurementId = script && script.getAttribute('data-measurement-id');
  if (!/^G-[A-Z0-9]+$/.test(measurementId || '') || window.__siteGA4) return;
  // CRO 2026-11-13: production hostnames only. Previews (*.workers.dev, *.pages.dev, github.io),
  // localhost and 127.0.0.1 never send hits, so QA traffic cannot reach the GA4 property.
  if (!/^(www\.)?(lakelevelnow|ingredientcalculator)\.com$/.test(location.hostname)) return;
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  window.__siteGA4 = true;
  var lake = script.getAttribute('data-site') === 'lakelevelnow';
  var site = lake ? 'lakelevelnow' : 'ingredientcalculator';
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var cleanLocation = location.origin + location.pathname;
  var referrer = '';
  try { referrer = document.referrer ? new URL(document.referrer).origin + '/' : ''; } catch (_) {}
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  var gtag = window.gtag;
  gtag('js', new Date());
  // Internal traffic (CRO 2026-11-06 R2). ?traffic_type=internal marks this browser for 30 days,
  // ?traffic_type=clear removes the mark. GA4 data filters drop traffic_type=internal.
  var internal = false;
  try {
    var tq = new URLSearchParams(location.search).get('traffic_type');
    if (tq === 'internal') localStorage.setItem('lln_internal_v1', String(Date.now()));
    if (tq === 'clear') localStorage.removeItem('lln_internal_v1');
    var mark = Number(localStorage.getItem('lln_internal_v1') || 0);
    internal = mark > 0 && Date.now() - mark < 2592000000;
  } catch (_) { internal = /[?&]traffic_type=internal\b/.test(location.search); }
  var tt = internal ? { traffic_type: 'internal' } : {};
  gtag('config', measurementId, Object.assign({
    send_page_view: false,
    page_location: cleanLocation,
    page_referrer: referrer,
    allow_google_signals: false,
    allow_ad_personalization_signals: false
  }, tt));
  var once = Object.create(null);
  var campaign = {};
  var query = new URLSearchParams(location.search);
  ['source', 'medium', 'campaign', 'id'].forEach(function (field) {
    var value = query.get('utm_' + field);
    // Campaign names must be short public tokens; reject free text and contact data.
    if (value && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) campaign['campaign_' + (field === 'campaign' ? 'name' : field)] = value;
  });
  function event(name, params, key) {
    if (key && once[key]) return;
    if (key) once[key] = true;
    gtag('event', name, Object.assign({ send_to: measurementId, site_name: site,
      page_location: cleanLocation, page_referrer: referrer, transport_type: 'beacon' }, tt, campaign, params || {}));
  }
  event('page_view', {}, 'page_view');
  // Same-site click hand-over (CRO 2026-11-06). gtag can hold an event for seconds, so a click
  // that opens another page of this site lost its select_content. The click stores it and this
  // page sends it, with the page_location of the page where the click happened.
  var HAND = 'lln_ga4_next_v1';
  try {
    var held = sessionStorage.getItem(HAND);
    if (held) {
      sessionStorage.removeItem(HAND);
      var hs = JSON.parse(held);
      (Array.isArray(hs) ? hs : [hs]).forEach(function (h) {
        if (h && (h.n === 'select_content' || h.n === 'cta_click' || h.n === 'mm_cta_click') && h.p && Date.now() - h.t < 60000) event(h.n, h.p);
      });
    }
  } catch (_) {}
  function sendOrHand(anchor, name, params) {
    var sameSite = false;
    try { sameSite = new URL(anchor.href, location.href).origin === location.origin && anchor.target !== '_blank'; } catch (_) {}
    if (sameSite) {
      try {
        var list = [];
        try { list = JSON.parse(sessionStorage.getItem(HAND) || '[]'); if (!Array.isArray(list)) list = [list]; } catch (_) { list = []; }
        list.push({ n: name, t: Date.now(), p: Object.assign({ page_location: cleanLocation }, params) });
        sessionStorage.setItem(HAND, JSON.stringify(list.slice(-4)));
        return;
      } catch (_) {}
    }
    event(name, params);
  }
  // Invoked only by the return page after its existing paid-verification response.
  // Persist the transaction identifier alone; never pass licenses or customer fields.
  var paidSeen = new Set();
  // Each return page may report only its own items. /posters/thanks (sku llp) since 2026-11-08.
  var purchasePages = lake ? { '/almanac/thanks': ['almanac_single', 'almanac_bundle'], '/posters/thanks': ['llp'] }
    : { '/welcome': ['ingredientcalculator_pro'] };
  window.__siteGA4Purchase = function (receipt, requestedSession) {
    var allowed = Object.prototype.hasOwnProperty.call(purchasePages, path) ? purchasePages[path] : null;
    if (!allowed || !receipt ||
        !/^cs_live_[A-Za-z0-9]+$/.test(requestedSession || '') ||
        receipt.transaction_id !== requestedSession || receipt.payment_status !== 'paid' ||
        receipt.amount_unit !== 'stripe_minor') return;
    if (allowed.indexOf(receipt.item_id) < 0 || paidSeen.has(requestedSession)) return;
    var key = 'ga4_purchase_' + site + '_' + requestedSession;
    try { if (localStorage.getItem(key)) return; } catch (_) {}
    var params = { transaction_id: requestedSession, payment_verified: true, revenue_status: 'not_reported' };
    var currency = String(receipt.currency || '').toUpperCase();
    // Explicit supported charge units. Unknown currencies retain a count without guessed money.
    var divisor = /^(USD|EUR|GBP|PLN|CAD|AUD|NZD|CHF|SEK|NOK|DKK|SGD|HKD|INR|BRL|MXN|ZAR)$/.test(currency) ? 100 : /^(JPY|KRW)$/.test(currency) ? 1 : 0;
    var amounts = [receipt.amount_total, receipt.amount_tax, receipt.amount_shipping];
    if (divisor && amounts.every(function (v) { return Number.isSafeInteger(v) && v >= 0; }) &&
        receipt.amount_tax + receipt.amount_shipping <= receipt.amount_total) {
      params.currency = currency;
      params.value = (receipt.amount_total - receipt.amount_tax - receipt.amount_shipping) / divisor;
      params.tax = receipt.amount_tax / divisor;
      params.shipping = receipt.amount_shipping / divisor;
      params.revenue_status = 'verified';
      params.items = [{ item_id: receipt.item_id, price: params.value, quantity: 1 }];
    }
    paidSeen.add(requestedSession);
    event('purchase', params);
    try { localStorage.setItem(key, '1'); } catch (_) {}
  };
  // Waitlist fake-door test (WaitlistTest.astro). Three event names and four token params
  // only, so a caller can never send an email address or free text. Defined after the
  // DNT/GPC return above, so opted-out browsers never get it.
  // Mobile money run 2026-11-08: mm_cta_view and mm_cta_click carry a product sku and a
  // placement token (PosterOffer.astro, /posters/). Same allowlist rules, sku instead of offer_id.
  // Sprint 2026-11-13: offer_view and cta_click for the paid-at-launch alerts waitlist, with site, product, price, currency.
  var promoNames = ['view_promotion', 'select_promotion', 'generate_lead', 'mm_cta_view', 'mm_cta_click', 'offer_view', 'cta_click'];
  var promoKeys = ['offer_id', 'ab_variant', 'lake_slug', 'placement', 'sku', 'site', 'product'];
  window.__siteGA4Event = function (name, params, anchor) {
    if (promoNames.indexOf(name) < 0 || !params || typeof params !== 'object') return false;
    var clean = {};
    for (var i = 0; i < promoKeys.length; i++) {
      var k = promoKeys[i];
      var v = Object.prototype.hasOwnProperty.call(params, k) ? params[k] : null;
      if (typeof v === 'string' && /^[a-z0-9_-]{1,40}$/.test(v)) clean[k] = v;
    }
    if (params.currency === 'USD' && typeof params.price === 'number' && params.price > 0 && params.price < 10000) { clean.currency = 'USD'; clean.price = params.price; clean.value = params.price; }
    var mm = name.indexOf('mm_') === 0;
    if (mm ? !clean.sku : !clean.offer_id) return false;
    // A click that opens another page of this site is handed to that page, like cta_click.
    if (name === 'mm_cta_click' && anchor && anchor.href) { sendOrHand(anchor, name, clean); return true; }
    event(name, clean, name === 'generate_lead' || name === 'mm_cta_click' ? null :
      name + ':' + (mm ? clean.sku : clean.offer_id) + ':' + (clean.placement || ''));
    return true;
  };
  document.dispatchEvent(new Event('site-ga4-ready'));
  var tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
  document.head.appendChild(tag);
  var products = lake ? {
    'eVqeVe6Eq4Jy5NP2st43S0L': { item_id: 'llp', item_name: 'Lake Mead and Lake Powell Water Level Posters', price: 9, quantity: 1 },
    '00w3cw2oafoc7VXgjj43S0q': { item_id: 'almanac_single', item_name: 'Lake Level Almanac single', price: 19, quantity: 1 },
    '4gM5kE1k63Fugst0kl43S0B': { item_id: 'almanac_bundle', item_name: 'Lake Level Almanac bundle', price: 79, quantity: 1 },
    '4gMfZi3se1xm3FHaYZ43S0M': { item_id: 'lld', item_name: 'Lake directory listing 12 months', price: 199, quantity: 1 }
  } : {
    'cNieVe7Iu3Fuccd3wx43S0A': { item_id: 'ingredientcalculator_pro', item_name: 'IngredientCalculator Pro', price: 79, quantity: 1 }
  };
  function productFor(anchor) {
    try {
      var url = new URL(anchor.href, location.href);
      return url.hostname === 'buy.stripe.com' ? products[url.pathname.slice(1)] : null;
    } catch (_) { return null; }
  }
  function placement(anchor) {
    var section = anchor.closest('[data-alm-place], [data-mt-paywall], header, footer, nav');
    if (!section) return 'content';
    var place = section.getAttribute('data-alm-place');
    return /^[a-z0-9-]{1,40}$/.test(place || '') ? place : section.hasAttribute('data-mt-paywall') ? 'paywall' : section.tagName.toLowerCase();
  }
  // CTA id from data-cta (placement_target scheme). Token only, never free text.
  function ctaId(anchor) {
    var id = anchor && anchor.getAttribute ? anchor.getAttribute('data-cta') : '';
    return /^[a-z0-9_-]{1,40}$/.test(id || '') ? { cta_id: id } : {};
  }
  function payload(product, anchor) {
    var anchorLake = anchor.getAttribute('data-lake');
    var lakeSlug = /^[a-z0-9-]{1,40}$/.test(anchorLake || '') ? anchorLake :
      /^\/lake\/[a-z0-9-]+$/.test(path) ? path.split('/')[2] : '';
    return Object.assign({ currency: 'USD', value: product.price, items: [product], placement: placement(anchor),
      ...(lake && lakeSlug && product.item_id === 'almanac_single' ? { lake_slug: lakeSlug } : {}) }, ctaId(anchor));
  }
  if (lake ? path === '/almanac' : path === '/pro' || path === '/kitchen-pack') {
    event('pricing_view', { content_id: lake ? 'almanac' : 'ingredientcalculator_pro' }, 'pricing_view');
  }
  if (lake && path === '/almanac/sample') event('sample_view', { content_id: 'almanac_sample' }, 'sample_view');
  document.addEventListener('toggle', function (ev) {
    var detail = ev.target;
    if (!lake || !detail || !detail.matches || !detail.matches('details[data-alm-sample]') || !detail.open) return;
    var slug = detail.getAttribute('data-alm-sample');
    if (!/^[a-z0-9-]{1,40}$/.test(slug || '')) return;
    event('sample_open', { content_id: slug, placement: 'pine-flat-sample' }, 'sample_open:' + slug);
  }, true);
  function onOfferClick(ev) {
    var anchor = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!anchor || anchor.getAttribute('aria-disabled') === 'true') return;
    // cta_click for every CTA with an id (CRO 2026-11-06 R2). Sent before the product events.
    var cid = ctaId(anchor);
    if (cid.cta_id) {
      var cnow = Date.now();
      if (cnow - (Number(anchor.dataset && anchor.dataset.gaCtaT) || 0) >= 1000) {
        if (anchor.dataset) anchor.dataset.gaCtaT = String(cnow);
        sendOrHand(anchor, 'cta_click', Object.assign({ placement: placement(anchor) }, cid));
      }
    }
    // Lake sponsor slot (house ad or a paid sponsor): count the click so each sponsor can
    // get its monthly click number. Slug and kind only, never the destination URL.
    var spon = anchor.getAttribute('data-spon');
    if (lake && /^[a-z0-9-]{1,40}$/.test(spon || '')) {
      sendOrHand(anchor, 'select_content', Object.assign({ content_type: 'sponsor_slot', content_id: spon,
        placement: anchor.getAttribute('data-spon-kind') === 'paid' ? 'sponsor' : 'house_ad' }, ctaId(anchor)));
      return;
    }
    var product = productFor(anchor);
    if (product) {
      // One begin_checkout per link per 3 s: a double click must not count twice.
      var now = Date.now();
      var ds = anchor.dataset || {};
      if (now - (Number(ds.gaCoT) || 0) < 3000) return;
      if (anchor.dataset) anchor.dataset.gaCoT = String(now);
      var checkout = payload(product, anchor);
      var attempt = anchor.dataset && anchor.dataset.checkoutAttemptId;
      if (lake && /^[a-f0-9]{32}$/.test(attempt || '')) checkout.checkout_attempt_id = attempt;
      // Fast click (CRO 2026-11-06 R4). Before gtag.js has loaded, a click that leaves for Stripe
      // lost every queued hit. Hold the same-tab navigation until GA4 confirms the hit, at most
      // 1.5 s, then always go. Once gtag.js is loaded the beacon is enough and nothing waits.
      var ready = !!(window.google_tag_manager && window.google_tag_manager[measurementId]);
      var plain = ev.type === 'click' && ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey &&
        !ev.defaultPrevented && (!anchor.target || anchor.target === '_self');
      if (!ready && plain) {
        ev.preventDefault();
        var gone = false;
        var go = function () { if (gone) return; gone = true; location.assign(anchor.href); };
        checkout.event_callback = go;
        checkout.event_timeout = 1500;
        setTimeout(go, 1600);
      }
      event('begin_checkout', checkout);
      return;
    }
    var url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    var target = url.pathname.replace(/\/+$/, '');
    var intent = lake ? target === '/almanac' || target === '/almanac/sample' : target === '/pro' || target === '/kitchen-pack';
    if (intent && !once['select:' + target]) {
      once['select:' + target] = true;
      sendOrHand(anchor, 'select_content', Object.assign({ content_type: 'paid_offer', content_id: target,
        placement: placement(anchor) }, ctaId(anchor)));
    }
  }
  document.addEventListener('click', onOfferClick, true);
  // Middle-click opens the offer in a new tab: count it like a click.
  document.addEventListener('auxclick', function (ev) { if (ev.button === 1) onOfferClick(ev); }, true);
  function observeOffers() {
    if (!window.IntersectionObserver) return;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.5) return;
        var product = productFor(entry.target);
        if (product) {
          var offer = payload(product, entry.target);
          event('view_item', offer, 'offer:' + product.item_id + ':' + offer.placement + ':' + (offer.lake_slug || 'bundle'));
        }
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.5 });
    var observed = new WeakSet();
    function register(root) {
      var anchors = root.matches && root.matches('a[href]') ? [root] : [];
      if (root.querySelectorAll) anchors = anchors.concat(Array.from(root.querySelectorAll('a[href]')));
      anchors.forEach(function (anchor) {
        if (!observed.has(anchor) && productFor(anchor)) {
          observed.add(anchor);
          observer.observe(anchor);
        }
      });
    }
    register(document);
    // Paywalls can render after an asynchronous license check.
    new MutationObserver(function (records) {
      records.forEach(function (record) { record.addedNodes.forEach(register); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeOffers, { once: true });
  else observeOffers();
})();
