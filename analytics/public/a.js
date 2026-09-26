/**
 * The measurement script, placed on measured sites.
 *
 *   <script defer src="https://analytics.<zone>/a.js"></script>
 *
 * It sends two things and keeps none of them: the page view on load, the time
 * spent on departure. **No cookie, no local storage, no identifier**: nothing
 * is written in the visitor's browser, and that is what exempts the measured
 * site from a consent banner. The visitor's identity is recomputed server side
 * on every page view, from a salt destroyed after two days.
 *
 * It is served as is, without minification: two and a half kilobytes once
 * compressed by Caddy, measured in production on 20 September 2026, and every
 * site that loads it can read it in full to check what it sends. That is an
 * argument to give the customer, not a detail.
 *
 * Written in ES5 and without a dependency: it runs before all the rest of the
 * page and must cost it nothing. An error here would land on customer sites,
 * hence the `try` that wraps everything: a measurement that fails never breaks
 * the page it measures.
 */
(function () {
  "use strict";

  // Nothing from an iframe: a site embedded in a dashboard preview, in an
  // editor or in a third party's page is not being read by someone who came to
  // see it, and an iframe reloaded in a loop would count as many visits as it
  // has refreshes.
  if (window.self !== window.top) return;

  var script = document.currentScript;
  if (!script || !script.src) return;

  var nav = navigator;

  // Two refusals to be tracked that the browser carries itself. Honouring them
  // costs a few percent of measurement; not honouring them would cost the
  // sentence that tells a customer this service respects their visitors.
  if (nav.doNotTrack === "1" || nav.globalPrivacyControl) return;

  var host = location.hostname;

  // Nothing from a development workstation: these page views are not visits,
  // and the host would not be in the service's allow list anyway.
  if (location.protocol === "file:" || host === "localhost" || host === "127.0.0.1") return;

  var endpoint = new URL("e", script.src).href;

  // One draw per page loaded, which only serves to tie the time spent to the
  // page view that preceded it. It does not survive a page reload and is never
  // written anywhere: it is not a visitor identifier.
  var token = (Math.random().toString(36) + Math.random().toString(36))
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);

  /**
   * The send. `sendBeacon` first: it is the only way a browser finishes a
   * request after the page has gone, and it waits for no response. The
   * `text/plain` type avoids the preflight request `application/json` would
   * trigger on every page view.
   */
  function send(body) {
    try {
      var json = JSON.stringify(body);
      if (nav.sendBeacon) {
        nav.sendBeacon(endpoint, new Blob([json], { type: "text/plain" }));
        return;
      }
      fetch(endpoint, {
        method: "POST",
        body: json,
        mode: "no-cors",
        keepalive: true,
        headers: { "Content-Type": "text/plain" },
      }).catch(function () {});
    } catch (e) {
      /* a lost measurement is not worth a broken page */
    }
  }

  try {
    var params = new URLSearchParams(location.search);

    send({
      h: host,
      // The path alone, never the query string: it sometimes carries a reset
      // token or an email address, and none of that has its place in an
      // audience measurement. The two parameters that say a referrer are read
      // here and sent on their own.
      p: location.pathname,
      r: document.referrer,
      s: params.get("utm_source"),
      c: params.get("utm_campaign"),
      // The browser language, of which the service keeps only the primary
      // code: it is the measurement's only clue of origin, and it asks for no
      // geolocation database.
      l: nav.language,
      // The screen width, not the window's: it says the device, and does not
      // move when the visitor resizes.
      w: screen.width,
      j: token,
    });

    // The time spent, counted over visible periods: a tab open in the
    // background is not being read, and counting it would skew every average.
    var start = Date.now();
    var total = 0;
    var visible = document.visibilityState !== "hidden";

    function leave() {
      if (visible) {
        total += Date.now() - start;
        visible = false;
      }
      // Under a second there is nothing to say: an immediate bounce is already
      // counted as a page view.
      if (total >= 1000) send({ j: token, d: Math.round(total / 1000) });
    }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        leave();
      } else if (!visible) {
        visible = true;
        start = Date.now();
      }
    });

    // `pagehide` and not `unload`: on mobile, a page put in the background then
    // killed never receives `unload`, and browsers refuse to send anything from
    // it. Both signals can arrive, and the service keeps the longest one.
    addEventListener("pagehide", leave);
  } catch (e) {
    /* likewise: the measured site comes before the measurement */
  }
})();
