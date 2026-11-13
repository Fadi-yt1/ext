/**
 * Proxy list parsing (port of the Android app's ProxyList.kt).
 *
 * Supported line formats:
 *  - host:port
 *  - host:port:user:pass
 *  - user:pass@host:port
 *  - user:pass:host:port
 *  - URLs: http://, https:// (HTTP CONNECT), socks5://, socks5h://, socks://, with optional credentials
 * Lines may carry trailing columns ("1.2.3.4:1080 US") and # comments. Invalid lines are skipped.
 *
 * An endpoint is a plain object: { protocol: 'http' | 'socks5', host, port, username?, password? }.
 */

export const PROTOCOLS = Object.freeze({ HTTP: 'http', SOCKS5: 'socks5' });

/** Share-link schemes that need the Xray core of the Android app; browsers cannot speak them. */
export const XRAY_SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'tuic', 'wireguard'];

export function protocolForScheme(scheme) {
  switch (String(scheme).toLowerCase()) {
    case 'http':
    case 'https':
      return PROTOCOLS.HTTP;
    case 'socks5':
    case 'socks5h':
    case 'socks':
      return PROTOCOLS.SOCKS5;
    default:
      return null;
  }
}

export function endpointKey(ep) {
  const host = ep.host.includes(':') ? `[${ep.host}]` : ep.host;
  return `${ep.protocol}://${ep.username ? encodeURIComponent(ep.username) + '@' : ''}${host}:${ep.port}`;
}

export function validPort(p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

export function isIpv4(h) {
  const p = String(h).split('.');
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

export function isIpv6(h) {
  if (!h.includes(':') || !/^[0-9a-fA-F:.]+$/.test(h)) return false;
  try {
    return new URL(`http://[${h}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?)*$/;

export function isValidHost(h) {
  if (!h) return false;
  if (isIpv4(h)) return true;
  if (h.includes(':')) return isIpv6(h);
  if (/^[\d.]+$/.test(h)) return false; // malformed IPv4
  return HOSTNAME_RE.test(h);
}

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function toPort(s) {
  return /^\d{1,5}$/.test(s) ? Number(s) : null;
}

/** Splits "host:port" or "[v6]:port". */
export function splitHostPort(s) {
  const str = String(s).trim();
  if (str.startsWith('[')) {
    const end = str.indexOf(']');
    if (end < 0 || str[end + 1] !== ':') return null;
    const port = toPort(str.slice(end + 2));
    return port == null ? null : [str.slice(1, end), port];
  }
  const idx = str.lastIndexOf(':');
  if (idx <= 0) return null;
  const port = toPort(str.slice(idx + 1));
  return port == null ? null : [str.slice(0, idx), port];
}

function build(protocol, host, port, user, pass) {
  const h = String(host).trim().replace(/^\[|\]$/g, '');
  if (!isValidHost(h) || !validPort(port)) return null;
  const u = user ? String(user) : null;
  if (u && (u.length > 255 || (pass || '').length > 255)) return null;
  const ep = { protocol, host: h.toLowerCase(), port };
  if (u) {
    ep.username = u;
    ep.password = pass ?? '';
  }
  return ep;
}

function parseBare(s, proto) {
  const at = s.lastIndexOf('@');
  if (at > 0) {
    const userInfo = s.slice(0, at);
    const hp = splitHostPort(s.slice(at + 1));
    if (!hp) return null;
    const ci = userInfo.indexOf(':');
    const user = decode(ci >= 0 ? userInfo.slice(0, ci) : userInfo);
    const pass = ci >= 0 ? decode(userInfo.slice(ci + 1)) : null;
    return build(proto, hp[0], hp[1], user, pass);
  }
  if (s.startsWith('[')) {
    const hp = splitHostPort(s);
    return hp ? build(proto, hp[0], hp[1]) : null;
  }
  const parts = s.split(':');
  if (parts.length === 2) {
    const port = toPort(parts[1]);
    return port == null ? null : build(proto, parts[0], port);
  }
  if (parts.length === 4) {
    const p1 = toPort(parts[1]);
    const p3 = toPort(parts[3]);
    if (p1 != null && isValidHost(parts[0]) && validPort(p1)) return build(proto, parts[0], p1, parts[2], parts[3]);
    if (p3 != null && isValidHost(parts[2]) && validPort(p3)) return build(proto, parts[2], p3, parts[0], parts[1]);
    return null;
  }
  if (parts.length > 4) {
    const p1 = toPort(parts[1]);
    if (p1 != null && isValidHost(parts[0])) return build(proto, parts[0], p1, parts[2], parts.slice(3).join(':'));
  }
  return null;
}

export function parseUrl(url) {
  const idx = url.indexOf('://');
  const proto = protocolForScheme(url.slice(0, idx));
  if (!proto) return null;
  const rest = url.slice(idx + 3).split('/')[0].split('?')[0].split('#')[0];
  return parseBare(rest, proto);
}

export function parseLine(input, defaultProtocol = PROTOCOLS.HTTP) {
  const token = String(input).trim().split(/[\s,;|]+/)[0]?.trim();
  if (!token || token.length > 512) return null;
  if (token.indexOf('://') > 0) return parseUrl(token);
  return parseBare(token, defaultProtocol);
}

/** Parses a whole list. Returns { proxies, invalid, duplicates, xray } (xray = share links browsers can't use). */
export function parseList(text, defaultProtocol = PROTOCOLS.HTTP) {
  const seen = new Map();
  let invalid = 0;
  let duplicates = 0;
  let xray = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const trimmed = raw.trim();
    const scheme = /^([a-z0-9]+):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
    if (scheme && XRAY_SCHEMES.includes(scheme)) {
      xray++;
      continue;
    }
    const line = trimmed.split('#')[0].trim();
    if (!line) continue;
    const ep = parseLine(line, defaultProtocol);
    if (!ep) invalid++;
    else {
      const k = endpointKey(ep);
      if (seen.has(k)) duplicates++;
      else seen.set(k, ep);
    }
  }
  return { proxies: [...seen.values()], invalid, duplicates, xray };
}

/** Formats an endpoint back to a URL (used for export). Includes the password. */
export function toUrl(ep) {
  const host = ep.host.includes(':') ? `[${ep.host}]` : ep.host;
  const enc = (s) => encodeURIComponent(s);
  const auth = ep.username ? `${enc(ep.username)}:${enc(ep.password ?? '')}@` : '';
  return `${ep.protocol}://${auth}${host}:${ep.port}`;
}

/**
 * Chromium cannot authenticate to SOCKS5 proxies (Firefox can), so those endpoints are unusable there.
 * Returns a reason string or null when the endpoint can be used.
 */
export function browserUnsupportedReason(ep, { socksAuth = false } = {}) {
  if (ep.protocol === PROTOCOLS.SOCKS5 && ep.username && !socksAuth) return 'Chromium browsers cannot log in to SOCKS5 proxies';
  return null;
}
