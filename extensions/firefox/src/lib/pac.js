/**
 * Routing decisions, shared by both browser engines:
 *  - Chromium: `buildPac()` embeds `route()` and its helpers verbatim into a PAC script.
 *  - Firefox:  `route()` is called directly from proxy.onRequest.
 * One implementation means both browsers route every host the same way.
 *
 * Order of evaluation:
 *  1. Test slots: a handful of trace hosts routed through the proxy currently under test.
 *  2. Never proxied: plain host names, local/private networks and the user's bypass list.
 *  3. The active server, for every site ("all") or only for the user's sites and IP ranges ("sites").
 *
 * The helpers below must stay self-contained (no imports, no closures): their source is copied into the PAC.
 */
import { cidrToNetMask } from './domains.js';

/** PAC directive for an endpoint ("PROXY 1.2.3.4:8080" / "SOCKS5 [::1]:1080"). */
export function directive(ep) {
  if (!ep) return 'DIRECT';
  const host = ep.host.includes(':') ? `[${ep.host}]` : ep.host;
  return `${ep.protocol === 'socks5' ? 'SOCKS5' : 'PROXY'} ${host}:${ep.port}`;
}

const PRIVATE_NETS = [
  ['10.0.0.0', '255.0.0.0'],
  ['127.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['169.254.0.0', '255.255.0.0'],
  ['100.64.0.0', '255.192.0.0'],
];

/** Splits user bypass rules into exact/suffix domains and IPv4 CIDRs. */
export function parseBypass(list) {
  const domains = [];
  const nets = [];
  for (const raw of list || []) {
    const r = String(raw).trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
    if (!r) continue;
    const nm = r.includes('/') ? cidrToNetMask(r) : null;
    if (nm) nets.push(nm);
    else if (/^[a-z0-9.-]+$/.test(r)) domains.push(r);
  }
  return { domains, nets };
}

/**
 * Compiles routing options into plain data (JSON-serialisable) for `route()`.
 * @param {object} o
 * @param {object|null} o.active      endpoint of the connected server, or null when disconnected
 * @param {'all'|'sites'} o.mode
 * @param {string[]} o.domains        "Only my sites" domains
 * @param {string[]} o.cidrs          "Only my sites" IPv4 ranges
 * @param {string[]} o.bypass         never proxied (domains or CIDRs)
 * @param {Record<string,string>} o.tests  host -> directive for proxies under test
 * @param {boolean} o.killSwitch      when the server is unreachable, block instead of falling back to DIRECT
 */
export function compileRouting({ active = null, mode = 'all', domains = [], cidrs = [], bypass = [], tests = {}, killSwitch = true }) {
  const by = parseBypass(bypass);
  const sites = {};
  domains.forEach((d) => (sites[String(d).toLowerCase()] = 1));
  const bypassSet = {};
  by.domains.forEach((d) => (bypassSet[d] = 1));
  return {
    tests: { ...tests },
    proxy: active ? directive(active) + (killSwitch ? '' : '; DIRECT') : '',
    mode,
    sites,
    siteNets: cidrs.map(cidrToNetMask).filter(Boolean),
    bypass: bypassSet,
    localNets: [...PRIVATE_NETS, ...by.nets],
  };
}

// ---- self-contained helpers (copied into the PAC script) ----

function inSet(set, h) {
  for (;;) {
    if (Object.prototype.hasOwnProperty.call(set, h)) return true;
    var i = h.indexOf('.');
    if (i < 0) return false;
    h = h.substring(i + 1);
  }
}

function isIp(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

function ipNum(s) {
  var p = s.split('.');
  return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
}

function inNets(nets, h) {
  var n = ipNum(h);
  for (var i = 0; i < nets.length; i++) {
    var m = ipNum(nets[i][1]);
    if (((n & m) >>> 0) === ((ipNum(nets[i][0]) & m) >>> 0)) return true;
  }
  return false;
}

/** Returns a PAC-style directive ("DIRECT", "PROXY h:p", "SOCKS5 h:p; DIRECT") for `host`. */
function route(C, host) {
  host = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (Object.prototype.hasOwnProperty.call(C.tests, host)) return C.tests[host];
  if (!C.proxy) return 'DIRECT';
  if (host.indexOf('.') < 0 && host.indexOf(':') < 0) return 'DIRECT';
  if (/\.(local|localhost|lan|internal|arpa)$/.test(host)) return 'DIRECT';
  if (host.indexOf(':') >= 0 && (host === '::1' || /^(fe80|fc|fd)/.test(host))) return 'DIRECT';
  if (isIp(host) && inNets(C.localNets, host)) return 'DIRECT';
  if (inSet(C.bypass, host)) return 'DIRECT';
  if (C.mode === 'sites') {
    if (inSet(C.sites, host)) return C.proxy;
    if (isIp(host) && inNets(C.siteNets, host)) return C.proxy;
    return 'DIRECT';
  }
  return C.proxy;
}

export { route };

export function buildPac(options) {
  const C = compileRouting(options);
  return `// Tervyn VPN routing (generated)
var C = ${JSON.stringify(C)};
${inSet}
${isIp}
${ipNum}
${inNets}
${route}
function FindProxyForURL(url, host) {
  return route(C, host);
}
`;
}

/**
 * Converts a directive into Firefox proxy.onRequest ProxyInfo objects.
 * `auth(host, port)` returns { username, password } for proxies that need a login.
 */
export function toFirefoxProxyInfo(dir, auth = () => null) {
  return String(dir)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      if (part === 'DIRECT') return { type: 'direct' };
      const [kind, hp] = part.split(/\s+/);
      const m = /^\[?(.+?)\]?:(\d+)$/.exec(hp);
      const host = m[1];
      const port = Number(m[2]);
      const info = { type: kind === 'SOCKS5' ? 'socks' : 'http', host, port, failoverTimeout: 5 };
      if (kind === 'SOCKS5') info.proxyDNS = true;
      const cred = auth(host, port);
      if (cred && kind === 'SOCKS5') {
        info.username = cred.username;
        info.password = cred.password;
      }
      return info;
    });
}
