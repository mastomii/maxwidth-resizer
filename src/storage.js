/**
 * Storage layer: global defaults + per-site rules.
 *
 * Shape:
 *   settings : { enabled, maxWidth, mode, scope, center, hardMode, unstick, minWidth, pickerDepth }
 *   sites    : { "example.com": { enabled, maxWidth, mode, scope, center, hardMode, unstick,
 *                                target: { selector, label, score } } }
 *
 * A rule only stores the keys it overrides; everything else falls back to
 * `settings` (see resolve()).
 */
(function (global) {
  'use strict';

  const { normalizeConfig, clone, siteKey, getStored, setStored } = global.MWR;
  const KEYS = ['settings', 'sites'];
  const MUTABLE = ['enabled', 'maxWidth', 'mode', 'scope', 'center', 'hardMode', 'unstick', 'minWidth', 'pickerDepth'];

  /** Last known snapshot, so callers can resolve() synchronously. */
  let cache = { settings: null, sites:{} };

  async function load() {
    const raw = await getStored(KEYS);
    cache = {
      settings: normalizeConfig(raw.settings),
      sites: raw.sites && typeof raw.sites === 'object' ? raw.sites : {}
    };
    return cache;
  }

  function snapshot() {
    return cache;
  }

  function getSettings() {
    return normalizeConfig(cache.settings);
  }

  async function setSettings(patch) {
    const next = normalizeConfig(Object.assign({}, cache.settings, patch));
    cache.settings = next;
    await setStored({ settings: next });
    return next;
  }

  /** Rule for an exact hostname, or null. */
  function getSiteRule(hostname) {
    const key = siteKey(hostname);
    const rule = cache.sites[key];
    return rule && typeof rule === 'object' ? rule : null;
  }

  async function setSiteRule(hostname, patch) {
    const key = siteKey(hostname);
    if (!key) return null;
    const current = cache.sites[key] && typeof cache.sites[key] === 'object' ? cache.sites[key] : {};
    const next = Object.assign({}, current, patch);
    if (patch === null) delete cache.sites[key];
    else cache.sites[key] = next;
    await setStored({ sites: cache.sites });
    return next;
  }

  async function removeSiteRule(hostname) {
    const key = siteKey(hostname);
    if (!key || !cache.sites[key]) return false;
    delete cache.sites[key];
    await setStored({ sites: cache.sites });
    return true;
  }

  /** Merge global settings with the most specific matching site rule. */
  function resolve(hostname) {
    const settings = getSettings();
    const rule = getSiteRule(hostname);
    const cfg = normalizeConfig(Object.assign({}, settings, rule ||{}));
    cfg.settings = settings;
    cfg.rule = rule;
    cfg.target = rule && rule.target && rule.target.selector ? clone(rule.target) : null;
    cfg.siteKey = siteKey(hostname);
    cfg.hasRule = !!rule;
    return cfg;
  }

  /** Store a resolved config back into the site rule (used by popup + picker). */
  async function saveForSite(hostname, cfg, extra) {
    const patch = {};
    for (const key of MUTABLE) if (key in cfg) patch[key] = cfg[key];
    if (extra && extra.target !== undefined) patch.target = extra.target;
    return setSiteRule(hostname, patch);
  }

  /**
   * Undo `saveForSite` when a site is switched back off.
   *
   * Turning a site on is what creates a rule; turning it back off should not
   * leave an "off" rule behind, or a site the user merely tried once would show
   * up in the settings table forever. So: if the config has nothing the global
   * defaults do not already say, the rule is deleted. If the user did customise
   * something for this site (a width, a picked element, hard mode), the rule
   * stays and only `enabled` flips, so those choices survive the round trip.
   */
  async function releaseIfDefault(hostname, cfg) {
    const key = siteKey(hostname);
    if (!key) return false;
    const rule = cache.sites[key];
    if (!rule) return false;

    const settings = getSettings();
    const custom = MUTABLE.some((k) => k !== 'enabled' && rule[k] !== undefined && rule[k] !== settings[k]);
    const picked = !!(rule.target && rule.target.selector);
    if (custom || picked) {
      return setSiteRule(hostname, { enabled: false });
    }
    return removeSiteRule(hostname);
  }

  /** Restore a site back to "follow global defaults". */
  async function resetSite(hostname) {
    const settings = getSettings();
    return setSiteRule(hostname, { enabled: settings.enabled, maxWidth: settings.maxWidth, mode: settings.mode });
  }

  function onChange(cb) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return () => {};
    const handler = (changes, area) => {
      if (area !== 'local') return;
      if (!changes.settings && !changes.sites) return;
      if (changes.settings) cache.settings = normalizeConfig(changes.settings.newValue);
      if (changes.sites) cache.sites = changes.sites.newValue || {};
      cb(cache);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }

  global.MWR.storage = {
    KEYS,
    load,
    snapshot,
    getSettings,
    setSettings,
    getSiteRule,
    setSiteRule,
    removeSiteRule,
    resolve,
    saveForSite,
    releaseIfDefault,
    resetSite,
    onChange
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
