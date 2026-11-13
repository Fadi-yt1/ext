/** Tervyn VPN service worker: wires browser events and popup/options messages to the manager. */
import * as ctl from './bg/controller.js';
import * as mgr from './bg/manager.js';
import * as store from './bg/store.js';
import { normalizeDomain } from './lib/domains.js';

// Must be registered synchronously at start-up so proxy auth works after the worker was suspended.
ctl.registerAuthHandler();
ctl.registerProxyHandler();

const ready = ctl.restore().then(() => mgr.refreshBadge()).catch((e) => console.warn('Tervyn: restore failed', e));

chrome.runtime.onInstalled.addListener(async (details) => {
  // Firefox for Android has no context menus or keyboard shortcuts.
  chrome.contextMenus?.removeAll(() => {
    chrome.contextMenus.create({ id: 'tervyn-site', title: 'Route this site through Tervyn (My sites)', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'tervyn-toggle', title: 'Connect / disconnect Tervyn VPN', contexts: ['action'] });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  const [st, s] = await Promise.all([store.getState(), store.getSettings()]);
  if (st.status === 'on' && s.reconnectOnStartup) mgr.healthCheck({ reason: 'startup' });
  else if (st.status !== 'off') mgr.disconnect();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === 'health') mgr.healthCheck();
});

ctl.onProxyError(() => mgr.onProxyError());

chrome.commands?.onCommand.addListener(async (cmd) => {
  await ready;
  if (cmd === 'toggle-connection') mgr.toggle();
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  await ready;
  if (info.menuItemId === 'tervyn-toggle') return mgr.toggle();
  if (info.menuItemId === 'tervyn-site') {
    const d = normalizeDomain(info.pageUrl || tab?.url);
    if (!d) return;
    const s = await store.getSettings();
    const sites = s.sites.includes(d) ? s.sites : [...s.sites, d];
    await store.updateSettings({ sites });
  }
});

// Settings edited anywhere (popup, options page) take effect immediately.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const s = changes.settings.newValue;
  await ctl.setSettings({ ...store.DEFAULT_SETTINGS, ...s });
  const st = await store.getState();
  await ctl.setWebRtcProtection(st.status === 'on' && s.webrtcProtect);
});

const handlers = {
  connect: (m) => mgr.connect({ key: m.key || null }),
  disconnect: () => mgr.disconnect(),
  toggle: () => mgr.toggle(),
  refreshServers: () => mgr.refreshServers(),
  testServer: (m) => mgr.testServer(m.key),
  testKeys: (m) => mgr.testKeys(m.keys),
  checkNow: () => mgr.healthCheck({ reason: 'manual' }).then(() => ({ ok: true })),
  importServers: (m) => mgr.importServers(m.text, m.name),
  removeServer: async (m) => {
    const st = await store.getState();
    if (st.activeKey === m.key && st.status === 'on') return { ok: false, error: 'Disconnect from this server first' };
    await store.removeServers((s) => s.key === m.key);
    return { ok: true };
  },
  setFavorite: async (m) => {
    const servers = await store.getServers();
    if (servers[m.key]) await store.putServer({ ...servers[m.key], favorite: Boolean(m.value) });
    await store.saveServers({ now: true });
    return { ok: true };
  },
  clearFree: async () => {
    const st = await store.getState();
    await store.removeServers((s) => s.origin === 'free' && s.key !== st.activeKey && !s.favorite);
    await store.setCandidates([]);
    await store.setDead({});
    return { ok: true };
  },
  recalibrate: async () => mgr.calibrate(await store.getSettings(), { force: true }),
  levelOfControl: async () => ({ level: await ctl.levelOfControl() }),
  isBusy: async () => ({ busy: mgr.isBusy() }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const h = handlers[msg?.cmd];
  if (!h) return false;
  ready
    .then(() => h(msg))
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
