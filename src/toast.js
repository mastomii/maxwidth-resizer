/**
 * Minimal toast/status UI, injected into a shadow root so page CSS can't
 * reach it. Used for feedback after toggling, applying, or picking.
 */
(function (global) {
  'use strict';

  const HOST_ID = 'mwr-toast';
  let host = null;
  let root = null;
  let hideTimer = 0;

  // Injected into arbitrary pages, so this cannot use theme.css: a shadow root
  // has no access to the extension's stylesheets. Light is the default and dark
  // follows the OS, matching the popup.
  const CSS = `
  :host { all: initial; }
  .wrap {
    position: fixed; z-index: 2147483646; right: 16px; bottom: 16px;
    font: 500 12.5px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #18181b; background: #ffffff; border: 1px solid #e4e4e7;
    border-radius: 10px; box-shadow: 0 12px 32px rgba(16,16,20,.16), 0 2px 8px rgba(16,16,20,.08);
    padding: 9px 12px; max-width: 320px; display: flex; gap: 9px; align-items: center;
    opacity: 0; transform: translateY(6px); transition: opacity .16s ease, transform .16s ease;
    pointer-events: auto;
  }
  .wrap.show { opacity: 1; transform: translateY(0); }
  .badge {
    flex: 0 0 auto; font-weight: 700; font-size: 10px; letter-spacing: .06em;
    background: #2563eb; color: #fff; border-radius: 5px; padding: 2px 5px;
  }
  .badge.off { background: #6b6b74; }
  .badge.warn { background: #b45309; }
  .body { min-width: 0; }
  .title { font-weight: 650; }
  .sub { color: #6b6b74; font-size: 11px; margin-top: 1px; word-break: break-word; }
  .hint { color: #8e8e97; font-size: 10.5px; margin-top: 3px; }
  kbd {
    background: #f4f4f5; border: 1px solid #d4d4d8; border-radius: 4px;
    padding: 0 3px; font-size: 10px; font-family: inherit; color: #18181b;
  }
  @media (prefers-color-scheme: dark) {
    .wrap { color: #f4f4f5; background: #1d1d22; border-color: #35353c;
            box-shadow: 0 14px 38px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.4); }
    .badge.off { background: #4b4b54; }
    .sub { color: #8b8b94; }
    .hint { color: #6a6a73; }
    kbd { background: #26262b; border-color: #35353c; color: #f4f4f5; }
  }
  `;

  function ensure() {
    const doc = global.document;
    if (!doc) return null;
    if (root && host && host.isConnected) return root;
    host = doc.getElementById(HOST_ID);
    if (!host) {
      host = doc.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-mwr', '1');
      (doc.body || doc.documentElement).appendChild(host);
    }
    root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    if (!root.querySelector('.wrap')) {
      const style = doc.createElement('style');
      style.textContent = CSS;
      const wrap = doc.createElement('div');
      wrap.className = 'wrap';
      wrap.innerHTML = '<span class="badge"></span><div class="body"><div class="title"></div><div class="sub"></div></div>';
      root.append(style, wrap);
      wrap.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    }
    return root;
  }

  /**
   * show({ title, sub, badge, tone, timeout, hint })
   * tone: 'on' | 'off' | 'warn'
   */
  function show(opts) {
    const o = typeof opts === 'string' ? { title: opts } : (opts || {});
    const r = ensure();
    if (!r) return;
    const wrap = r.querySelector('.wrap');
    const badge = r.querySelector('.badge');
    const title = r.querySelector('.title');
    const sub = r.querySelector('.sub');

    badge.textContent = o.badge || (o.tone === 'off' ? 'OFF' : 'MAX');
    badge.className = 'badge' + (o.tone === 'off' ? ' off' : o.tone === 'warn' ? ' warn' : '');
    title.textContent = o.title || '';
    sub.textContent = o.sub || '';
    if (o.hint) {
      sub.innerHTML = '';
      sub.textContent = o.sub || '';
      const hint = r.ownerDocument.createElement('div');
      hint.className = 'hint';
      hint.innerHTML = o.hint;
      sub.after(hint);
    }
    wrap.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, o.timeout == null ? 2600 : o.timeout);
  }

  function hide() {
    clearTimeout(hideTimer);
    if (!root) return;
    const wrap = root.querySelector('.wrap');
    if (wrap) wrap.classList.remove('show');
  }

  function destroy() {
    hide();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    root = null;
  }

  global.MWR.toast = { show, hide, destroy };
})(typeof globalThis !== 'undefined' ? globalThis : this);
