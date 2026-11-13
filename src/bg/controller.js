/**
 * Owns the browser's proxy settings: builds the PAC script from the current routing state, applies it
 * (coalescing bursts of changes), answers proxy authentication challenges, and toggles WebRTC leak
 * protection.
 */
import { buildPac, directive } from '../lib/pac.js';
import { collectSiteRules } from '../lib/domains.js';
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

let gen = 0;
let appliedGen = 0;
let chain = Promise.resolve();

async function doApply() {
  const s = routing.settings || (await getSettings());
  routing.settings = s;
  syncAuth();
  if (!routing.active && routing.tests.size === 0) {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    return;
  }
  const tests = {};
  routing.tests.forEach((ep, host) => (tests[host] = ep === 'DIRECT' ? 'DIRECT' : directive(ep)));
  const rules = collectSiteRules(s);
  const data = buildPac({
    active: routing.active,
    mode: s.mode,
    domains: rules.domains,
    cidrs: rules.cidrs,
    bypass: s.bypass,
    tests,
    killSwitch: s.killSwitch,
  });
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data, mandatory: true } }, scope: 'regular' });
}

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

/** Restores routing after the service worker was restarted. */
export async function restore() {
  const [state, settings, servers] = await Promise.all([getState(), getSettings(), getServers()]);
  routing.settings = settings;
  const on = (state.status === 'on' || state.status === 'connecting') && state.activeKey && servers[state.activeKey];
  routing.active = on ? servers[state.activeKey] : null;
  await apply();
  await setWebRtcProtection(Boolean(routing.active) && settings.webrtcProtect);
}

// ---- proxy authentication (HTTP proxies with user/password) ----

const attempts = new Map(); // requestId -> count

export function registerAuthHandler() {
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      if (!details.isProxy) return callback({});
      const key = `${details.challenger.host}:${details.challenger.port}`;
      const n = (attempts.get(details.requestId) || 0) + 1;
      attempts.set(details.requestId, n);
      if (attempts.size > 500) attempts.clear();
      if (n > 2) return callback({ cancel: true });
      const answer = (cred) => callback(cred ? { authCredentials: cred } : {});
      const cred = auth.get(key);
      if (cred) return answer(cred);
      // Service worker restarted: fall back to the stored active server.
      Promise.all([getState(), getServers()])
        .then(([state, servers]) => {
          const ep = state.activeKey && servers[state.activeKey];
          answer(ep && ep.username && hp(ep) === key ? { username: ep.username, password: ep.password ?? '' } : null);
        })
        .catch(() => answer(null));
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

/** Who controls the browser proxy setting ('controlled_by_this_extension', 'controlled_by_other_extensions', ...). */
export async function levelOfControl() {
  const r = await chrome.proxy.settings.get({ incognito: false });
  return r.levelOfControl;
}
