/**
 * Persistent state in chrome.storage.local:
 *   settings    user preferences (see DEFAULT_SETTINGS)
 *   servers     { [key]: Server } verified/known servers (custom, Proxio, and free servers that passed a test)
 *   candidates  { at, list: string[] } untested free proxies from the public lists
 *   dead        { [key]: timestamp } free proxies that recently failed, skipped for a while
 *   state       connection state shown by the popup
 *   history     last connection events
 * Ephemeral state in chrome.storage.session:
 *   progress    { phase, tested, total, working, running, message }
 *   calibration { at, urls, directIp }
 */
import { DEFAULT_SOURCES, DEFAULT_TRACE_URLS } from '../lib/sources.js';

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'all', // 'all' | 'sites'
  sites: [],
  presets: [],
  country: null, // preferred exit country or null for fastest
  reconnectOnStartup: true,
  autoSwitch: true,
  switchThreshold: 40,
  killSwitch: true,
  webrtcProtect: true,
  notifications: true,
  useFreeLists: true,
  enabledSources: DEFAULT_SOURCES.map((s) => s.url),
  customSources: [], // [{ url, protocol }]
  bypass: [],
  testTimeoutMs: 8000,
  targetWorking: 6,
  traceUrls: DEFAULT_TRACE_URLS,
  proxioKey: '',
  proxioProtocol: 'socks5', // 'socks5' | 'http' | 'both'
  proxioLimit: 50,
});

export const DEFAULT_STATE = Object.freeze({
  status: 'off', // 'off' | 'connecting' | 'on' | 'error'
  activeKey: null,
  connectedAt: 0,
  lastSwitchAt: 0,
  fasterChecks: 0,
  message: '',
});

const local = chrome.storage.local;
const session = chrome.storage.session;

export async function getSettings() {
  const { settings } = await local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function updateSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await local.set({ settings: next });
  return next;
}

export async function getState() {
  const { state } = await local.get('state');
  return { ...DEFAULT_STATE, ...(state || {}) };
}

export async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await local.set({ state: next });
  return next;
}

// ---- servers (cached in memory; the service worker may be restarted at any time) ----

let serversCache = null;
let saveTimer = null;

export async function getServers() {
  if (!serversCache) {
    const { servers } = await local.get('servers');
    serversCache = servers || {};
  }
  return serversCache;
}

export async function saveServers({ now = false } = {}) {
  if (!serversCache) return;
  clearTimeout(saveTimer);
  if (now) return local.set({ servers: serversCache });
  saveTimer = setTimeout(() => local.set({ servers: serversCache }), 400);
}

export async function putServer(server) {
  const all = await getServers();
  all[server.key] = { ...(all[server.key] || {}), ...server };
  saveServers();
  return all[server.key];
}

export async function removeServers(predicate) {
  const all = await getServers();
  for (const [k, s] of Object.entries(all)) if (predicate(s)) delete all[k];
  await saveServers({ now: true });
}

export async function getCandidates() {
  const { candidates } = await local.get('candidates');
  return candidates || { at: 0, list: [] };
}

export async function setCandidates(list) {
  await local.set({ candidates: { at: Date.now(), list } });
}

const DEAD_TTL = 6 * 3600 * 1000;

export async function getDead() {
  const { dead } = await local.get('dead');
  const now = Date.now();
  const out = {};
  for (const [k, t] of Object.entries(dead || {})) if (now - t < DEAD_TTL) out[k] = t;
  return out;
}

export async function setDead(dead) {
  await local.set({ dead });
}

export async function addHistory(entry) {
  const { history } = await local.get('history');
  const list = [{ at: Date.now(), ...entry }, ...(history || [])].slice(0, 50);
  await local.set({ history: list });
}

export async function setProgress(p) {
  await session.set({ progress: p });
}

export async function getSession(key) {
  return (await session.get(key))[key];
}

export async function setSession(obj) {
  await session.set(obj);
}
