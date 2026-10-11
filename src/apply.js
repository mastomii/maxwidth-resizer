/**
 * Apply engine.
 *
 * Everything is expressed as CSS rules in one <style id="mwr-style"> element,
 * using `!important` so site styles lose. The numeric values live in inline
 * custom properties on <html> (`--mwr-max`, `--mwr-pad`), which is what lets
 * the stylesheet be written once and updated instantly.
 *
 * Every render starts from a clean slate (our rules off, our variables gone)
 * and measures the *natural* layout before deciding anything. That single rule
 * removes a whole class of bugs: a box can never be measured against the width
 * our own cap gave it, so the decision to cap, grow, or back off is always made
 * on the page's own layout.
 */
(function (global) {
  'use strict';

  const doc = () => global.document;

  const VAR_MAX = '--mwr-max';

  const FULL_BLEED = /(full-?bleed|bleed|hero|cover|banner|marquee|carousel|slider|slideshow|gallery|lightbox|map|canvas|video|player|splash|backdrop|scrim|overlay)/i;
  const HARD_SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, IMG: 1, VIDEO: 1, CANVAS: 1, SVG: 1, IFRAME: 1, PICTURE: 1, AUDIO: 1, OBJECT: 1, EMBED: 1, TABLE: 1, CODE: 1, PRE: 1 };

  const HARD_LIMIT = 8;      // max number of nested clamps
  const UNSTICK_LIMIT = 15;

  let current = null;        // { cfg, target, selector, nested, unstuck }

  /* -------------------------------------------------------------- plumbing */

  function styleEl() {
    const d = doc();
    let el = d.getElementById('mwr-style');
    if (!el) {
      el = d.createElement('style');
      el.id = 'mwr-style';
      el.setAttribute('data-mwr', '1');
      (d.head || d.documentElement).appendChild(el);
    }
    return el;
  }

  function rootEl() {
    return doc().documentElement;
  }

  /** Remove every trace of us: rules off, variables gone. */
  function cleanSlate() {
    const el = styleEl();
    el.textContent = '';
    el.disabled = true;
    const root = rootEl();
    root.style.removeProperty(VAR_MAX);
    return el;
  }

  /** Write the cap into the custom property every rule reads from. */
  function setVars(cfg) {
    rootEl().style.setProperty(VAR_MAX, cfg.maxWidth + 'px');
  }

  function isOurNode(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id && el.id.indexOf('mwr-') === 0) return true;
    return !!(el.classList && (el.classList.contains('mwr-toast') || el.classList.contains('mwr-overlay')));
  }

  function viewportWidth() {
    return rootEl().clientWidth || global.innerWidth || 1280;
  }

  /**
   * Width of an element in the page's own layout: our rules off, our variables
   * removed. Restores whatever was live afterwards.
   *
   * Returns the site's own `max-width` as well, and it has to be read in the
   * same pass for a reason: with our rule live, computed style reports *our*
   * value back, so asking later would answer "the site caps this at 900px" when
   * the site never said any such thing.
   */
  function probe(el) {
    const style = doc().getElementById('mwr-style');
    const root = rootEl();
    const savedDisabled = style ? style.disabled : null;
    const savedMax = root.style.getPropertyValue(VAR_MAX);

    if (style) style.disabled = true;
    root.style.removeProperty(VAR_MAX);

    const out = { natural: 0, siteMax: 0 };
    try {
      out.natural = el.getBoundingClientRect().width;
      // Only a px value counts. Computed style hands back percentages and
      // keywords verbatim ("100%", "none"), and parseFloat would turn those into
      // the nonsense caps 100 and NaN.
      const raw = String(global.getComputedStyle(el).maxWidth || '').trim();
      if (/^\d+(\.\d+)?px$/.test(raw)) {
        const max = parseFloat(raw);
        if (Number.isFinite(max) && max > 0) out.siteMax = max;
      }
    } catch (_) {
      /* a detached element: leave the zeroes */
    } finally {
      if (savedMax) root.style.setProperty(VAR_MAX, savedMax);
      if (style && savedDisabled !== null) style.disabled = savedDisabled;
    }
    return out;
  }

  function measureNatural(el) {
    return probe(el).natural;
  }

  /**
   * Run `fn` with our rules and variables out of the way, then restore them.
   *
   * Detection needs this as much as measurement does: with the cap live the
   * geometry it scores is our own doing, and the same page can then resolve to a
   * different box on a second pass. Feeding it the natural layout keeps the
   * decision idempotent, which is what makes re-running on resize or a DOM
   * change safe.
   */
  function natural(fn) {
    const style = doc().getElementById('mwr-style');
    const root = rootEl();
    const savedDisabled = style ? style.disabled : null;
    const savedMax = root.style.getPropertyValue(VAR_MAX);

    if (style) style.disabled = true;
    root.style.removeProperty(VAR_MAX);
    try {
      return fn();
    } finally {
      if (savedMax) root.style.setProperty(VAR_MAX, savedMax);
      if (style && savedDisabled !== null) style.disabled = savedDisabled;
    }
  }

  /* --------------------------------------------------------------- helpers */

  /** Is this element a decorative full-bleed thing that must keep stretching? */
  function isFullBleed(el) {
    const hay = ((el.id || '') + ' ' + String(el.className || '')).slice(0, 300);
    if (!hay.trim()) return false;
    return FULL_BLEED.test(hay);
  }

  /** Would min-width (or a flex/grid parent) stop max-width from taking effect? */
  function needsMinWidthReset(el, style, cap) {
    const min = parseFloat(style.minWidth);
    if (Number.isFinite(min) && min > cap) return true;
    const parent = el.parentElement;
    if (parent) {
      const pdisp = global.getComputedStyle(parent).display || '';
      if (pdisp.includes('flex') || pdisp.includes('grid')) return true;
    }
    return false;
  }

  /**
   * Nested containers inside the column that are wider than the cap.
   *
   * The walk always recurses: a box can be wider than the column even when its
   * parent fits (a fixed-width grid inside a normal panel is the usual case).
   * Once a box is clamped its subtree is skipped, because clamping the
   * outermost offender already fixes everything inside it.
   */
  function findNestedWide(root, cap) {
    const out = [];
    const budget = { n: 0 };
    const limit = cap * 1.04;
    const walk = (el, depth) => {
      if (out.length >= HARD_LIMIT || depth > 14 || budget.n > 4000) return;
      for (const child of el.children) {
        if (out.length >= HARD_LIMIT || budget.n > 4000) return;
        if (isOurNode(child)) continue;
        budget.n++;
        if (HARD_SKIP[child.tagName]) continue;

        let rect;
        try { rect = child.getBoundingClientRect(); } catch (_) { continue; }
        const style = global.getComputedStyle(child);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        if (rect.width <= limit) { walk(child, depth + 1); continue; }

        if (isFullBleed(child) || child.childElementCount < 1 ||
            style.position === 'fixed' ||
            style.display === 'inline' || style.display === 'contents') {
          walk(child, depth + 1);
          continue;
        }

        const mw = parseFloat(style.maxWidth);
        if (Number.isFinite(mw) && mw > 0 && mw <= cap) { walk(child, depth + 1); continue; }

        const text = (child.textContent || '').trim();
        const isFlexGrid = style.display.includes('flex') || style.display.includes('grid');
        const looksContainer = child.childElementCount >= 2 || text.length > 120 || isFlexGrid;
        if (!looksContainer) { walk(child, depth + 1); continue; }

        const sel = global.MWR.selector.buildSelector(child, { root: doc(), maxDepth: 5 });
        if (sel && sel.selector) out.push({ el: child, selector: sel.selector, width: Math.round(rect.width) });
        // clamped: its descendants inherit the new width
      }
    };
    walk(root, 0);
    return out;
  }

  /** Full-width sticky/fixed descendants that look broken once the column narrows. */
  function findUnstick(root) {
    const out = [];
    const vp = viewportWidth();
    const vh = rootEl().clientHeight || global.innerHeight || 800;
    const all = root.querySelectorAll('*');
    const budget = Math.min(all.length, 6000);

    for (let i = 0; i < budget && out.length < UNSTICK_LIMIT; i++) {
      const el = all[i];
      if (isOurNode(el)) continue;

      // Cheap tests first: getBoundingClientRect does not force a style recalc,
      // while getComputedStyle does. Most elements fail the size test, so the
      // expensive call stays rare even on very large pages.
      let rect;
      try { rect = el.getBoundingClientRect(); } catch (_) { continue; }
      if (rect.width < vp * 0.9) continue;
      if (rect.height > vh * 0.9) continue;

      const style = global.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;

      const sel = global.MWR.selector.buildSelector(el, { root: doc(), maxDepth: 5 });
      if (sel && sel.selector) out.push({ el, selector: sel.selector, position: style.position });
    }
    return out;
  }

  /* ---------------------------------------------------------------- render */

  /**
   * Build the column rule plus the unstick rules. Everything here is derived
   * from the *natural* layout, so it is measured before anything is committed.
   */
  function planColumn(target, cfg) {
    const isBody = target === doc().body;
    const style = global.getComputedStyle(target);
    const selector = cfg.selector;
    const probed = probe(target);
    const natural = Math.round(probed.natural);

    // The site's own cap wins when it is tighter than ours: overriding it with
    // !important would *widen* a box the site deliberately keeps narrow.
    const effectiveCap = (probed.siteMax > 0 && probed.siteMax < cfg.maxWidth)
      ? Math.round(probed.siteMax)
      : null;
    const capValue = effectiveCap ? effectiveCap + 'px' : `var(${VAR_MAX})`;

    let css = '';
    const unstuck = [];

    if (isBody) {
      // `<body>` is centered with `margin: auto`, exactly like any other block
      // box, and the `html body` prefix keeps the rule ahead of a plain
      // `body { ... }` from the site when both are `!important`.
      //
      // The earlier version centered <body> with symmetric padding instead,
      // which is actively harmful: under the `box-sizing: border-box` that most
      // sites set globally, that padding is subtracted from the *inside* of the
      // box, so a 1900px viewport with a 1000px cap left a 100px content box and
      // squashed the page's content instead of centering it. Measured: heading
      // 680px -> 141px with padding, versus 448px (correctly centered) with
      // `margin: auto`.
      css += `html body {\n  max-width: ${capValue} !important;\n`;
      if (cfg.center) css += `  margin-left: auto !important;\n  margin-right: auto !important;\n`;
      css += `}\n`;

      // A `min-width` on <body> outranks our `max-width` and would leave the cap
      // silently doing nothing, so reset it exactly as the column branch does.
      if (needsMinWidthReset(target, style, cfg.maxWidth)) {
        css += `html body { min-width: 0 !important; box-sizing: border-box !important; }\n`;
      }
    } else {
      // `max-width` alone, deliberately: capping is a one-way operation.
      //
      // A cap can only ever *narrow* a box. In a flex or grid shell the column's
      // width is whatever the rails leave over, so a cap above that width has
      // nothing to do — and that is correct, not a bug: forcing the column wider
      // than its layout provides would either fight `flex-grow` (the width is
      // ignored) or overflow the shell. The popup reports that ceiling instead
      // of pretending the slider moved something.
      //
      // A `width` rule would also silently widen a column the site keeps narrow
      // on purpose, which is the one thing this extension must never do.
      css += `${selector} {\n  max-width: ${capValue} !important;\n`;
      if (cfg.center) {
        css += `  margin-left: auto !important;\n  margin-right: auto !important;\n`;
        if (style.position === 'fixed' || style.position === 'absolute') {
          css += `  left: 0 !important;\n  right: 0 !important;\n`;
        }
      }
      css += `}\n`;

      if (needsMinWidthReset(target, style, cfg.maxWidth)) {
        css += `${selector} { min-width: 0 !important; box-sizing: border-box !important; }\n`;
      }
    }

    // Full-width bars are detected in the natural layout: once the column is
    // capped they are no longer full-width, so this has to happen up front.
    if (cfg.unstick) {
      const found = findUnstick(target);
      for (const item of found) {
        unstuck.push(item);
        css += `${item.selector} {\n  position: static !important;\n  inset: auto !important;\n  width: 100% !important;\n  max-width: 100% !important;\n}\n`;
      }
    }

    return { css, unstuck, isBody, effectiveCap, natural, siteMax: probed.siteMax };
  }

  /** Nested clamps, as CSS. `found` must have been measured against the capped column. */
  function nestedRules(found, cfg, cap) {
    let css = '';
    let baked = 0;
    for (const item of found) {
      const parentCap = parentContentWidth(item.el);
      const limit = Math.max(200, Math.min(cap, parentCap || cap));
      const itemMax = parseFloat(global.getComputedStyle(item.el).maxWidth);
      let value;
      if (Number.isFinite(itemMax) && itemMax > 0 && itemMax < limit) value = Math.round(itemMax) + 'px';
      else if (Math.abs(limit - cfg.maxWidth) < 1) value = `var(${VAR_MAX})`;
      else value = Math.round(limit) + 'px';
      if (value.indexOf('var(') === -1) baked++;
      css += `${item.selector} {\n  max-width: ${value} !important;\n`;
      if (cfg.center) css += `  margin-left: auto !important;\n  margin-right: auto !important;\n`;
      css += `}\n`;
    }
    return { css, baked };
  }

  /** Width available inside an element's parent (its content box). */
  function parentContentWidth(el) {
    const parent = el && el.parentElement;
    if (!parent || parent === doc().body || parent === doc().documentElement) return 0;
    const style = global.getComputedStyle(parent);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const inner = Math.round(parent.clientWidth - padding);
    return Number.isFinite(inner) && inner > 0 ? inner : 0;
  }

  /**
   * Widest a child can be without overflowing the capped column: the column's
   * content box, not its border box. A 1100px column with 24px of side padding
   * only has 1052px to give, and clamping a nested grid to 1100px would leave
   * it sticking out by exactly the padding.
   */
  function contentCap(target, cfg) {
    if (target === doc().body) return cfg.maxWidth;
    const style = global.getComputedStyle(target);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const inner = Math.round(target.clientWidth - padding);
    if (!Number.isFinite(inner) || inner <= 0) return cfg.maxWidth;
    return Math.max(200, Math.min(cfg.maxWidth, inner));
  }

  /**
   * Some boxes are clamped and still hold content that refuses to shrink (flex
   * items with a fixed basis, wide tables). Let those scroll inside the column
   * instead of spilling across the page.
   */
  function overflowRules(items) {
    let css = '';
    let count = 0;
    for (const item of items) {
      if (!item.el || !item.el.isConnected) continue;
      let over = false;
      try { over = item.el.scrollWidth > item.el.clientWidth + 4; } catch (_) { over = false; }
      if (!over) continue;
      css += `${item.selector} {\n  overflow-x: auto !important;\n}\n`;
      count++;
    }
    return { css, count };
  }

  /**
   * Cap `target` at `cfg.maxWidth`. Safe to call repeatedly: each call starts
   * from a clean slate, so shrinking or switching targets always takes effect.
   *
   * Capping only ever narrows. Raising the cap takes effect too, but only up to
   * the width the layout gives the box: a flex column with rails either side
   * cannot exceed the space they leave. The caller decides *whether* to cap (see
   * MWR.apply.measureNatural); this function renders it and reports what it did.
   *
   * Returns { nested, unstuck, scrolled, width, effectiveCap, innerCap }.
   */
  function render(target, cfg) {
    if (!target || target.nodeType !== 1 || !cfg || !cfg.selector) {
      clear();
      return null;
    }

    const style = cleanSlate();

    // 1. column + unstick rules, measured in the natural layout
    const planned = planColumn(target, cfg);
    style.textContent = planned.css;
    setVars(cfg);
    style.disabled = false;

    // 2. hard mode: now that the column is capped, find what is still too wide
    //    inside it. Measuring here (rather than in the natural layout) is what
    //    keeps the clamp list to the boxes that are genuinely broken.
    let css = planned.css;
    let nested = [];
    let innerCap = cfg.maxWidth;
    let baked = 0;
    if (cfg.hardMode) {
      innerCap = contentCap(target, cfg);
      nested = findNestedWide(target, innerCap);
      const rules = nestedRules(nested, cfg, innerCap);
      css += rules.css;
      baked = rules.baked;
      style.textContent = css;
    }

    // 3. contain anything that still overflows its (now capped) box
    const candidates = [{ el: target, selector: cfg.selector }].concat(nested, planned.unstuck);
    const overflow = overflowRules(planned.isBody ?[] : candidates);
    if (overflow.count) {
      css += overflow.css;
      style.textContent = css;
    }

    markTarget(target);
    current = {
      cfg: Object.assign({}, cfg),
      target,
      selector: cfg.selector,
      nested: nested.length,
      unstuck: planned.unstuck.length,
      scrolled: overflow.count,
      baked,
      natural: planned.natural,
      effectiveCap: planned.effectiveCap,
      siteMax: planned.siteMax
    };
    return {
      nested: current.nested,
      unstuck: current.unstuck,
      scrolled: overflow.count,
      baked,
      width: Math.round(target.getBoundingClientRect().width),
      effectiveCap: planned.effectiveCap || cfg.maxWidth,
      innerCap: Math.round(innerCap)
    };
  }

  /**
   * Live cap update for slider drags.
   *
   * The cheap case is a single style write: every rule reads the cap from the
   * custom property, so changing the variable is enough. Several situations need
   * a full rebuild instead, and all of them return `null` so the caller can do
   * it:
   *
   *  - a nested clamp baked a literal px value in;
   *  - the site's own cap is tighter than the requested one, so the effective
   *    cap is written as a literal px value too;
   *  - the requested cap no longer leaves anything to cap (the box already fits
   *    inside it), which is `evaluate()`'s call to make, not this one's.
   */
  function updateCap(target, cfg, px) {
    if (!current || !current.target || !current.target.isConnected) return null;
    if (current.baked > 0) return null;
    // a site-imposed cap is written as a literal px value, so a cap change
    // cannot be expressed by the variable alone
    if (current.effectiveCap) return null;
    // never let a drag push the box past the site's own cap
    const siteMax = current.siteMax || 0;
    if (siteMax > 0 && px > siteMax) return null;

    const next = Object.assign({}, cfg, { maxWidth: px });

    // Nothing left to cap: the box already fits inside the requested width, so
    // the rule would be dead weight. Hand this back to the full path instead of
    // writing it, because `evaluate()` owns the "already within the limit"
    // decision and would remove the rule anyway. Two paths disagreeing here is
    // how a drag ends up leaving a no-op rule that a re-detection then clears.
    const natural = current.natural || 0;
    if (natural > 0 && natural <= px + 2) return null;

    setVars(next);
    current.cfg = next;
    return {
      nested: current.nested,
      unstuck: current.unstuck,
      scrolled: current.scrolled,
      baked: 0,
      width: Math.round(target.getBoundingClientRect().width),
      effectiveCap: next.maxWidth,
      innerCap: next.maxWidth
    };
  }

  /** Backwards-compatible alias. */
  function apply(target, cfg, info) {
    const summary = render(target, cfg);
    if (info && summary) Object.assign(info, summary);
    return current;
  }

  function markTarget(target) {
    unmarkTarget();
    if (target && target.nodeType === 1) target.setAttribute('data-mwr-root', '1');
  }

  function unmarkTarget() {
    const prev = doc().querySelectorAll('[data-mwr-root]');
    for (const el of prev) el.removeAttribute('data-mwr-root');
  }

  /** Remove every trace of us from the page. */
  function clear() {
    const style = doc().getElementById('mwr-style');
    if (style) {
      style.textContent = '';
      style.disabled = false;
    }
    rootEl().style.removeProperty(VAR_MAX);
    unmarkTarget();
    current = null;
  }

  function state() {
    return current ? Object.assign({}, current) : null;
  }

  function target() {
    return current ? current.target : null;
  }

  global.MWR.apply = {
    render,
    updateCap,
    apply,
    clear,
    state,
    target,
    planColumn,
    measureNatural,
    natural,
    contentCap,
    isFullBleed,
    findNestedWide,
    findUnstick,
    viewportWidth
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
