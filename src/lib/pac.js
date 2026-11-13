/**
 * Builds the PAC script Chrome uses for all routing decisions.
 *
 * Order of evaluation:
 *  1. Test slots: a handful of trace hosts routed through the proxy currently under test.
 *  2. Never proxied: plain host names, local/private networks and the user's bypass list.
 *  3. The active server, for every site ("all") or only for the user's sites and IP ranges ("sites").
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
 * @param {object} o
 * @param {object|null} o.active      endpoint of the connected server, or null when disconnected
 * @param {'all'|'sites'} o.mode
 * @param {string[]} o.domains        "Only my sites" domains
 * @param {string[]} o.cidrs          "Only my sites" IPv4 ranges
 * @param {string[]} o.bypass         never proxied (domains or CIDRs)
 * @param {Record<string,string>} o.tests  host -> PAC directive for proxies under test
 * @param {boolean} o.killSwitch      when the server is unreachable, block instead of falling back to DIRECT
 */
export function buildPac({ active = null, mode = 'all', domains = [], cidrs = [], bypass = [], tests = {}, killSwitch = true }) {
  const by = parseBypass(bypass);
  const site = {};
  domains.forEach((d) => (site[String(d).toLowerCase()] = 1));
  const bypassSet = {};
  by.domains.forEach((d) => (bypassSet[d] = 1));
  const siteNets = cidrs.map(cidrToNetMask).filter(Boolean);
  const proxy = active ? directive(active) + (killSwitch ? '' : '; DIRECT') : '';

  return `// Tervyn VPN routing (generated)
var TESTS = ${JSON.stringify(tests)};
var PROXY = ${JSON.stringify(proxy)};
var MODE = ${JSON.stringify(mode)};
var SITES = ${JSON.stringify(site)};
var SITE_NETS = ${JSON.stringify(siteNets)};
var BYPASS = ${JSON.stringify(bypassSet)};
var LOCAL_NETS = ${JSON.stringify([...PRIVATE_NETS, ...by.nets])};
function inSet(set, h) {
  for (;;) {
    if (set.hasOwnProperty(h)) return true;
    var i = h.indexOf('.');
    if (i < 0) return false;
    h = h.substring(i + 1);
  }
}
function isIp(h) { return /^\\d{1,3}(\\.\\d{1,3}){3}$/.test(h); }
function inNets(nets, h) {
  for (var i = 0; i < nets.length; i++) if (isInNet(h, nets[i][0], nets[i][1])) return true;
  return false;
}
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (TESTS.hasOwnProperty(host)) return TESTS[host];
  if (!PROXY) return 'DIRECT';
  if (isPlainHostName(host) || /\\.(local|localhost|lan|internal|arpa|home\\.arpa)$/.test(host)) return 'DIRECT';
  if (host.indexOf(':') >= 0) { if (host === '::1' || /^(fe80|fc|fd)/.test(host)) return 'DIRECT'; }
  if (isIp(host) && inNets(LOCAL_NETS, host)) return 'DIRECT';
  if (inSet(BYPASS, host)) return 'DIRECT';
  if (MODE === 'sites') {
    if (inSet(SITES, host)) return PROXY;
    if (isIp(host) && inNets(SITE_NETS, host)) return PROXY;
    return 'DIRECT';
  }
  return PROXY;
}
`;
}
