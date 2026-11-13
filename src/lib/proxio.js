/**
 * Proxio.io list API: GET https://proxio.io/api/list?type=<socks5|http>&limit=<n> with header X-Key.
 * The body is parsed defensively: text lines, or JSON (array, or object holding an array under
 * data/proxies/list/result/items) of strings or of {host|ip, port, username, password, protocol} objects.
 */
import { parseLine, parseList, protocolForScheme, isValidHost, validPort, endpointKey } from './proxyList.js';

const ARRAY_KEYS = ['data', 'proxies', 'list', 'result', 'items'];

export const PROXIO_URL = 'https://proxio.io/api/list';

export async function fetchProxio(apiKey, protocol, limit, fetchImpl = fetch) {
  if (!apiKey || !apiKey.trim()) throw new Error('API key is empty');
  const url = new URL(PROXIO_URL);
  url.searchParams.set('type', protocol === 'socks5' ? 'socks5' : 'http');
  url.searchParams.set('limit', String(Math.min(1000, Math.max(1, limit))));
  const r = await fetchImpl(url, { headers: { 'X-Key': apiKey.trim(), Accept: 'application/json, text/plain' }, cache: 'no-store' });
  if (r.status === 401 || r.status === 403) throw new Error(`Proxio rejected the API key (HTTP ${r.status})`);
  if (r.status === 429) throw new Error('Proxio rate limit reached, try again later');
  if (!r.ok) throw new Error(`Proxio returned HTTP ${r.status}`);
  const body = await r.text();
  if (body.length > 5_000_000) throw new Error('Response too large');
  return parseProxio(body, protocol);
}

export function parseProxio(body, defaultProtocol) {
  const t = String(body).trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    let el;
    try {
      el = JSON.parse(t);
    } catch {
      el = undefined;
    }
    if (el !== undefined) {
      if (el && !Array.isArray(el) && typeof el === 'object' && (el.error || el.message) && !ARRAY_KEYS.some((k) => Array.isArray(el[k]))) {
        throw new Error(typeof (el.error || el.message) === 'string' ? el.error || el.message : 'Proxio error');
      }
      const seen = new Map();
      for (const ep of fromJson(el, defaultProtocol)) seen.set(endpointKey(ep), ep);
      return [...seen.values()];
    }
  }
  return parseList(t, defaultProtocol).proxies;
}

function fromJson(el, def) {
  if (Array.isArray(el)) return el.flatMap((x) => fromJson(x, def));
  if (typeof el === 'string') return [parseLine(el, def)].filter(Boolean);
  if (el && typeof el === 'object') {
    const k = ARRAY_KEYS.find((x) => Array.isArray(el[x]));
    if (k) return fromJson(el[k], def);
    return [objToEndpoint(el, def)].filter(Boolean);
  }
  return [];
}

function objToEndpoint(o, def) {
  const s = (...keys) => {
    for (const k of keys) {
      const v = o[k];
      if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim();
    }
    return null;
  };
  const proxyStr = s('proxy', 'url');
  if (proxyStr) return parseLine(proxyStr, def);
  const host = s('host', 'ip', 'address', 'server');
  const port = Number(s('port'));
  if (!host || !isValidHost(host) || !validPort(port)) return null;
  const proto = protocolForScheme(s('protocol', 'type', 'scheme') || '') || def;
  const user = s('username', 'user', 'login');
  const ep = { protocol: proto, host: host.toLowerCase(), port };
  if (user) {
    ep.username = user;
    ep.password = s('password', 'pass') ?? '';
  }
  return ep;
}
