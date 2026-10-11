/**
 * Builds a stable, human-readable CSS selector for an element, plus a lookup
 * that tries progressively weaker strategies until it finds a match.
 */
(function (global) {
  'use strict';

  const TEST_ID = /(^|[-_])(test|spec|e2e)([-_]|$)/i;

  /** Does this id look like generated/hashed noise rather than a real name? */
  function looksGeneratedId(id) {
    if (!id || id.length > 40) return true;
    if (/^\d/.test(id)) return true;
    if (TEST_ID.test(id)) return true;
    if (/^[0-9a-f]{8,}$/i.test(id)) return true;
    // mixed-case random looking strings: xK3vQ9Lm
    if (/^[A-Za-z0-9]{8,}$/.test(id) && /[a-z]/.test(id) && /[A-Z]/.test(id) && /\d/.test(id)) return true;
    return false;
  }

  function cssEscape(value) {
    const str = String(value);
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(str);
    return str.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  }

  function isStableClass(cls) {
    if (!cls || cls.length > 40) return false;
    if (cls.startsWith('mwr-')) return false;
    if (/^css-[a-z0-9]+$/i.test(cls)) return false;          // emotion
    if (/^sc-[a-zA-Z0-9]+$/.test(cls)) return false;          // styled-components
    if (/^jsx-\d+$/.test(cls)) return false;                  // styled-jsx
    if (/^_[a-zA-Z0-9]{5,}$/.test(cls)) return false;         // css modules
    if (/-[0-9a-f]{5,}$/i.test(cls)) return false;             // hashed suffix
    if (/^\d/.test(cls)) return false;
    return true;
  }

  /** nth-of-type style segment so a selector stays unique among siblings. */
  function nthSegment(el) {
    const parent = el.parentElement;
    if (!parent) return null;
    const tag = el.tagName.toLowerCase();
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (same.length <= 1) return tag;
    return `${tag}:nth-of-type(${same.indexOf(el) + 1})`;
  }

  function uniqueInDocument(selector, root) {
    const scope = root || global.document;
    try {
      const found = scope.querySelectorAll(selector);
      return found.length === 1 ? found[0] : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Best-effort unique selector for `el`.
   * Returns { selector, strategy, label, score }.
   */
  function buildSelector(el, options) {
    const opts = options || {};
    if (!el || el.nodeType !== 1) return null;

    const doc = el.ownerDocument || global.document;
    const root = opts.root || doc;

    // html / body have no useful path selector
    if (el === doc.body || el === doc.documentElement) {
      const sel = el === doc.body ? 'body' : 'html';
      return { selector: sel, strategy: 'tag', label: sel, score: 40 };
    }

    // 1. stable id
    if (el.id && !looksGeneratedId(el.id)) {
      const sel = '#' + cssEscape(el.id);
      if (uniqueInDocument(sel, root) === el) {
        return { selector: sel, strategy: 'id', label: describe(el), score: 100 };
      }
    }

    // 2. data-testid style attributes
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-qa']) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (value && value.length < 60) {
        const sel = `[${attr}="${value.replace(/"/g, '\\"')}"]`;
        if (uniqueInDocument(sel, root) === el) {
          return { selector: sel, strategy: attr, label: describe(el), score: 95 };
        }
      }
    }

    // 3. tag + stable classes
    const classes = Array.from(el.classList ||[]).filter(isStableClass);
    if (classes.length) {
      const sel = el.tagName.toLowerCase() + '.' + classes.slice(0, 3).map(cssEscape).join('.');
      const hit = uniqueInDocument(sel, root);
      if (hit === el) return { selector: sel, strategy: 'class', label: describe(el), score: 90 };
      // class path may need an ancestor to disambiguate
      const scoped = scopedWithAncestor(el, classes.slice(0, 2), root);
      if (scoped) return { selector: scoped, strategy: 'class+ancestor', label: describe(el), score: 80 };
    }

    // 4. positional path
    const path = pathSelector(el, opts.maxDepth || 6, root);
    if (path) return { selector: path, strategy: 'path', label: describe(el), score: 55 };

    return null;
  }

  function scopedWithAncestor(el, classes, root) {
    let node = el.parentElement;
    let depth = 0;
    while (node && node !== root && depth < 4) {
      const parentClasses = Array.from(node.classList ||[]).filter(isStableClass);
      if (node.id && !looksGeneratedId(node.id)) {
        const sel = `#${cssEscape(node.id)} > ${el.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`;
        if (uniqueInDocument(sel, root) === el) return sel;
      }
      if (parentClasses.length) {
        const sel = `${node.tagName.toLowerCase()}.${parentClasses.slice(0, 2).map(cssEscape).join('.')} > ${el.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`;
        if (uniqueInDocument(sel, root) === el) return sel;
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  function pathSelector(el, maxDepth, root) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== root && depth < maxDepth) {
      if (node === doc_body(node)) break;
      const seg = nthSegment(node);
      if (!seg) break;
      parts.unshift(seg);
      const sel = parts.join(' > ');
      if (uniqueInDocument(sel, root) === el) return sel;
      node = node.parentElement;
      depth++;
    }
    const full = parts.join(' > ');
    return full && uniqueInDocument(full, root) === el ? full : null;
  }

  function doc_body(node) {
    const doc = node.ownerDocument || global.document;
    return doc.body;
  }

  /**
   * Resolve a stored selector back to an element. Returns
   * { element, strategy } or null when nothing matches any more.
   */
  function resolveSelector(selector) {
    if (!selector || typeof selector !== 'string') return null;
    const doc = global.document;
    if (!doc) return null;

    // exact
    try {
      const el = doc.querySelector(selector);
      if (el) return { element: el, strategy: 'exact' };
    } catch (_) { /* malformed stored selector */ }

    // drop the last compound (deepest part) and try again: survives re-renders
    const parts = selector.split(/\s*>\s*/);
    for (let i = parts.length - 1; i >= 1; i--) {
      const partial = parts.slice(0, i).join(' > ');
      try {
        const el = doc.querySelector(partial);
        if (el) return { element: el, strategy: 'ancestor' };
      } catch (_) { /* keep shrinking */ }
    }

    // last resort: last compound anywhere in the document, or just its tag
    const tail = parts[parts.length - 1];
    if (tail) {
      try {
        const el = doc.querySelector(tail);
        if (el) return { element: el, strategy: 'loose' };
      } catch (_) { /* fall through */ }
      const tag = tail.split(/[.#:[]/)[0];
      if (/^[a-z][a-z0-9]*$/i.test(tag)) {
        try {
          const el = doc.querySelector(tag);
          if (el) return { element: el, strategy: 'tag' };
        } catch (_) { /* give up */ }
      }
    }
    return null;
  }

  /** Short human label like `main#app.container`. */
  function describe(el) {
    if (!el || el.nodeType !== 1) return 'unknown';
    let out = el.tagName.toLowerCase();
    if (el.id && !looksGeneratedId(el.id)) out += '#' + el.id;
    else {
      const cls = Array.from(el.classList ||[]).filter(isStableClass).slice(0, 2);
      if (cls.length) out += '.' + cls.join('.');
    }
    return out;
  }

  global.MWR.selector = { buildSelector, resolveSelector, describe, isStableClass, looksGeneratedId };
})(typeof globalThis !== 'undefined' ? globalThis : this);
