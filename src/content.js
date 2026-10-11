/**
 * Content orchestrator.
 *
 * Owns the lifecycle: load config -> resolve a target -> render the cap ->
 * keep it alive across SPA navigations, resizes and DOM churn -> expose an API
 * the popup/background talk to.
 *
 * The single rule that keeps this predictable: every evaluation starts by
 * asking "how wide would this box be *without* us?" (measureNatural), and then
 * decides. Nothing is ever measured against the width our own cap produced —
 * detection runs in that same natural layout, so repeated evaluation settles on
 * the same element instead of drifting between boxes.
 *
 * Capping narrows, never widens: a box that already fits inside the cap is left
 * alone, whether the site capped it or the layout simply left it little room.
 * When the cap sits above what the layout can provide, the status reports the
 * width actually reached rather than the one that was requested.
 */
(function (global) {
  'use strict';

  const MWR = global.MWR;
  if (!MWR || !MWR.apply) return;

  const DEBOUNCE = 300;          // ms after DOM churn / resize
  const URL_POLL = 900;          // ms, detects SPA route changes
  const REDETECT_COOLDOWN = 1200;

  let cfg = null;
  let targetEl = null;
  let targetInfo = null;         // { label, selector, reason, mode }
  let status = blankStatus();
  let url = location.href;
  let debounceTimer = 0;
  let urlTimer = 0;
  let lastDetect = 0;
  let booted = false;
  let observer = null;

  function blankStatus() {
    return {
      applied: false, label: null, reason: null, width: null, cap: null,
      nested: 0, unstuck: 0, scrolled: 0, selector: null, error: null
    };
  }

  function host() {
    return MWR.siteKey(location.hostname);
  }

  /* ------------------------------------------------------------------ state */

  function publicState() {
    const c = cfg || MWR.storage.resolve(location.hostname);
    return {
      host: host(),
      href: location.href,
      cfg: {
        enabled: c.enabled,
        maxWidth: c.maxWidth,
        mode: c.mode,
        scope: c.scope,
        center: c.center,
        hardMode: c.hardMode,
        unstick: c.unstick,
        minWidth: c.minWidth
      },
      hasRule: !!c.hasRule,
      target: targetInfo ? Object.assign({}, targetInfo) : (c.target || null),
      status: Object.assign({}, status),
      defaults: MWR.storage.getSettings()
    };
  }

  /* ------------------------------------------------------------------- pick */

  /** Find the element to limit: stored target first, smart detection second. */
  function resolveTarget(config) {
    const stored = config.target && config.target.selector ? config.target : null;
    if (stored) {
      const found = MWR.selector.resolveSelector(stored.selector);
      if (found && found.element) {
        return {
          element: found.element,
          selector: stored.selector,
          label: MWR.selector.describe(found.element),
          reason: 'stored-rule',
          mode: 'manual'
        };
      }
    }

    // Detection scores geometry, so it has to see the page as the site built it.
    // With our cap still live the column already looks narrow and a different
    // box wins, which would make repeated evaluation drift from one target to
    // another.
    const result = MWR.apply.natural(() => MWR.detector.detect({ maxWidth: config.maxWidth }));
    if (!result.ok || !result.element) return { element: null, reason: result.reason || 'no-target' };

    // The `page` scope widens the target from the content column up to the page
    // shell, so the cap also covers whatever sits beside the column (nav rail,
    // sidebar). Only auto-detection is widened: a manually picked element is an
    // explicit instruction and is honoured as given.
    let element = result.element;
    let reason = result.reason || 'auto-detect';
    if (config.scope === 'page') {
      const shell = MWR.apply.natural(() => MWR.detector.pageShell(element, MWR.detector.viewport()));
      if (shell && shell !== element && shell !== global.document.body) {
        element = shell;
        reason = 'page-shell';
      }
    }

    const built = MWR.selector.buildSelector(element, { root: global.document });
    return {
      element,
      selector: built ? built.selector : null,
      label: MWR.selector.describe(element),
      reason,
      mode: 'auto'
    };
  }

  /* ---------------------------------------------------------------- evaluate */

  /**
   * The one path that decides everything. Idempotent: calling it twice in a row
   * leaves the page in the same state.
   */
  function evaluate(reason) {
    const doc = global.document;
    if (!cfg || !doc.body) return;

    // 1. switched off
    if (!cfg.enabled) {
      MWR.apply.clear();
      targetEl = null;
      targetInfo = null;
      status = blankStatus();
      status.reason = 'disabled';
      return;
    }

    // 2. the window is already narrower than the cap: stay out of the way
    const vp = MWR.apply.viewportWidth();
    if (vp && vp <= cfg.maxWidth + 2) {
      MWR.apply.clear();
      targetEl = null;
      targetInfo = null;
      status = blankStatus();
      status.reason = 'viewport-narrower';
      status.width = vp;
      return;
    }

    // 3. which box?
    const picked = resolveTarget(cfg);
    if (!picked.element || !picked.selector) {
      MWR.apply.clear();
      targetEl = null;
      targetInfo = null;
      status = blankStatus();
      status.reason = picked.reason || 'no-target';
      status.error = picked.selector ? 'no-target' : (picked.element ? 'unselectable' : 'no-target');
      return;
    }

    // 4. how wide would it be without us?
    //
    // The extension only ever narrows; it never widens a box. So a column that
    // already fits inside the cap is left completely alone — whether it is
    // narrow because the site caps it (`max-width: 720px`), because the layout
    // leaves it little room (a flex shell with rails either side), or simply
    // because the window is small. Widening a deliberately narrow column is a
    // different feature, and forcing it here would fight the site's own design.
    const natural = Math.round(MWR.apply.measureNatural(picked.element));
    if (natural > 0 && natural <= cfg.maxWidth + 2) {
      MWR.apply.clear();
      targetEl = null;
      targetInfo = null;
      status = blankStatus();
      status.reason = 'already-within';
      status.label = picked.label;
      status.width = natural;
      status.cap = cfg.maxWidth;
      return;
    }

    // 5. render
    //
    // Unstick is deliberately suppressed under the `page` scope: its job is to
    // bring a full-width sticky bar inside the column back into flow, but with
    // the shell capped the page's own header would be torn out of its sticky
    // position — a far worse break than a bar that keeps its own width.
    const renderCfg = Object.assign({}, cfg, {
      selector: picked.selector,
      unstick: cfg.unstick && cfg.scope !== 'page'
    });
    const summary = MWR.apply.render(picked.element, renderCfg);
    targetEl = picked.element;
    targetInfo = { label: picked.label, selector: picked.selector, reason: picked.reason, mode: picked.mode, scope: cfg.scope };
    status = {
      applied: true,
      label: picked.label,
      reason: reason || picked.reason,
      width: summary ? summary.width : natural,
      cap: summary && summary.effectiveCap ? summary.effectiveCap : cfg.maxWidth,
      // A cap above the box's natural width changes nothing: the layout, not the
      // site's CSS, is what stops it. Say so rather than implying the slider did
      // something it did not.
      ceiling: summary && summary.width + 2 < (summary.effectiveCap || cfg.maxWidth) ? summary.width : 0,
      nested: summary ? summary.nested : 0,
      unstuck: summary ? summary.unstuck : 0,
      scrolled: summary ? summary.scrolled : 0,
      selector: picked.selector,
      error: null
    };
    // the popup phrases this as "capped at Npx", so it must always be a number
    if (!status.cap) status.cap = cfg.maxWidth;
    if (picked.mode === 'manual') status.reason = reason || 'picked';
  }

  /**
   * Fast path for slider drags: only the cap changes.
   *
   * Reuses the already-resolved target and skips detection entirely, so a drag
   * costs one style write instead of a full DOM scan. Falls back to a full
   * evaluation when the geometry actually has to be re-derived (hard mode with
   * a literal nested value, or no target yet).
   */
  function evaluateCap(px) {
    if (!cfg) return;
    cfg.maxWidth = px;

    if (!cfg.enabled) return;

    const vp = MWR.apply.viewportWidth();
    if (vp && vp <= cfg.maxWidth + 2) {
      MWR.apply.clear();
      targetEl = null;
      targetInfo = null;
      status = blankStatus();
      status.reason = 'viewport-narrower';
      status.width = vp;
      status.cap = cfg.maxWidth;
      return;
    }

    const live = targetEl && targetEl.isConnected && targetInfo && targetInfo.selector;
    if (live) {
      const quick = MWR.apply.updateCap(targetEl, Object.assign({}, cfg, { selector: targetInfo.selector }), cfg.maxWidth);
      if (quick) {
        status = {
          applied: true,
          label: targetInfo.label,
          reason: 'preview',
          width: quick.width,
          cap: quick.effectiveCap,
          ceiling: quick.width + 2 < quick.effectiveCap ? quick.width : 0,
          nested: quick.nested,
          unstuck: quick.unstuck,
          scrolled: quick.scrolled,
          selector: targetInfo.selector,
          error: null
        };
        return;
      }
    }

    evaluate('preview');
  }

  function scheduleEvaluate(reason, delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        evaluate(reason);
      } catch (err) {
        status.error = String((err && err.message) || err);
      }
    }, delay == null ? DEBOUNCE : delay);
  }

  /* ------------------------------------------------------------- keep alive */

  function onDomChurn() {
    if (!cfg || !cfg.enabled) return;
    if (!targetEl || !targetEl.isConnected) {
      const now = Date.now();
      if (now - lastDetect < REDETECT_COOLDOWN) {
        scheduleEvaluate('redetect', REDETECT_COOLDOWN);
        return;
      }
      lastDetect = now;
      scheduleEvaluate('redetect');
      return;
    }
    // Target still there. Re-rendering is cheap and idempotent, and it is what
    // keeps the cap correct when the app swaps in a differently sized shell.
    scheduleEvaluate('churn');
  }

  function startWatchers() {
    const doc = global.document;
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'childList' && (rec.addedNodes.length || rec.removedNodes.length)) { onDomChurn(); return; }
        if (rec.type === 'attributes') {
          const name = rec.attributeName || '';
          if (name === 'class' || name === 'style' || name === 'hidden') { onDomChurn(); return; }
        }
      }
    });
    observer.observe(doc.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden']
    });

    global.addEventListener('resize', () => scheduleEvaluate('resize', 180), { passive: true });

    clearInterval(urlTimer);
    urlTimer = setInterval(() => {
      if (location.href === url) return;
      url = location.href;
      lastDetect = Date.now();
      scheduleEvaluate('navigate', 220);
    }, URL_POLL);
  }

  /* ------------------------------------------------------------------- boot */

  async function boot() {
    await MWR.storage.load();
    MWR.storage.onChange(() => {
      cfg = MWR.storage.resolve(location.hostname);
      scheduleEvaluate('settings', 0);
    });
    cfg = MWR.storage.resolve(location.hostname);
    booted = true;
    if (global.document.body) evaluate('initial');
    else global.document.addEventListener('DOMContentLoaded', () => evaluate('initial'), { once: true });
    startWatchers();
  }

  /* ------------------------------------------------------------------- API */

  const handlers = {
    'mwr:getState': () => publicState(),

    'mwr:set': (msg) => {
      if (!cfg) return publicState();
      const patch = Object.assign({}, msg.patch || {});
      const nextTarget = patch.target;
      delete patch.target;
      Object.assign(cfg, patch);
      if (nextTarget !== undefined) cfg.target = nextTarget;
      // Editing a setting is an action, so it is remembered — but only for a
      // site that is actually on. While a site is off nothing is written, so a
      // fresh install leaves storage empty until the first deliberate switch-on.
      if (cfg.enabled) MWR.storage.saveForSite(location.hostname, cfg, { target: cfg.target });
      lastDetect = Date.now();
      evaluate(nextTarget !== undefined ? 'picked' : 'popup');
      return publicState();
    },

    'mwr:toggle': (msg) => {
      if (!cfg) return publicState();
      cfg.enabled = typeof msg.enabled === 'boolean' ? msg.enabled : !cfg.enabled;
      // Nothing is written to storage until the user actually turns the site on.
      // Switching back off when the site still follows the defaults removes the
      // rule instead of storing an "off" one, so a site the user tried once
      // leaves no trace behind.
      if (cfg.enabled) {
        MWR.storage.saveForSite(location.hostname, cfg);
      } else {
        MWR.storage.releaseIfDefault(location.hostname, cfg);
      }
      lastDetect = Date.now();
      evaluate('toggle');
      return publicState();
    },

    'mwr:preview': (msg) => {
      if (!cfg) return publicState();
      if (typeof msg.maxWidth === 'number') {
        evaluateCap(MWR.clamp(Math.round(msg.maxWidth), MWR.LIMITS.min, MWR.LIMITS.max));
      }
      return publicState();
    },

    'mwr:redetect': () => {
      if (cfg && cfg.target) {
        cfg.target = null;
        MWR.storage.saveForSite(location.hostname, cfg, { target: null });
      }
      lastDetect = Date.now();
      evaluate('redetect');
      return publicState();
    },

    'mwr:clearSite': () => {
      MWR.storage.removeSiteRule(location.hostname);
      cfg = MWR.storage.resolve(location.hostname);
      lastDetect = Date.now();
      evaluate('reset');
      return publicState();
    },

    'mwr:pick': () => {
      MWR.toast.show({ title: 'Pick the content box', sub: 'Hover, use ↑/↓, then click.', badge: 'PICK', timeout: 2200 });
      MWR.picker.start({
        onPick: (el) => {
          const built = MWR.selector.buildSelector(el, { root: global.document });
          if (!built) {
            MWR.toast.show({ title: 'Could not build a selector', sub: 'Try a different element.', tone: 'warn', badge: 'WARN' });
            return;
          }
          lastDetect = Date.now();
          handlers['mwr:set']({
            patch: { mode: 'manual', enabled: true, target: { selector: built.selector, label: built.label, score: built.score } }
          });
          MWR.toast.show({
            title: 'Limiting ' + built.label,
            sub: 'Capped at ' + cfg.maxWidth + 'px',
            badge: 'MAX'
          });
        },
        onCancel: () => MWR.toast.show({ title: 'Picker cancelled', tone: 'off', badge: 'OFF', timeout: 1400 })
      });
      return { picking: true };
    },

    'mwr:ping': () => ({ pong: true, booted })
  };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('mwr:') !== 0) return;
      const handler = handlers[msg.type];
      if (!handler) return;
      const run = async () => {
        if (!booted && msg.type !== 'mwr:ping') {
          await new Promise((resolve) => {
            if (booted) return resolve();
            const t = setInterval(() => { if (booted) { clearInterval(t); resolve(); } }, 30);
            setTimeout(() => { clearInterval(t); resolve(); }, 1500);
          });
        }
        return handler(msg);
      };
      run().then((res) => sendResponse({ ok: true, data: res }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;
    });
  }

  MWR.content = { publicState, evaluate, evaluateCap, scheduleEvaluate, boot, handlers };

  boot().catch(() => {});
})(typeof globalThis !== 'undefined' ? globalThis : this);
