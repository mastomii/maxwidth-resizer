/**
 * Element picker. Highlights what is under the cursor, lets the user walk up
 * the ancestor chain with ArrowUp/ArrowDown, and resolves on click.
 *
 * Site event handlers are suppressed while picking so clicking a button in the
 * page does not trigger the app.
 */
(function (global) {
  'use strict';

  const OVERLAY_ID = 'mwr-picker';
  const BLOCKED = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'];

  let active = null;

  // Same reasoning as the toast: this lives in a shadow root on an arbitrary
  // page, so the colours are spelled out here. Light first, dark via the OS.
  const CSS = `
  :host { all: initial; }
  .box {
    position: fixed; z-index: 2147483645; pointer-events: none;
    border: 2px solid #2563eb; background: rgba(37,99,235,.14);
    border-radius: 3px; transition: all .05s linear; box-sizing: border-box;
  }
  .box.locked { border-color: #15803d; background: rgba(21,128,61,.16); }
  .bar {
    position: fixed; z-index: 2147483647; left: 50%; transform: translateX(-50%);
    bottom: 18px; pointer-events: auto;
    font: 500 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #18181b; background: #ffffff; border: 1px solid #e4e4e7; border-radius: 10px;
    box-shadow: 0 12px 32px rgba(16,16,20,.16), 0 2px 8px rgba(16,16,20,.08);
    padding: 9px 13px; max-width: min(680px, 92vw);
    display: flex; gap: 10px; align-items: center;
  }
  .bar b { color: #2563eb; font-weight: 650; }
  .bar .meta { color: #6b6b74; }
  kbd {
    background: #f4f4f5; border: 1px solid #d4d4d8; border-radius: 4px;
    padding: 1px 4px; font-size: 10.5px; font-family: inherit; color: #18181b;
  }
  .sep { width: 1px; height: 16px; background: #e4e4e7; }
  @media (prefers-color-scheme: dark) {
    .box { border-color: #6b8afd; background: rgba(107,138,253,.16); }
    .box.locked { border-color: #4ade80; background: rgba(74,222,128,.16); }
    .bar { color: #f4f4f5; background: #1d1d22; border-color: #35353c;
           box-shadow: 0 14px 38px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.4); }
    .bar b { color: #8fb4ff; }
    .bar .meta { color: #8b8b94; }
    kbd { background: #26262b; border-color: #35353c; color: #f4f4f5; }
    .sep { background: #35353c; }
  }
  `;

  function ensure() {
    const doc = global.document;
    let host = doc.getElementById(OVERLAY_ID);
    if (!host) {
      host = doc.createElement('div');
      host.id = OVERLAY_ID;
      host.setAttribute('data-mwr', '1');
      (doc.body || doc.documentElement).appendChild(host);
    }
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    if (!root.querySelector('.box')) {
      const style = doc.createElement('style');
      style.textContent = CSS;
      const box = doc.createElement('div');
      box.className = 'box';
      const bar = doc.createElement('div');
      bar.className = 'bar';
      root.append(style, box, bar);
    }
    return root;
  }

  function elementAt(x, y) {
    const doc = global.document;
    const el = doc.elementFromPoint(x, y);
    if (!el) return null;
    if (el.id === OVERLAY_ID || el.id === 'mwr-toast' || el.id === 'mwr-style') return null;
    return el;
  }

  function boxOf(el) {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  function paint(root, el) {
    const box = root.querySelector('.box');
    const bar = root.querySelector('.bar');
    if (!el) { box.style.display = 'none'; return; }
    const r = boxOf(el);
    box.style.display = 'block';
    box.style.top = Math.max(0, r.top) + 'px';
    box.style.left = Math.max(0, r.left) + 'px';
    box.style.width = Math.max(1, Math.min(r.width, global.innerWidth - r.left - 2)) + 'px';
    box.style.height = Math.max(1, r.height) + 'px';
    const label = global.MWR.selector.describe(el);
    const w = Math.round(r.width);
    const depth = active && active.depth ? active.depth : 0;
    bar.innerHTML =
      `<b>${escapeHtml(label)}</b>` +
      `<span class="meta">${w}px wide${depth ? ` · ${depth} up` : ''}</span>` +
      `<span class="sep"></span>` +
      `<span class="meta"><kbd>↑</kbd><kbd>↓</kbd> widen/narrow target · <kbd>click</kbd> apply · <kbd>Esc</kbd> cancel</span>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function move(delta) {
    if (!active) return;
    const chain = active.chain;
    active.index = Math.max(0, Math.min(chain.length - 1, active.index + delta));
    const el = chain[active.index];
    active.hover = el;
    active.depth = active.index;
    paint(active.root, el);
  }

  function onMove(e) {
    if (!active || active.locked) return;
    const el = elementAt(e.clientX, e.clientY);
    if (!el || el === active.hover) return;
    active.hover = el;
    active.chain = chainOf(el);
    active.index = 0;
    active.depth = 0;
    paint(active.root, el);
  }

  function chainOf(el) {
    const out = [];
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 40) {
      out.push(node);
      if (node === global.document.body) break;
      node = node.parentElement;
    }
    return out;
  }

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    const chosen = active.hover;
    const done = active.done;
    stop();
    if (chosen && done) done(chosen);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const cancel = active.cancel;
      stop();
      if (cancel) cancel();
      return;
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onClick(e); }
  }

  function blocker(e) {
    if (!active) return;
    if (e.target && e.target.id === OVERLAY_ID) return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** start({ onPick(el), onCancel() }) */
  function start(handlers) {
    if (active) stop();
    const root = ensure();
    const box = root.querySelector('.box');
    box.classList.add('locked');
    active = {
      root,
      hover: null,
      chain: [],
      index: 0,
      depth: 0,
      locked: false,
      done: handlers && handlers.onPick,
      cancel: handlers && handlers.onCancel
    };

    const box2 = root.querySelector('.box');
    box2.style.display = 'none';
    const bar = root.querySelector('.bar');
    bar.innerHTML = `<b>Pick the content box</b><span class="sep"></span><span class="meta"><kbd>↑</kbd><kbd>↓</kbd> move up/down the DOM · <kbd>click</kbd> apply · <kbd>Esc</kbd> cancel</span>`;

    global.document.addEventListener('mousemove', onMove, true);
    global.document.addEventListener('keydown', onKey, true);
    for (const type of BLOCKED) global.document.addEventListener(type, blocker, true);
    global.document.addEventListener('click', onClick, true);
  }

  function stop() {
    if (!active) return;
    global.document.removeEventListener('mousemove', onMove, true);
    global.document.removeEventListener('keydown', onKey, true);
    for (const type of BLOCKED) global.document.removeEventListener(type, blocker, true);
    global.document.removeEventListener('click', onClick, true);
    const host = global.document.getElementById(OVERLAY_ID);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    active = null;
  }

  function isActive() {
    return !!active;
  }

  global.MWR.picker = { start, stop, isActive };
})(typeof globalThis !== 'undefined' ? globalThis : this);
