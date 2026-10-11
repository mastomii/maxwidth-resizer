/**
 * Shared constants + tiny helpers, used by the content scripts, popup, options
 * and the service worker. Loaded as a classic script, so everything hangs off
 * the global object on purpose.
 */
(function (global) {
  'use strict';

  const NS = 'mwr';                 // namespace used for DOM ids/attributes
  const STYLE_ID = 'mwr-style';     // <style> element holding the generated rules
  const MARK_ATTR = 'data-mwr-root';// marks the element we are limiting

  const DEFAULTS = {
    // Off until the user turns it on for a site: the extension never touches a
    // page on its own, and nothing is written to storage until that first click.
    enabled: false,
    maxWidth: 1280,                 // px cap for the content column
    mode: 'smart',                  // 'smart' = auto-detect | 'manual' = pinned element
    scope: 'column',                // 'column' = the content column | 'page' = the whole shell
    center: true,                   // center the column in the viewport
    hardMode: false,                // also clamp inside a limited element (nested layouts)
    unstick: true,                  // neutralise position:sticky/fixed inside the column
    minWidth: 380,                  // never go below this
    pickerDepth: 6,                 // how many ancestors up from the clicked node
    appearance: 'system'            // 'system' = follow the OS | 'light' | 'dark'
  };

  /** Hard bounds for anything coming from storage. */
  const LIMITS = { min: 240, max: 4000, floor: 200 };

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(Math.max(n, min), max);
  }

  /** Sanitise a config object into a fully valid one. */
  function normalizeConfig(raw) {
    const cfg = Object.assign({}, DEFAULTS, raw || {});
    // Opt-in: anything other than an explicit true counts as off, so a missing
    // key, a corrupt value or a fresh install all land in the same place.
    cfg.enabled = cfg.enabled === true;
    cfg.center = cfg.center !== false;
    cfg.hardMode = cfg.hardMode === true;
    cfg.unstick = cfg.unstick !== false;
    cfg.mode = cfg.mode === 'manual' ? 'manual' : 'smart';
    cfg.scope = cfg.scope === 'page' ? 'page' : 'column';
    cfg.maxWidth = Math.round(clamp(cfg.maxWidth, LIMITS.min, LIMITS.max));
    cfg.minWidth = Math.round(clamp(cfg.minWidth, LIMITS.floor, LIMITS.max));
    if (cfg.minWidth > cfg.maxWidth) cfg.minWidth = Math.max(LIMITS.floor, cfg.maxWidth);
    cfg.pickerDepth = Math.round(clamp(cfg.pickerDepth, 0, 20));
    cfg.appearance = cfg.appearance === 'light' || cfg.appearance === 'dark' ? cfg.appearance : 'system';
    return cfg;
  }

  /** Deep-ish clone that is safe for structuredClone-less environments. */
  function clone(obj) {
    try { return structuredClone(obj); } catch (_) { return JSON.parse(JSON.stringify(obj)); }
  }

  /** Hostname (no port) for a URL string; '' when not http(s). */
  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  /** `example.com` -> `example.com`, `www.example.com` -> `example.com`. */
  function siteKey(hostname) {
    return String(hostname || '').replace(/^www\./, '').toLowerCase();
  }

  /** Walk up: a.b.example.com -> [a.b.example.com, b.example.com, example.com] */
  function hostCandidates(hostname) {
    const host = siteKey(hostname);
    if (!host) return [];
    const parts = host.split('.');
    const out = [];
    for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
    return out;
  }

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function getStored(keys) {
    if (!hasChromeStorage()) return Promise.resolve({});
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res ||{}));
      } catch (_) {
        resolve({});
      }
    });
  }

  function setStored(items) {
    if (!hasChromeStorage()) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(items, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  const api = {
    NS,
    STYLE_ID,
    MARK_ATTR,
    DEFAULTS,
    LIMITS,
    clamp,
    normalizeConfig,
    clone,
    hostOf,
    siteKey,
    hostCandidates,
    getStored,
    setStored
  };

  global.MWR = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
