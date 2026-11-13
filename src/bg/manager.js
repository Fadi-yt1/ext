/**
 * Server discovery, testing, ranking, selection and failover (the browser counterpart of the Android
 * app's ServerManager).
 *
 * How a proxy is tested inside a browser: the PAC script routes one Cloudflare "trace" host through
 * the proxy under test, then the extension fetches https://<that host>/cdn-cgi/trace. The request is a
 * normal HTTPS request, so the browser validates the real certificate; the body reports the exit IP and
 * its country. Several trace hosts are used as parallel test slots.
 */
import { parseList, endpointKey, browserUnsupportedReason, toUrl, parseLine } from '../lib/proxyList.js';
import { DEFAULT_SOURCES, guessProtocol } from '../lib/sources.js';
import { parseTrace, traceCountry } from '../lib/trace.js';
import { rank, decide } from '../lib/ranking.js';
import { fetchProxio } from '../lib/proxio.js';
import * as store from './store.js';
import * as ctl from './controller.js';

const LIST_MAX_AGE = 30 * 60 * 1000;
const PER_SOURCE_CAP = 250;
const DISCOVERY_BUDGET_MS = 150 * 1000;
const CALIBRATION_TTL = 20 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Test slots

let calibration = null; // { at, urls, directIp }
const freeSlots = [];
const slotWaiters = [];

function hostOf(url) {
  return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

async function timedFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ctrl.signal });
    const text = (await r.text()).slice(0, 16 * 1024);
    return { status: r.status, text, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds which trace URLs work from this network (fetched DIRECT) and learns the user's real IP, so a
 * "test" that silently bypassed the proxy is never mistaken for a working server.
 * Calibration only runs while no test slot is in use (it temporarily routes every trace host DIRECT).
 */
let calibrating = null;
const inUse = new Set();

export async function calibrate(settings, { force = false } = {}) {
  if (calibrating) return calibrating;
  const fresh = calibration && Date.now() - calibration.at < CALIBRATION_TTL && sameUrls(calibration.all, settings.traceUrls);
  if (calibration && (inUse.size > 0 || (!force && fresh))) return calibration;
  calibrating = runCalibration(settings, force).finally(() => (calibrating = null));
  return calibrating;
}

async function runCalibration(settings, force) {
  if (!force) {
    const saved = await store.getSession('calibration');
    if (saved && Date.now() - saved.at < CALIBRATION_TTL && sameUrls(saved.all, settings.traceUrls)) {
      return useCalibration(saved);
    }
  }
  const urls = [...new Set(settings.traceUrls)].filter((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  });
  const byHost = new Map();
  urls.forEach((u) => byHost.has(hostOf(u)) || byHost.set(hostOf(u), u));
  const unique = [...byHost.values()];
  unique.forEach((u) => ctl.setTest(hostOf(u), 'DIRECT'));
  await ctl.apply();
  const results = await Promise.all(
    unique.map(async (u) => {
      try {
        const r = await timedFetch(u, 6000);
        const t = parseTrace(r.text);
        return r.status === 200 && t.ip ? { url: u, ip: t.ip } : null;
      } catch {
        return null;
      }
    }),
  );
  unique.forEach((u) => ctl.setTest(hostOf(u), null));
  await ctl.apply();
  const ok = results.filter(Boolean);
  const counts = new Map();
  ok.forEach((r) => counts.set(r.ip, (counts.get(r.ip) || 0) + 1));
  const directIp = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // If nothing answered directly (e.g. Cloudflare is blocked here), still try all of them through proxies.
  const cal = { at: Date.now(), all: settings.traceUrls, urls: ok.length ? ok.map((r) => r.url) : unique, directIp, directOk: ok.length };
  await store.setSession({ calibration: cal });
  return useCalibration(cal);
}

function sameUrls(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function useCalibration(cal) {
  calibration = cal;
  freeSlots.length = 0;
  freeSlots.push(...cal.urls.filter((u) => !inUse.has(u)));
  return cal;
}

async function acquireSlot() {
  const url = freeSlots.length ? freeSlots.shift() : await new Promise((resolve) => slotWaiters.push(resolve));
  inUse.add(url);
  return url;
}

function releaseSlot(url) {
  inUse.delete(url);
  if (!calibration?.urls.includes(url)) return;
  const w = slotWaiters.shift();
  if (w) w(url);
  else freeSlots.push(url);
}

/** Tests one endpoint over HTTPS through the proxy. Resolves to { ok, latencyMs, ip, country, error }. */
export async function testEndpoint(ep, settings) {
  const unsupported = browserUnsupportedReason(ep);
  if (unsupported) return { ok: false, error: unsupported };
  const cal = calibration || (await calibrate(settings));
  if (!cal.urls.length) return { ok: false, error: 'No test endpoints configured' };
  const url = await acquireSlot();
  const host = hostOf(url);
  try {
    ctl.setTest(host, ep);
    await ctl.apply();
    const r = await timedFetch(url, settings.testTimeoutMs);
    if (r.status === 407) return { ok: false, error: 'Proxy authentication failed' };
    if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}` };
    const t = parseTrace(r.text);
    if (!t.ip) return { ok: false, error: 'Invalid trace response' };
    if (cal.directIp && t.ip === cal.directIp) return { ok: false, error: 'Traffic was not proxied' };
    return { ok: true, latencyMs: r.ms, ip: t.ip, country: traceCountry(t) };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'Timeout' : /Failed to fetch/i.test(e?.message) ? 'Connection failed' : String(e?.message || e);
    return { ok: false, error: msg };
  } finally {
    ctl.setTest(host, null);
    releaseSlot(url);
  }
}

/**
 * Tests many endpoints, as many at a time as there are slots. `onResult(ep, result)` may return true to
 * stop early; `shouldStop()` is polled before each test.
 */
export async function testMany(eps, settings, { onResult, shouldStop } = {}) {
  await calibrate(settings);
  let i = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && i < eps.length) {
      if (shouldStop?.()) {
        stop = true;
        break;
      }
      const ep = eps[i++];
      const r = await testEndpoint(ep, settings);
      if ((await onResult?.(ep, r)) === true) stop = true;
    }
  };
  if (!calibration.urls.length) return;
  const n = Math.max(1, Math.min(calibration.urls.length, eps.length));
  await Promise.all(Array.from({ length: n }, worker));
  await ctl.clearTests();
}

// ---------------------------------------------------------------------------------------------
// Server records

function serverRecord(ep, origin, extra = {}) {
  const key = endpointKey(ep);
  return { key, protocol: ep.protocol, host: ep.host, port: ep.port, username: ep.username, password: ep.password, origin, name: extra.name || null, ...extra };
}

async function recordResult(ep, r, origin = 'free', dead = null) {
  const servers = await store.getServers();
  const key = endpointKey(ep);
  const existing = servers[key];
  const now = Date.now();
  if (r.ok) {
    return store.putServer({
      ...(existing || serverRecord(ep, origin)),
      alive: true,
      latencyMs: r.latencyMs,
      ip: r.ip,
      country: r.country,
      lastChecked: now,
      failCount: 0,
      lastError: null,
      verifiedAt: now,
    });
  }
  if (dead && origin === 'free') dead[key] = now;
  if (existing) {
    const failCount = (existing.failCount || 0) + 1;
    // Free servers that fail repeatedly are forgotten; your own servers are kept.
    if (existing.origin === 'free' && failCount >= 3 && !existing.favorite) {
      delete servers[key];
      store.saveServers();
      return null;
    }
    return store.putServer({ ...existing, alive: false, failCount, lastChecked: now, lastError: r.error });
  }
  return null;
}

export async function testServer(key) {
  const servers = await store.getServers();
  const s = servers[key];
  if (!s) return { ok: false, error: 'Unknown server' };
  const settings = await store.getSettings();
  const r = await testEndpoint(s, settings);
  await ctl.clearTests();
  await recordResult(s, r, s.origin);
  await store.saveServers({ now: true });
  return r;
}

// ---------------------------------------------------------------------------------------------
// Discovery

export async function refreshLists(settings) {
  const sources = [
    ...settings.enabledSources.map((url) => ({ url, protocol: DEFAULT_SOURCES.find((s) => s.url === url)?.protocol || guessProtocol(url) })),
    ...(settings.customSources || []).filter((s) => s.enabled !== false),
  ];
  if (!sources.length) {
    await store.setCandidates([]);
    return { sources: 0, ok: 0, proxies: 0 };
  }
  await store.setProgress({ phase: 'Downloading server lists', tested: 0, total: sources.length, working: 0, running: true });
  let done = 0;
  const lists = await Promise.all(
    sources.map(async (src) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch(src.url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return [];
        const text = (await r.text()).slice(0, 3_000_000);
        const proxies = parseList(text, src.protocol).proxies.filter((p) => !browserUnsupportedReason(p));
        return shuffle(proxies).slice(0, PER_SOURCE_CAP);
      } catch {
        return [];
      } finally {
        done++;
        await store.setProgress({ phase: 'Downloading server lists', tested: done, total: sources.length, working: 0, running: true });
      }
    }),
  );
  const unique = new Map();
  lists.flat().forEach((ep) => unique.has(endpointKey(ep)) || unique.set(endpointKey(ep), ep));
  await store.setCandidates([...unique.values()].map(toUrl));
  const result = { sources: sources.length, ok: lists.filter((l) => l.length).length, proxies: unique.size };
  await store.setProgress({ phase: 'Lists updated', running: false, message: `${result.ok}/${result.sources} sources, ${result.proxies} proxies` });
  return result;
}

export async function refreshProxio(settings) {
  if (!settings.proxioKey) return 0;
  const protos = settings.proxioProtocol === 'both' ? ['socks5', 'http'] : [settings.proxioProtocol === 'http' ? 'http' : 'socks5'];
  const limit = protos.length === 2 ? Math.max(1, Math.floor(settings.proxioLimit / 2)) : settings.proxioLimit;
  const eps = (await Promise.all(protos.map((p) => fetchProxio(settings.proxioKey, p, limit)))).flat();
  await store.removeServers((s) => s.origin === 'proxio' && !s.favorite);
  for (const ep of eps) if (!browserUnsupportedReason(ep)) await store.putServer(serverRecord(ep, 'proxio', { name: `Proxio ${ep.host}` }));
  await store.setSession({ proxioAt: Date.now() });
  await store.saveServers({ now: true });
  return eps.length;
}

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Tests servers until `want` working servers (in the preferred country, if set) are known.
 * Order: your own and Proxio servers, then fresh candidates from the public lists.
 */
export async function discover(settings, { want = settings.targetWorking, forceLists = false, shouldStop } = {}) {
  const servers = await store.getServers();
  const goodNow = () => rank(Object.values(servers), settings.country).length;
  if (settings.proxioKey && !(await store.getSession('proxioAt'))) {
    await refreshProxio(settings).catch((e) => store.setProgress({ phase: 'Proxio', running: true, message: e.message }));
  }
  let cand = await store.getCandidates();
  if (settings.useFreeLists && (forceLists || !cand.list.length || Date.now() - cand.at > LIST_MAX_AGE)) {
    await refreshLists(settings);
    cand = await store.getCandidates();
  }
  const dead = await store.getDead();
  const now = Date.now();
  const own = Object.values(servers).filter((s) => s.origin !== 'free' && !(s.lastChecked && now - s.lastChecked < 5 * 60000));
  const free = settings.useFreeLists
    ? cand.list
        .map((u) => parseLine(u))
        .filter((ep) => ep && !dead[endpointKey(ep)] && !servers[endpointKey(ep)])
    : [];
  const queue = [...own, ...shuffle(free)];
  const started = Date.now();
  let tested = 0;
  let working = goodNow();
  const target = working + want;
  const progress = () =>
    store.setProgress({ phase: 'Testing servers', tested, total: queue.length, working, running: true, message: settings.country ? `Looking for servers in ${settings.country}` : '' });
  await progress();
  let lastProgress = 0;
  await testMany(queue, settings, {
    shouldStop: () => shouldStop?.() || Date.now() - started > DISCOVERY_BUDGET_MS,
    onResult: async (ep, r) => {
      tested++;
      const origin = servers[endpointKey(ep)]?.origin || 'free';
      await recordResult(ep, r, origin, dead);
      if (r.ok && (!settings.country || r.country === settings.country)) working = goodNow();
      if (Date.now() - lastProgress > 300) {
        lastProgress = Date.now();
        await progress();
      }
      return working >= target;
    },
  });
  await store.setDead(dead);
  await store.saveServers({ now: true });
  await store.setProgress({ phase: 'Done', tested, total: queue.length, working, running: false, message: `${working} working servers` });
  return working;
}

/** Re-tests the best known servers and returns them ranked. */
async function retestTop(settings, n, exclude = []) {
  const servers = await store.getServers();
  const top = rank(Object.values(servers), settings.country).filter((s) => !exclude.includes(s.key)).slice(0, n);
  if (!top.length) return [];
  await testMany(top, settings, { onResult: (ep, r) => recordResult(ep, r, ep.origin) });
  return rank(Object.values(await store.getServers()), settings.country).filter((s) => !exclude.includes(s.key));
}

async function findBest(settings, { exclude = [], shouldStop } = {}) {
  let ranked = await retestTop(settings, 4, exclude);
  if (ranked.length) return ranked[0];
  await discover(settings, { want: Math.max(1, Math.min(settings.targetWorking, 3)), shouldStop });
  ranked = rank(Object.values(await store.getServers()), settings.country).filter((s) => !exclude.includes(s.key));
  return ranked[0] || null;
}

// ---------------------------------------------------------------------------------------------
// Connection lifecycle

let busy = false;
let cancelRequested = false;

export function isBusy() {
  return busy;
}

async function badge(status, country) {
  const map = {
    on: { text: country || 'ON', color: '#00B86E', title: 'Tervyn VPN — connected' },
    connecting: { text: '…', color: '#FFC23D', title: 'Tervyn VPN — connecting' },
    error: { text: '!', color: '#FF4D6A', title: 'Tervyn VPN — needs attention' },
    off: { text: '', color: '#6F86AD', title: 'Tervyn VPN — not connected' },
  };
  const b = map[status] || map.off;
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setTitle({ title: b.title });
}

export async function refreshBadge() {
  const st = await store.getState();
  const servers = await store.getServers();
  await badge(st.status, servers[st.activeKey]?.country);
}

async function notify(title, message) {
  const s = await store.getSettings();
  if (!s.notifications || !chrome.notifications) return;
  chrome.notifications.create(`tervyn-${Date.now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 0 });
}

async function activate(server, message, { switching = false } = {}) {
  const settings = await store.getSettings();
  const prev = await store.getState();
  await ctl.setActive(server);
  await ctl.setWebRtcProtection(settings.webrtcProtect);
  await store.setState({
    status: 'on',
    activeKey: server.key,
    connectedAt: prev.status === 'on' && prev.connectedAt ? prev.connectedAt : Date.now(),
    lastSwitchAt: switching ? Date.now() : prev.lastSwitchAt,
    fasterChecks: 0,
    activeFails: 0,
    message,
  });
  await badge('on', server.country);
  await store.addHistory({ event: switching ? 'switch' : 'connect', server: server.key, country: server.country, latencyMs: server.latencyMs, message });
  await chrome.alarms.create('health', { periodInMinutes: 1 });
}

/** Connects to `key`, or to the fastest working server (in the preferred country, if any). */
export async function connect({ key = null } = {}) {
  if (busy) return { ok: false, error: 'Busy' };
  busy = true;
  cancelRequested = false;
  const prev = await store.getState();
  try {
    await store.setState({ status: 'connecting', message: key ? 'Testing server…' : 'Finding the fastest server…' });
    await badge('connecting');
    const settings = await store.getSettings();
    let chosen;
    if (key) {
      const r = await testServer(key);
      if (!r.ok) throw new Error(`That server did not respond (${r.error})`);
      chosen = (await store.getServers())[key];
    } else {
      chosen = await findBest(settings, { shouldStop: () => cancelRequested });
    }
    if (cancelRequested) throw new Error('Cancelled');
    if (!chosen) {
      throw new Error(settings.country ? `No working server found in ${settings.country}. Try "Fastest" or refresh the lists.` : 'No working server found. Check your connection and try again.');
    }
    await activate(chosen, `Connected to ${chosen.country || 'server'} · ${chosen.latencyMs} ms`, { switching: prev.status === 'on' });
    return { ok: true, server: chosen };
  } catch (e) {
    const cancelled = cancelRequested;
    if (prev.status === 'on' && prev.activeKey && !cancelled) {
      // Keep the previous connection when a manual switch failed.
      await store.setState({ ...prev, message: e.message });
      await refreshBadge();
    } else {
      await ctl.setActive(null);
      await ctl.setWebRtcProtection(false);
      await store.setState({ status: cancelled ? 'off' : 'error', activeKey: null, connectedAt: 0, message: cancelled ? '' : e.message });
      await badge(cancelled ? 'off' : 'error');
    }
    return { ok: false, error: e.message };
  } finally {
    busy = false;
    await ctl.clearTests();
    const p = await store.getSession('progress');
    if (p?.running) await store.setProgress({ ...p, running: false });
  }
}

export async function disconnect() {
  cancelRequested = true;
  const st = await store.getState();
  await ctl.setActive(null);
  await ctl.setWebRtcProtection(false);
  await chrome.alarms.clear('health');
  await store.setState({ status: 'off', activeKey: null, connectedAt: 0, message: '' });
  await badge('off');
  if (st.activeKey) await store.addHistory({ event: 'disconnect', server: st.activeKey });
  return { ok: true };
}

export async function toggle() {
  const st = await store.getState();
  if (st.status === 'on' || st.status === 'connecting') return disconnect();
  return connect();
}

/** Background maintenance: verifies the active server, fails over, and auto-switches to a faster one. */
let lastHealth = 0;
let backupCheckAt = 0;

let healthRun = null;

/** Runs a health check; callers arriving while one is running share its result. */
export function healthCheck(opts = {}) {
  if (healthRun) return healthRun;
  healthRun = runHealthCheck(opts).finally(() => (healthRun = null));
  return healthRun;
}

async function runHealthCheck({ reason = 'timer' } = {}) {
  if (busy) return;
  const st = await store.getState();
  if (st.status !== 'on' || busy) return;
  busy = true;
  lastHealth = Date.now();
  try {
    const settings = await store.getSettings();
    const servers = await store.getServers();
    const active = servers[st.activeKey];
    let r = active ? await testEndpoint(active, settings) : { ok: false, error: 'Unknown server' };
    if (!r.ok && active) r = await testEndpoint(active, settings); // one retry before failing over
    await ctl.clearTests();
    if (active) await recordResult(active, r, active.origin);
    if (!r.ok) {
      const next = settings.autoSwitch ? await findBest(settings, { exclude: [st.activeKey] }) : null;
      if (next) {
        await activate(next, `Switched to ${next.country || 'a new server'}: previous server stopped responding`, { switching: true });
        await notify('Tervyn VPN switched servers', `The previous server stopped responding. Now using ${next.country || next.host} (${next.latencyMs} ms).`);
      } else if (settings.killSwitch) {
        await store.setState({ status: 'on', message: 'Server not responding — traffic is blocked (kill switch). Reconnect or disconnect.' });
        await badge('error');
        await notify('Tervyn VPN: server not responding', 'No working backup server was found. Traffic is blocked by the kill switch.');
      } else {
        await disconnect();
        await store.setState({ status: 'error', message: 'Server stopped responding and no backup was found.' });
        await badge('error');
        await notify('Tervyn VPN disconnected', 'The server stopped responding and no backup was found.');
      }
      return;
    }
    const cur = (await store.getServers())[st.activeKey];
    await store.setState({ activeFails: 0, message: `Connected · ${cur.latencyMs} ms` });
    await refreshBadge();
    // Every 5 minutes: re-test the best backups and maybe auto-switch (hysteresis + 40 % rule).
    if (Date.now() - backupCheckAt > 5 * 60000 || reason === 'manual') {
      backupCheckAt = Date.now();
      const ranked = await retestTop(settings, 5, [st.activeKey]);
      const d = decide({
        autoSwitch: settings.autoSwitch,
        active: cur,
        activeAlive: true,
        candidates: ranked,
        thresholdPct: settings.switchThreshold,
        consecutiveFasterChecks: st.fasterChecks || 0,
        lastSwitchAt: st.lastSwitchAt || 0,
        now: Date.now(),
      });
      if (d.switchTo) await activate(d.switchTo, d.reason, { switching: true });
      else await store.setState({ fasterChecks: d.faster ? (st.fasterChecks || 0) + 1 : 0 });
    }
  } finally {
    busy = false;
    await ctl.clearTests();
  }
}

export function onProxyError() {
  if (Date.now() - lastHealth < 20000) return;
  healthCheck({ reason: 'proxy-error' }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Your own servers

export async function importServers(text, name) {
  const report = parseList(text, 'http');
  const supported = report.proxies.filter((ep) => !browserUnsupportedReason(ep));
  const unsupported = report.proxies.length - supported.length;
  const added = [];
  for (const ep of supported) {
    const key = endpointKey(ep);
    const servers = await store.getServers();
    const label = supported.length === 1 && name ? name : servers[key]?.name || null;
    added.push(await store.putServer({ ...(servers[key] || {}), ...serverRecord(ep, 'custom', { name: label }), origin: 'custom', addedAt: Date.now() }));
  }
  await store.saveServers({ now: true });
  return { added: added.length, invalid: report.invalid, duplicates: report.duplicates, xray: report.xray, unsupported, keys: added.map((s) => s.key) };
}

export async function testKeys(keys) {
  const settings = await store.getSettings();
  const servers = await store.getServers();
  const eps = keys.map((k) => servers[k]).filter(Boolean);
  let tested = 0;
  let working = 0;
  await store.setProgress({ phase: 'Testing servers', tested, total: eps.length, working, running: true });
  await testMany(eps, settings, {
    onResult: async (ep, r) => {
      tested++;
      if (r.ok) working++;
      await recordResult(ep, r, ep.origin);
      await store.setProgress({ phase: 'Testing servers', tested, total: eps.length, working, running: true });
    },
  });
  await store.saveServers({ now: true });
  await store.setProgress({ phase: 'Done', tested, total: eps.length, working, running: false, message: `${working}/${eps.length} working` });
  return { tested, working };
}

/** "Refresh servers" button: download lists again and look for more working servers. */
export async function refreshServers() {
  if (busy) return { ok: false, error: 'Busy' };
  busy = true;
  try {
    const settings = await store.getSettings();
    await store.setSession({ proxioAt: 0 });
    await calibrate(settings, { force: true });
    const working = await discover(settings, { want: settings.targetWorking, forceLists: true });
    return { ok: true, working };
  } catch (e) {
    await store.setProgress({ phase: 'Error', running: false, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    busy = false;
    await ctl.clearTests();
  }
}
