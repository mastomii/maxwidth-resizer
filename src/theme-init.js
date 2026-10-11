/**
 * Applies the stored appearance choice before the page paints.
 *
 * Loaded as the first script in <head>. The page is hidden by CSS until the
 * attribute is set (see theme.css), so switching to dark never flashes a light
 * page first — and the timeout guarantees the page appears even if storage is
 * unavailable, which is the one failure mode worth designing against here.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var done = false;

  function ready() {
    if (done) return;
    done = true;
    root.setAttribute('data-theme-ready', '');
  }

  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      ready();
      return;
    }
    chrome.storage.local.get(['settings'], function (raw) {
      var mode = raw && raw.settings && raw.settings.appearance;
      if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
      ready();
    });
    setTimeout(ready, 250);
  } catch (_) {
    ready();
  }
})();
