/**
 * Popup controller.
 *
 * The page is the source of truth: every change is sent to the content script
 * and answered with the authoritative state, which is then rendered back. The
 * one exception is the slider, which previews locally so dragging stays smooth
 * and only commits on release.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** Paint the slider's filled portion, which the track gradient reads. */
  function paintRange(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value) || 0;
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
    input.style.setProperty('--mwr-fill', Math.max(0, Math.min(100, pct)) + '%');
  }

  /** 'system' clears the override and hands the choice back to the OS. */
  function applyAppearance(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');
  }
  const els = {
    host: $('host'),
    enabled: $('enabled'),
    cap: $('value'),
    range: $('range'),
    ticks: $('ticks'),
    pick: $('pick'),
    reset: $('reset'),
    dot: $('dot'),
    statusText: $('statusText'),
    more: $('more'),
    morePanel: $('morePanel'),
    kReason: $('kReason'),
    kNested: $('kNested'),
    kSelector: $('kSelector'),
    center: $('center'),
    scope: $('scope'),
    appearance: $('appearance'),
    hardMode: $('hardMode'),
    unstick: $('unstick'),
    options: $('options')
  };

  const RANGE_MIN = 480;
  const RANGE_MAX = 2560;
  const HARD_MIN = 240;
  const HARD_MAX = 4000;

  const REASON_TEXT = {
    'initial': 'auto-detect',
    'auto-detect': 'auto-detect',
    'text-density': 'auto-detect',
    'link-discounted': 'auto-detect',
    'wrapper-expansion': 'auto-detect',
    'page-shell': 'whole page',
    'stored-rule': 'chosen element',
    'picked': 'chosen element',
    'redetect': 're-detected',
    'navigate': 'page navigation',
    'resize': 'window resize',
    'churn': 'page update',
    'toggle': 'switched on',
    'settings': 'settings changed',
    'popup': 'edited here',
    'preview': 'edited here',
    'reset': 'site reset'
  };

  let tabId = null;
  let state = null;
  let moreOpen = false;

  // live-preview bookkeeping: at most one request in flight, and the newest
  // value always wins. Without this, a fast drag queues up stale responses
  // that snap the slider back to older positions.
  let pending = null;
  let inFlight = false;
  let localPreview = null;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function setStatus(html, tone) {
    els.statusText.innerHTML = html;
    els.dot.className = 'dot ' + (tone || 'idle');
  }

  async function send(type, extra) {
    if (tabId == null) return null;
    try {
      const res = await chrome.tabs.sendMessage(tabId, Object.assign({ type }, extra ||{}));
      if (!res) return null;
      if (!res.ok) { setStatus(res.error || 'Something went wrong.', 'warn'); return null; }
      return res.data;
    } catch (_) {
      setStatus('This page is not reachable. Reload it once, then reopen.', 'warn');
      return null;
    }
  }

  /* --------------------------------------------------------- live preview */

  /**
   * Push a cap change without disturbing the controls. Only the status line is
   * repainted, so the slider and the number keep whatever the user is doing.
   */
  async function previewCap(value) {
    if (localPreview == null) localPreview = value;
    if (inFlight) { pending = value; return; }
    inFlight = true;
    const res = await send('mwr:preview', { maxWidth: value });
    inFlight = false;
    if (res) state = res;
    renderStatus();
    if (pending != null && pending !== value) {
      const next = pending;
      pending = null;
      previewCap(next);
    } else {
      pending = null;
    }
  }

  /** Commit a cap change: this one is authoritative and re-renders everything. */
  async function commitCap(value) {
    pending = null;
    inFlight = false;
    const res = await send('mwr:set', { patch: { maxWidth: value } });
    if (res) { state = res; }
    localPreview = null;
    render();
  }

  /* ---------------------------------------------------------------- render */

  /** Controls: only ever driven by committed state. */
  function render() {
    if (!state) return;
    const cfg = state.cfg;

    els.host.textContent = state.host || '—';
    els.host.title = state.href || '';
    els.enabled.checked = !!cfg.enabled;
    document.body.classList.toggle('is-off', !cfg.enabled);

    if (document.activeElement !== els.cap) els.cap.value = String(cfg.maxWidth);
    els.cap.disabled = !cfg.enabled;

    // keep the slider able to represent whatever the cap currently is
    els.range.min = String(Math.min(RANGE_MIN, cfg.maxWidth));
    els.range.max = String(Math.max(RANGE_MAX, cfg.maxWidth));
    els.range.value = String(cfg.maxWidth);
    els.range.disabled = !cfg.enabled;
    paintRange(els.range);
    for (const b of els.ticks.querySelectorAll('button')) {
      b.classList.toggle('on', Number(b.dataset.w) === Number(cfg.maxWidth));
    }

    els.center.checked = !!cfg.center;
    els.scope.value = cfg.scope === 'page' ? 'page' : 'column';
    els.appearance.value = cfg.appearance || 'system';
    els.hardMode.checked = !!cfg.hardMode;
    els.unstick.checked = !!cfg.unstick;

    renderStatus();
  }

  /** Status line + advanced facts: safe to repaint mid-drag. */
  function renderStatus() {
    if (!state) return;
    const cfg = state.cfg;
    const st = state.status || {};
    const shown = localPreview != null ? localPreview : cfg.maxWidth;

    els.kReason.textContent = REASON_TEXT[st.reason] || st.reason || '—';
    els.kNested.textContent = st.applied ? String(st.nested || 0) : '—';
    els.kSelector.textContent = st.selector || '—';
    els.kSelector.title = st.selector || '';

    if (!cfg.enabled) {
      setStatus('Off on this site. Switch it on to add the container.', 'idle');
    } else if (st.applied) {
      const where = st.label ? ` <code>${escapeHtml(st.label)}</code>` : '';
      // while dragging, the local value is ahead of the last server state
      const cap = localPreview != null ? localPreview : (st.cap || cfg.maxWidth);
      const extra = st.nested ? ` · ${st.nested} nested` : '';
      if (st.ceiling) {
        // The layout, not our cap, is the limit here (typically a flex column
        // with no room left). Do not claim a width the page never reached.
        setStatus(`Limited${where} to ${st.ceiling}px — the layout allows no more${extra}.`, 'warn');
      } else {
        setStatus(`Limited${where} to ${cap}px${extra}.`, 'live');
      }
    } else if (st.reason === 'viewport-narrower') {
      setStatus('Your window is already narrower than the limit.', 'warn');
    } else if (st.reason === 'already-within') {
      setStatus(st.label
        ? `<code>${escapeHtml(st.label)}</code> is already ${st.width}px — left alone.`
        : 'The content already fits the limit.', 'warn');
    } else if (st.error) {
      setStatus('No content box found. Use Choose element.', 'warn');
    } else {
      setStatus('Not applied.', 'idle');
    }
  }

  /* --------------------------------------------------------------- actions */

  async function patch(patchObj) {
    localPreview = null;
    const res = await send('mwr:set', { patch: patchObj });
    if (res) { state = res; render(); }
  }

  function clampValue(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(Math.max(n, HARD_MIN), HARD_MAX);
  }

  function markTick(value) {
    for (const b of els.ticks.querySelectorAll('button')) {
      b.classList.toggle('on', Number(b.dataset.w) === value);
    }
  }

  els.enabled.addEventListener('change', async () => {
    const res = await send('mwr:toggle', { enabled: els.enabled.checked });
    if (res) { state = res; render(); }
  });

  // number field: live preview while typing, commit on blur/enter
  els.cap.addEventListener('input', () => {
    const clamped = clampValue(els.cap.value);
    if (clamped == null) return;
    els.range.value = String(Math.min(Math.max(clamped, RANGE_MIN), RANGE_MAX));
    paintRange(els.range);
    markTick(clamped);
    previewCap(clamped);
  });
  els.cap.addEventListener('change', () => {
    const clamped = clampValue(els.cap.value);
    if (clamped == null) { render(); return; }
    els.cap.value = String(clamped);
    commitCap(clamped);
  });

  // slider: preview while dragging, commit on release
  els.range.addEventListener('input', () => {
    const v = Number(els.range.value);
    els.cap.value = String(v);
    markTick(v);
    previewCap(v);
  });
  els.range.addEventListener('change', () => {
    commitCap(Number(els.range.value));
  });

  els.ticks.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-w]');
    if (!btn) return;
    const v = Number(btn.dataset.w);
    els.cap.value = String(v);
    els.range.value = String(v);
    paintRange(els.range);
    markTick(v);
    commitCap(v);
  });

  els.center.addEventListener('change', () => patch({ center: els.center.checked }));
  els.scope.addEventListener('change', () => patch({ scope: els.scope.value }));

  // Appearance is a global preference, not a per-site rule, so it is written to
  // the settings directly instead of going through the content script (which
  // would file it under this host).
  els.appearance.addEventListener('change', async () => {
    const mode = els.appearance.value;
    applyAppearance(mode);
    try {
      await MWR.storage.setSettings({ appearance: mode });
    } catch (_) { /* the choice still applies for this window */ }
  });
  els.hardMode.addEventListener('change', () => patch({ hardMode: els.hardMode.checked }));
  els.unstick.addEventListener('change', () => patch({ unstick: els.unstick.checked }));

  els.pick.addEventListener('click', async () => {
    const res = await send('mwr:pick');
    if (res && res.picking) window.close();
  });

  els.reset.addEventListener('click', async () => {
    const res = await send('mwr:clearSite');
    if (res) { state = res; render(); }
  });

  els.more.addEventListener('click', () => {
    moreOpen = !moreOpen;
    els.morePanel.hidden = !moreOpen;
    els.more.setAttribute('aria-expanded', String(moreOpen));
    els.more.textContent = moreOpen ? 'Hide advanced' : 'Advanced';
  });

  els.options.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  /* ------------------------------------------------------------------ init */

  async function init() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;

    if (!/^https?:/i.test(tab.url || '')) {
      els.host.textContent = 'unsupported page';
      els.enabled.disabled = true;
      els.cap.disabled = true;
      els.range.disabled = true;
      els.pick.disabled = true;
      els.reset.disabled = true;
      setStatus('Only http and https pages can be limited.', 'warn');
      return;
    }

    tabId = tab.id;
    state = await send('mwr:getState');

    if (!state) {
      // fresh install on an already-open tab: inject, then ask again
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/shared.js', 'src/storage.js', 'src/selector.js', 'src/detector.js',
                  'src/apply.js', 'src/toast.js', 'src/picker.js', 'src/content.js']
        });
        state = await send('mwr:getState');
      } catch (_) { /* reported below */ }
    }

    if (!state) {
      setStatus('Reload this page once, then reopen the popup.', 'warn');
      return;
    }
    render();
  }

  init();
})();
