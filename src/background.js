/**
 * Service worker: keyboard shortcuts, context menu, install defaults.
 */
'use strict';

const SCRIPT_FILES = [
  'src/shared.js', 'src/storage.js', 'src/selector.js', 'src/detector.js',
  'src/apply.js', 'src/toast.js', 'src/picker.js', 'src/content.js'
];

async function ensureDefaults() {
  const raw = await chrome.storage.local.get(['settings', 'sites']);
  const patch = {};
  if (!raw.settings) patch.settings = globalThis.MWR ? MWR.DEFAULTS : { enabled: false, maxWidth: 1280, mode: 'smart', scope: 'column', center: true, hardMode: false, unstick: true, minWidth: 380, pickerDepth: 6 };
  if (!raw.sites || typeof raw.sites !== 'object') patch.sites = {};
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureDefaults().catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mwr-pick',
      title: 'MaxWidth Resizer: limit this element',
      contexts: ['all']
    });
    chrome.contextMenus.create({
      id: 'mwr-toggle',
      title: 'MaxWidth Resizer: toggle on this site',
      contexts: ['page', 'frame']
    });
  });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  await inject(tab.id);
  if (info.menuItemId === 'mwr-pick') {
    chrome.tabs.sendMessage(tab.id, { type: 'mwr:pick' }).catch(() => {});
  } else if (info.menuItemId === 'mwr-toggle') {
    chrome.tabs.sendMessage(tab.id, { type: 'mwr:toggle' }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  await inject(tab.id);
  if (command === 'toggle-site') chrome.tabs.sendMessage(tab.id, { type: 'mwr:toggle' }).catch(() => {});
  if (command === 'pick-element') chrome.tabs.sendMessage(tab.id, { type: 'mwr:pick' }).catch(() => {});
});

/** Inject the content scripts into tabs that were open before installation. */
async function inject(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'mwr:ping' });
    return true;
  } catch (_) { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: SCRIPT_FILES });
    return true;
  } catch (_) {
    return false;
  }
}

/** Popup asks us to inject when it cannot reach the content script. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'mwr:inject') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    inject(tabId).then((ok) => sendResponse({ ok }));
    return true;
  }
});
