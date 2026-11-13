/**
 * Owns the browser's proxy routing.
 *  - Chromium (Chrome, Edge, Brave, Opera, Vivaldi…): a generated PAC script set via proxy.settings.
 *  - Firefox: a proxy.onRequest listener that asks the same `route()` function for every request.
 * Also answers proxy authentication challenges and toggles WebRTC leak protection.
 */
import { buildPac, compileRouting, directive, route, toFirefoxProxyInfo } from '../lib/pac.js';
import { collectSiteRules } from '../lib/domains.js';
import { IS_FIREFOX } from '../lib/platform.js';
import { getServers, getSettings, getState } from './store.js';

const routing = {
  active: null, // endpoint
  settings: null,
  tests: new Map(), // host -> endpoint | 'DIRECT'
};

const auth = new Map(); // "host:port" -> { username, password }

const hp = (ep) => `${ep.host}:${ep.port}`;

function syncAuth() {
  auth.clear();
  const add = (ep) => ep && ep !== 'DIRECT' && ep.username && auth.set(hp(ep), { username: ep.username, password: ep.password ?? '' });
  add(routing.active);
  routing.tests.forEach(add);
}

function routingOptions(s) {
  const tests = {};
  routing.tests.forEach((ep, host) => (tests[host] = ep === 'DIRECT' ? 'DIRECT' : directive(ep)));
  const rules = collectSiteRules(s);
  return { active: routing.active, mode: s.mode, domains: rules.domains, cidrs: rules.cidrs, bypass: s.bypass, tests, killSwitch: s.killSwitch };
}

// Firefox: the compiled routing table consulted by proxy.onRequest.
let compiled = compileRouting({});
let restored = null; // promise; Firefox requests wait for it so nothing leaks before routing is known

async function doApply() {
  const s = routing.settings || (await getSettings());
  routing.settings = s;
  syncAuth();
  if (IS_FIREFOX) {
    compiled = compileRouting(routingOptions(s));
    return;
  }
  if (!routing.active && routing.tests.size === 0) {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    return;
  }
  const data = buildPac(routingOptions(s));
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data, mandatory: true } }, scope: 'regular' });
}

let gen = 0;
let appliedGen = 0;
let chain = Promise.resolve();

/** Applies the routing state; concurrent calls are coalesced into as few settings writes as possible. */
export function apply() {
  const my = ++gen;
  chain = chain
    .then(async () => {
      if (appliedGen >= my) return;
      const g = gen;
      await doApply();
      appliedGen = g;
    })
    .catch((e) => console.warn('Tervyn: applying proxy settings failed', e));
  return chain;
}

export function setActive(ep) {
  routing.active = ep || null;
  return apply();
}

export function getActiveEndpoint() {
  return routing.active;
}

export function setSettings(settings) {
  routing.settings = settings;
  return apply();
}

/** Routes `host` through `ep` (or 'DIRECT') for a test; pass null to free the slot. Does not apply. */
export function setTest(host, ep) {
  if (ep) routing.tests.set(host, ep);
  else routing.tests.delete(host);
  syncAuth();
}

export function clearTests() {
  routing.tests.clear();
  return apply();
}

/** Restores routing after the service worker / event page was (re)started. */
export function restore() {
  restored = (async () => {
    const [state, settings, servers] = await Promise.all([getState(), getSettings(), getServers()]);
    routing.settings = settings;
    const on = (state.status === 'on' || state.status === 'connecting') && state.activeKey && servers[state.activeKey];
    routing.active = on ? servers[state.activeKey] : null;
    await apply();
    await setWebRtcProtection(Boolean(routing.active) && settings.webrtcProtect);
  })();
  return restored;
}

// ---- Firefox request routing ----

function firefoxRoute(details) {
  let host;
  try {
    host = new URL(details.url).hostname;
  } catch {
    return { type: 'direct' };
  }
  return toFirefoxProxyInfo(route(compiled, host), (h, p) => auth.get(`${h}:${p}`) || null);
}

/** Must be called synchronously at start-up (Firefox wakes the event page for these events). */
export function registerProxyHandler() {
  if (!IS_FIREFOX) return;
  chrome.proxy.onRequest.addListener(
    (details) => {
      if (restored) return restored.then(() => firefoxRoute(details), () => firefoxRoute(details));
      return firefoxRoute(details);
    },
    { urls: ['<all_urls>'] },
  );
}

/** Subscribes to proxy errors (Chromium: proxy.onProxyError, Firefox: proxy.onError). */
export function onProxyError(fn) {
  const ev = chrome.proxy.onProxyError || chrome.proxy.onError;
  ev?.addListener(fn);
}

// ---- proxy authentication (HTTP proxies with user/password) ----

const attempts = new Map(); // requestId -> count

async function credentialsFor(details) {
  if (!details.isProxy) return null;
  const key = `${details.challenger.host}:${details.challenger.port}`;
  const n = (attempts.get(details.requestId) || 0) + 1;
  attempts.set(details.requestId, n);
  if (attempts.size > 500) attempts.clear();
  if (n > 2) return 'cancel';
  const cred = auth.get(key);
  if (cred) return cred;
  // Restarted worker: fall back to the stored active server.
  const [state, servers] = await Promise.all([getState(), getServers()]);
  const ep = state.activeKey && servers[state.activeKey];
  return ep && ep.username && hp(ep) === key ? { username: ep.username, password: ep.password ?? '' } : null;
}

export function registerAuthHandler() {
  const toResponse = (c) => (c === 'cancel' ? { cancel: true } : c ? { authCredentials: c } : {});
  if (IS_FIREFOX) {
    chrome.webRequest.onAuthRequired.addListener((details) => credentialsFor(details).then(toResponse, () => ({})), { urls: ['<all_urls>'] }, ['blocking']);
    return;
  }
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      credentialsFor(details).then((c) => callback(toResponse(c)), () => callback({}));
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking'],
  );
}

// ---- WebRTC leak protection ----

export async function setWebRtcProtection(on) {
  try {
    const pref = chrome.privacy?.network?.webRTCIPHandlingPolicy;
    if (!pref) return;
    if (on) await pref.set({ value: 'disable_non_proxied_udp' });
    else await pref.clear({});
  } catch (e) {
    console.warn('Tervyn: WebRTC policy not changed', e);
  }
}

/**
 * Who controls proxying. Chromium: proxy.settings levelOfControl. Firefox: proxy.onRequest needs the
 * "access your data for all websites" permission, which Firefox lets users withhold.
 */
export async function levelOfControl() {
  if (IS_FIREFOX) {
    const ok = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    return ok ? 'controlled_by_this_extension' : 'needs_host_permission';
  }
  const r = await chrome.proxy.settings.get({ incognito: false });
  return r.levelOfControl;
}
