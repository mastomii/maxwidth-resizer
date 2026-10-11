/**
 * Options page: global defaults + per-site overrides.
 */
(function () {
  'use strict';

  const { clamp, LIMITS, clone } = MWR;
  const S = MWR.storage;

  const RANGE_MIN = 480;
  const RANGE_MAX = 2560;

  const $ = (id) => document.getElementById(id);
  const els = {
    enabled: $('enabled'),
    maxWidth: $('maxWidth'),
    range: $('range'),
    mode: $('mode'),
    scope: $('scope'),
    appearance: $('appearance'),
    center: $('center'),
    hardMode: $('hardMode'),
    unstick: $('unstick'),
    siteBody: $('siteBody'),
    emptySites: $('emptySites'),
    exportBtn: $('exportBtn'),
    importBtn: $('importBtn'),
    clearAll: $('clearAll'),
    io: $('io'),
    status: $('status'),
    version: $('version')
  };

  let settings = null;
  let sites = {};
  let saveTimer = 0;
  let writing = false;

  function flash(text, kind) {
    els.status.textContent = text;
    els.status.className = kind || '';
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { els.status.textContent = ''; els.status.className = ''; }, 2400);
  }

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

  function renderSettings() {
    els.enabled.checked = !!settings.enabled;
    if (document.activeElement !== els.maxWidth) els.maxWidth.value = String(settings.maxWidth);
    els.range.value = String(Math.min(Math.max(settings.maxWidth, RANGE_MIN), RANGE_MAX));
    paintRange(els.range);
    els.mode.value = settings.mode === 'manual' ? 'manual' : 'smart';
    els.scope.value = settings.scope === 'page' ? 'page' : 'column';
    els.appearance.value = settings.appearance || 'system';
    applyAppearance(settings.appearance);
    els.center.checked = !!settings.center;
    els.hardMode.checked = !!settings.hardMode;
    els.unstick.checked = !!settings.unstick;
  }

  function saveSettings(patch, note) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      settings = await S.setSettings(patch);
      renderSettings();
      flash(note || 'Saved', 'ok');
    }, 200);
  }

  function setCap(value) {
    const clamped = Math.round(clamp(value, LIMITS.min, LIMITS.max));
    els.maxWidth.value = String(clamped);
    els.range.value = String(Math.min(Math.max(clamped, RANGE_MIN), RANGE_MAX));
    paintRange(els.range);
    return clamped;
  }

  /* ----------------------------------------------------------------- table */

  function renderSites() {
    const keys = Object.keys(sites).sort();
    els.siteBody.innerHTML = '';
    els.emptySites.hidden = keys.length > 0;

    for (const key of keys) {
      const rule = sites[key] || {};
      const tr = document.createElement('tr');

      const tdHost = document.createElement('td');
      tdHost.textContent = key;

      const tdMax = document.createElement('td');
      const max = document.createElement('input');
      max.type = 'number';
      max.min = String(LIMITS.min);
      max.max = String(LIMITS.max);
      max.step = '10';
      max.value = String(rule.maxWidth == null ? settings.maxWidth : rule.maxWidth);
      max.addEventListener('change', () => {
        const value = Math.round(clamp(Number(max.value) || settings.maxWidth, LIMITS.min, LIMITS.max));
        max.value = String(value);
        updateRule(key, { maxWidth: value });
      });
      tdMax.appendChild(max);

      const tdTarget = document.createElement('td');
      tdTarget.className = 'mono';
      const hasTarget = !!(rule.target && rule.target.selector);
      tdTarget.textContent = hasTarget ? rule.target.selector : (rule.mode === 'manual' ? 'not found' : 'auto');
      tdTarget.title = tdTarget.textContent;

      const tdOn = document.createElement('td');
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = rule.enabled !== false;
      on.addEventListener('change', () => updateRule(key, { enabled: on.checked }));
      tdOn.appendChild(on);

      const tdAct = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'btn icon';
      del.textContent = 'Remove';
      del.title = 'Delete this override';
      del.addEventListener('click', async () => {
        await S.removeSiteRule(key);
        sites = clone(S.snapshot().sites || {});
        renderSites();
        flash('Removed ' + key, 'warn');
      });
      tdAct.appendChild(del);

      tr.append(tdHost, tdMax, tdTarget, tdOn, tdAct);
      els.siteBody.appendChild(tr);
    }
  }

  async function updateRule(key, patch) {
    await S.setSiteRule(key, patch);
    sites = clone(S.snapshot().sites || {});
    renderSites();
    flash('Updated ' + key, 'ok');
  }

  /* ------------------------------------------------------------- listeners */

  els.enabled.addEventListener('change', () => saveSettings({ enabled: els.enabled.checked }));
  els.center.addEventListener('change', () => saveSettings({ center: els.center.checked }));
  els.hardMode.addEventListener('change', () => saveSettings({ hardMode: els.hardMode.checked }));
  els.unstick.addEventListener('change', () => saveSettings({ unstick: els.unstick.checked }));
  els.mode.addEventListener('change', () => saveSettings({ mode: els.mode.value }));
  els.scope.addEventListener('change', () => saveSettings({ scope: els.scope.value }));
  els.appearance.addEventListener('change', () => {
    applyAppearance(els.appearance.value);
    saveSettings({ appearance: els.appearance.value }, 'Appearance saved');
  });

  els.maxWidth.addEventListener('input', () => {
    const value = Number(els.maxWidth.value);
    if (!Number.isFinite(value) || value <= 0) return;
    els.range.value = String(Math.min(Math.max(value, RANGE_MIN), RANGE_MAX));
    paintRange(els.range);
    saveSettings({ maxWidth: value }, 'Saved · ' + Math.round(clamp(value, LIMITS.min, LIMITS.max)) + 'px');
  });
  els.maxWidth.addEventListener('change', () => {
    const value = setCap(Number(els.maxWidth.value) || settings.maxWidth);
    saveSettings({ maxWidth: value }, 'Saved · ' + value + 'px');
  });

  els.range.addEventListener('input', () => {
    const value = Number(els.range.value);
    els.maxWidth.value = String(value);
    saveSettings({ maxWidth: value }, 'Saved · ' + value + 'px');
  });

  els.exportBtn.addEventListener('click', () => {
    els.io.value = JSON.stringify({ settings, sites }, null, 2);
    els.io.select();
    flash('Exported below', 'ok');
  });

  els.importBtn.addEventListener('click', async () => {
    let parsed;
    try {
      parsed = JSON.parse(els.io.value);
    } catch (_) {
      flash('That is not valid JSON', 'warn');
      return;
    }
    if (parsed.settings) settings = await S.setSettings(parsed.settings);
    if (parsed.sites && typeof parsed.sites === 'object') {
      const merged = Object.assign({}, S.snapshot().sites, parsed.sites);
      await MWR.setStored({ sites: merged });
      await S.load();
      sites = clone(S.snapshot().sites || {});
    }
    renderSettings();
    renderSites();
    flash('Imported', 'ok');
  });

  els.clearAll.addEventListener('click', async () => {
    if (!confirm('Delete all site overrides? Your defaults are kept.')) return;
    await MWR.setStored({ sites:{} });
    await S.load();
    sites = clone(S.snapshot().sites || {});
    renderSites();
    flash('All overrides deleted', 'warn');
  });

  /* ------------------------------------------------------------------ init */

  async function init() {
    await S.load();
    settings = S.getSettings();
    sites = clone(S.snapshot().sites || {});
    renderSettings();
    renderSites();
    els.version.textContent = 'v' + chrome.runtime.getManifest().version;
    S.onChange(() => {
      if (writing) return;
      settings = S.getSettings();
      sites = clone(S.snapshot().sites || {});
      renderSettings();
      renderSites();
    });
  }

  init();
})();
