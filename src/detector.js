/**
 * Smart content detector.
 *
 * Goal: given a page, find the element that is *the content column* — the box
 * that should stop stretching edge to edge on a wide screen.
 *
 * Approach (two phases):
 *   1. Score every element by how much "real" text it holds, discounting link
 *      text (nav/sidebar/footer are mostly links) and applying semantic
 *      bonuses/penalties (main/article vs nav/aside/header/footer/modal...).
 *   2. Expand upward from the winner while the parent looks like a plain
 *      wrapper — stop as soon as the parent starts pulling in competing chrome
 *      (sidebar, sticky header, a second column, ...).
 */
(function (global) {
  'use strict';

  const TEXT_FLOOR = 120;        // chars of text before an element is a candidate
  const NODE_BUDGET = 40000;     // hard stop for pathological DOMs
  const MAX_CANDIDATES = 4000;

  const TAG_BONUS = {
    MAIN: 45, ARTICLE: 35, SECTION: 6, FORM: -8,
    NAV: -70, ASIDE: -55, HEADER: -45, FOOTER: -55, DIALOG: -35,
    UL: -6, TABLE: -8, MENU: -50, SEARCH: -20
  };

  const ROLE_BONUS = {
    main: 45, article: 35, feed: 10, region: 4, tabpanel: 4, list: -6,
    navigation: -70, banner: -45, contentinfo: -55, complementary: -55,
    dialog: -35, alertdialog: -35, menu: -50, menubar: -50, search: -20,
    form: -8, toolbar: -40, tablist: -30, marquee: -40, status: -30, alert: -30
  };

  const GOOD_NAME = /(^|[-_])(content|main|article|post|entry|page|markdown|prose|reader|readme|doc|docs|document|body|paper|sheet|canvas|workspace|editor|timeline|feed|stream|thread|conversation|messages?|chat|code|notebook|report|detail|view)([-_]|$)/i;
  const BAD_NAME = /(nav|navbar|menu|sidebar|side-bar|footer|header|topbar|toolbar|breadcrumb|tab-bar|tabs?|comment-form|related|recommend|promo|advert|ads?|banner|cookie|consent|modal|dialog|drawer|toast|popover|dropdown|tooltip|overlay|skeleton|placeholder|spinner|gutter|resizer|splitter|scrollbar|toc|outline|status-?bar|notification|announcement)/i;

  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1, HEAD: 1, SVG: 1, CANVAS: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, IMG: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, BR: 1, HR: 1, SOURCE: 1, TRACK: 1, PATH: 1 };

  const CHROME_TAGS = { NAV: 1, ASIDE: 1, HEADER: 1, FOOTER: 1, MENU: 1 };
  const CHROME_NAME = /(nav|menu|sidebar|side-bar|footer|header|topbar|toolbar|breadcrumb|drawer|rail|banner|promo|cookie|consent|announce)/i;

  function isOurNode(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === 'mwr-style' || el.id === 'mwr-toast' || el.id === 'mwr-picker') return true;
    const cls = el.classList;
    return !!(cls && (cls.contains('mwr-toast') || cls.contains('mwr-overlay') || cls.contains('mwr-hover')));
  }

  function normLen(str) {
    const t = String(str || '').replace(/\s+/g, ' ').trim();
    return t ? t.length + 1 : 0;
  }

  /** Post-order pass: text + link-text length for every element. */
  function collectText(el, stats, budget) {
    if (budget.count++ > NODE_BUDGET) return { text: 0, link: 0 };
    let text = 0;
    let link = 0;
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child.nodeType === 3) {
        text += normLen(child.nodeValue);
      } else if (child.nodeType === 1) {
        if (SKIP_TAGS[child.tagName]) continue;
        if (isOurNode(child)) continue;
        const sub = collectText(child, stats, budget);
        text += sub.text;
        link += sub.link;
      }
    }
    if (el.tagName === 'A') link = text;                 // inside a link => navigation-ish
    else if (el.tagName === 'BUTTON') link += text * 0.5; // controls are chrome-ish
    stats.set(el, { text, link });
    return { text, link };
  }

  function viewport() {
    const doc = global.document;
    const de = doc.documentElement;
    return {
      width: Math.max(320, de.clientWidth || global.innerWidth || 1280),
      height: Math.max(240, de.clientHeight || global.innerHeight || 800)
    };
  }

  function nameBonus(el) {
    let bonus = 0;
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : Array.from(el.classList ||[]).join(' ');
    const hay = (id + ' ' + cls).slice(0, 400);
    if (!hay.trim()) return 0;
    if (GOOD_NAME.test(hay)) bonus += 28;
    if (BAD_NAME.test(hay)) bonus -= 45;
    const role = el.getAttribute && el.getAttribute('role');
    if (role && role in ROLE_BONUS) bonus += ROLE_BONUS[role];
    return bonus;
  }

  function looksHidden(style, rect) {
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    if (parseFloat(style.opacity) === 0) return true;
    if (rect.width < 80 || rect.height < 40) return true;
    return false;
  }

  /** Main entry point. Returns a decision object (never throws). */
  function detect(options) {
    const opts = options || {};
    const doc = global.document;
    const vp = viewport();
    const maxWidth = Number(opts.maxWidth) || 1280;
    const target = opts.target || doc.body;
    if (!target) return { ok: false, reason: 'no-body' };

    const budget = { count: 0 };
    const stats = new Map();
    collectText(target, stats, budget);

    // ---- phase 1: score -----------------------------------------------------
    const candidates = [];
    let seen = 0;
    for (const [el, s] of stats) {
      if (s.text < TEXT_FLOOR) continue;
      if (seen++ > MAX_CANDIDATES) break;
      if (el === doc.documentElement) continue;
      const rect = el.getBoundingClientRect();
      const style = global.getComputedStyle(el);
      if (looksHidden(style, rect)) continue;

      const linkRatio = s.link / Math.max(1, s.text);
      let score = s.text - s.link * 1.15;
      if (score <= 0) continue;

      score *= 1 - Math.min(0.9, linkRatio * linkRatio * 0.85);   // link-heavy => chrome
      score *= 1 + ((TAG_BONUS[el.tagName] || 0) + nameBonus(el)) / 100;

      // Prefer boxes that span most of the viewport: those are the stretched ones.
      const spanRatio = Math.min(1, rect.width / vp.width);
      score *= 0.55 + 0.45 * spanRatio;

      // Very short boxes are usually widgets/banners, not content columns.
      const heightRatio = Math.min(1, rect.height / vp.height);
      score *= 0.7 + 0.3 * Math.min(1, heightRatio * 2);

      // Pass-through penalty: if one child already holds nearly all of this
      // element's text, the element is usually just a wrapper around that
      // child, and the child is the better target. Expansion decides later how
      // far up to walk, and it can see sibling columns that scoring cannot.
      //
      // Skip the penalty for boxes that are semantically the content column
      // (`main`, `article`, `[role=main]`, or a telling id/class): an article
      // whose prose happens to sit in a single paragraph is not a wrapper.
      const semantic = (TAG_BONUS[el.tagName] || 0) > 10 || nameBonus(el) > 0;
      if (!semantic) {
        const share = largestChildShare(el, s.text, stats);
        if (share >= 0.9 && s.text > 200) score *= 0.72;
      }

      // Multi-column shell penalty: an element whose children sit side by side
      // is a layout shell (rail + content + rail), not the content column.
      // It scores high because it inherits everyone's text, so it has to be
      // pushed down explicitly.
      if (sideBySideColumns(el) > 0) score *= 0.45;

      // The page shell is never the *preferred* target. It always spans the
      // viewport, so the span bonus above tells us nothing about it, and capping
      // it constrains chrome the site deliberately stretched (a masthead, a
      // full-bleed band). It stays a candidate for pages with no wrapper at all
      // — bare text in <body> — where it genuinely is the content box.
      //
      // Without this, a page that already caps its own column loses to its own
      // <body>: measured on a 1900px viewport, `body` scored 688 against 670 for
      // the 720px column inside it, purely because the column is narrow. The
      // extension then capped <body> and shrank the masthead the site had
      // stretched on purpose, instead of leaving the well-behaved page alone.
      if (el === doc.body) score *= 0.85;

      if (score < 60) continue;
      candidates.push({
        element: el,
        score,
        text: s.text,
        linkRatio,
        rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
        tag: el.tagName,
        label: global.MWR.selector.describe(el)
      });
    }

    if (!candidates.length) return { ok: false, reason: 'no-candidate', viewport: vp };

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, 6);

    // ---- phase 2: expand each top candidate, then keep the best result ------
    // Expansion can stop immediately (the candidate already IS the column) or
    // walk up to the real shell (the candidate was an inner card). Ranking the
    // expanded results means the inner card loses to the wrapper that contains
    // the whole content column, while a candidate whose expansion is blocked by
    // sibling columns keeps its own score.
    const evaluated = [];
    for (const cand of top) {
      const expanded = expand(cand, stats, vp);
      const isWinnerItself = expanded.element === cand.element;
      evaluated.push({
        element: expanded.element,
        score: cand.score * (isWinnerItself ? 1 : 0.99),
        text: expanded.text,
        linkRatio: expanded.linkRatio,
        reason: isWinnerItself ? describeReason(cand) : 'wrapper-expansion',
        label: global.MWR.selector.describe(expanded.element)
      });
    }
    evaluated.sort((a, b) => b.score - a.score);

    // Drop duplicate elements (two candidates can expand to the same wrapper).
    const seenEls = new Set();
    const unique = [];
    for (const item of evaluated) {
      if (seenEls.has(item.element)) continue;
      seenEls.add(item.element);
      unique.push(item);
    }

    let winner = unique[0];
    const el = winner.element;
    const width = Math.round(el.getBoundingClientRect().width);
    let selector = null;
    try {
      selector = global.MWR.selector.buildSelector(el, { root: doc });
    } catch (_) { selector = null; }

    return {
      ok: true,
      element: el,
      selector: selector ? selector.selector : null,
      selectorStrategy: selector ? selector.strategy : null,
      label: global.MWR.selector.describe(el),
      score: Math.round(winner.score),
      reason: winner.reason || 'text-density',
      text: winner.text,
      linkRatio: winner.linkRatio,
      width,
      viewport: vp,
      candidates: top.map((c) => ({
        label: c.label, score: Math.round(c.score), width: Math.round(c.rect.width), text: c.text
      }))
    };
  }

  /**
   * Number of child pairs that sit side by side (non-overlapping horizontally,
   * both tall and both a meaningful slice of the parent). > 0 means the element
   * is a multi-column shell rather than a single content column.
   */
  function sideBySideColumns(el) {
    let pr;
    try { pr = el.getBoundingClientRect(); } catch (_) { return 0; }
    if (pr.width < 220 || pr.height < 140) return 0;

    const kids = [];
    for (const child of el.children) {
      if (isOurNode(child)) continue;
      const r = child.getBoundingClientRect();
      if (r.width < 40 || r.height < pr.height * 0.3) continue;
      if ((r.width * r.height) / (pr.width * pr.height) < 0.03) continue;
      kids.push(r);
      if (kids.length > 6) break;
    }
    if (kids.length < 2) return 0;

    let pairs = 0;
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i];
        const b = kids[j];
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (overlap < Math.min(a.width, b.width) * 0.5) pairs++;
      }
    }
    return pairs;
  }

  /** Share of `el`'s text that lives inside its single biggest child. */
  function largestChildShare(el, ownText, stats) {
    if (!ownText) return 0;
    let max = 0;
    for (const child of el.children) {
      if (isOurNode(child)) continue;
      const cs = stats.get(child);
      if (cs && cs.text > max) max = cs.text;
    }
    return max / ownText;
  }

  function describeReason(c) {
    if (c.linkRatio < 0.12) return 'text-density';
    return 'link-discounted';
  }

  /**
   * Is `other` (a sibling branch) chrome or a competing column that must not be
   * swallowed by expansion?
   *
   * Measured in pixels, not text: the winner's own text mass can easily exceed
   * a thin sidebar, so text comparison lets expansion swallow the whole shell.
   */
  function isCompetingBranch(other, parentRect, vp) {
    if (!other || other.nodeType !== 1) return false;
    if (isOurNode(other)) return false;
    const rect = other.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 30) return false;

    const style = global.getComputedStyle(other);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const name = ((other.id || '') + ' ' + String(other.className || '')).slice(0, 200);
    const hay = name + ' ' + other.tagName;
    const pArea = Math.max(1, parentRect.width * parentRect.height);
    const areaShare = (rect.width * rect.height) / pArea;

    // (a) sidebar / rail: narrow, but spans the parent vertically
    const vertical = rect.height / Math.max(1, parentRect.height);
    if (rect.width < parentRect.width * 0.42 && vertical > 0.55) return true;

    // (b) top/bottom bar: wide, but thin
    if (rect.width > parentRect.width * 0.7 && rect.height < parentRect.height * 0.22) return true;

    // (c) named chrome
    if (CHROME_NAME.test(name) && areaShare > 0.02) return true;

    // (d) any other branch that still owns a meaningful slice of the parent.
    // A pinned bar must NOT count as a competing branch, otherwise the wrapper
    // that contains it can never be absorbed and the sticky bar keeps hanging
    // off the edge of the centered column.
    const pinned = style.position === 'fixed' || style.position === 'sticky';
    if (!pinned && areaShare > 0.08) return true;

    return false;
  }

  /**
   * Only full-bleed chrome that occupies the *same box* as the winner is safe
   * to absorb: a pinned bar or an overlay panel that lines up with the column
   * (the usual "app shell" arrangement). Anything else keeps expansion honest.
   */
  function isOverlayChrome(other, winnerEl) {
    if (!other || other.nodeType !== 1) return false;
    if (isOurNode(other)) return false;
    let or;
    let wr;
    try {
      or = other.getBoundingClientRect();
      wr = winnerEl.getBoundingClientRect();
    } catch (_) { return false; }
    if (or.width < 80 || or.height < 20) return false;
    if (or.height > wr.height * 1.5) return false;
    const style = global.getComputedStyle(other);
    const pinned = style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute';
    if (!pinned) return false;
    // must be aligned with the column: same left edge and same width
    const alignedLeft = Math.abs(or.left - wr.left) < 24;
    const similarWidth = Math.abs(or.width - wr.width) < Math.max(60, wr.width * 0.12);
    return alignedLeft && similarWidth;
  }

  /** Walk up while parents are plain wrappers around the same content. */
  function expand(winner, stats, vp) {
    let current = winner;
    let el = winner.element;
    let guard = 0;

    while (guard++ < 8) {
      const parent = el.parentElement;
      if (!parent) break;
      if (parent === global.document.body || parent === global.document.documentElement) break;
      if (isOurNode(parent)) break;

      const ps = stats.get(parent);
      if (!ps) break;
      const cs = stats.get(el) || { text: current.text, link: 0 };

      // parent must not add a lot of extra text
      if (ps.text > Math.max(cs.text * 1.5, cs.text + 200)) break;

      const style = global.getComputedStyle(parent);
      if (style.position === 'fixed' || style.position === 'sticky') break;
      if (style.display === 'none') break;
      if (style.display === 'contents') break;

      const parentRect = parent.getBoundingClientRect();

      // competing branches inside the parent?
      let competing = false;
      for (const child of parent.children) {
        if (child === el) continue;
        if (isOverlayChrome(child, el)) continue;      // same box, pinned: absorbable
        if (isCompetingBranch(child, parentRect, vp)) { competing = true; break; }
      }
      if (competing) break;

      // A flex/grid parent is a layout shell: absorbing it would reflow the
      // sibling columns into the cap instead of just capping the column.
      // Only a single-child flex wrapper is safe to absorb.
      if (style.display.includes('flex') || style.display.includes('grid')) {
        if (parent.childElementCount !== 1) break;
      }

      // single-child wrappers that just forward width are safe to absorb
      el = parent;
      current = {
        element: parent,
        score: current.score * 0.99,
        text: ps.text,
        linkRatio: ps.link / Math.max(1, ps.text),
        reason: 'wrapper-expansion'
      };
    }

    return current;
  }

  /**
   * Walk up from the content column to the outermost box that still reads as
   * "the page shell" — the scope used by the `page` setting.
   *
   * The difference from `expand` matters: expansion deliberately *stops* at
   * competing columns so a sidebar is never swallowed, while this walk is
   * allowed to absorb them, because capping the shell is the whole point of the
   * setting (it is what keeps the slider effective in a flex app, where the
   * column's own width is just "what the rails left over").
   *
   * It stops before <body>, so the walk can never spill onto a sibling of the
   * page wrapper, and it refuses to absorb a fixed/sticky ancestor: a sticky
   * header keeps its own width once the shell is capped, and pulling it into the
   * cap would leave the page looking broken rather than narrower.
   */
  function pageShell(el, vp) {
    let node = el;
    let guard = 0;

    while (guard++ < 12) {
      const parent = node.parentElement;
      if (!parent) break;
      if (parent === global.document.body || parent === global.document.documentElement) break;
      if (isOurNode(parent)) break;

      const style = global.getComputedStyle(parent);
      if (style.position === 'fixed' || style.position === 'sticky') break;
      if (style.display === 'none' || style.display === 'contents') break;

      // A shell that is itself the scrolling box cannot be centered with
      // margins without dragging its scrollbar inward; leave it where it is.
      const overflowY = style.overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') break;

      // Must still be a page-wide box. A parent that is already narrower than
      // the viewport is somebody's column, not the shell.
      const rect = parent.getBoundingClientRect();
      if (rect.width < vp.width * 0.9) break;

      node = parent;
    }

    return node;
  }

  global.MWR.detector = { detect, collectText, viewport, TEXT_FLOOR, pageShell };
})(typeof globalThis !== 'undefined' ? globalThis : this);
