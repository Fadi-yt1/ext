/** Domain normalisation and the app presets for "Only my sites" (port of Domains.kt). */
import { isIpv4 } from './proxyList.js';

export const PRESETS = [
  { id: 'youtube', label: 'YouTube', domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtube-nocookie.com', 'youtubei.googleapis.com'] },
  { id: 'instagram', label: 'Instagram', domains: ['instagram.com', 'cdninstagram.com', 'ig.me'] },
  { id: 'facebook', label: 'Facebook', domains: ['facebook.com', 'fb.com', 'fbcdn.net', 'facebook.net', 'fb.me', 'messenger.com', 'fbsbx.com'] },
  { id: 'x', label: 'X', domains: ['x.com', 'twitter.com', 'twimg.com', 't.co', 'x.ai'] },
  { id: 'discord', label: 'Discord', domains: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordcdn.com'] },
  {
    id: 'telegram',
    label: 'Telegram',
    domains: ['telegram.org', 't.me', 'telegram.me', 'telesco.pe', 'tdesktop.com', 'telegra.ph'],
    cidrs: ['91.108.4.0/22', '91.108.8.0/22', '91.108.12.0/22', '91.108.16.0/22', '91.108.20.0/22', '91.108.56.0/22', '149.154.160.0/20', '95.161.64.0/20', '185.76.151.0/24'],
  },
  { id: 'chatgpt', label: 'ChatGPT', domains: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'chat.com'] },
  { id: 'claude', label: 'Claude', domains: ['claude.ai', 'anthropic.com', 'claudeusercontent.com', 'claude.com'] },
  { id: 'netflix', label: 'Netflix', domains: ['netflix.com', 'netflix.net', 'nflxvideo.net', 'nflximg.net', 'nflxext.com', 'nflxso.net'] },
  { id: 'whatsapp', label: 'WhatsApp', domains: ['whatsapp.com', 'whatsapp.net', 'wa.me'] },
  { id: 'spotify', label: 'Spotify', domains: ['spotify.com', 'scdn.co', 'spotifycdn.com', 'spotify.design'] },
  { id: 'reddit', label: 'Reddit', domains: ['reddit.com', 'redd.it', 'redditmedia.com', 'redditstatic.com'] },
  { id: 'tiktok', label: 'TikTok', domains: ['tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'byteoversea.com', 'ibytedtos.com'] },
  { id: 'google', label: 'Google', domains: ['google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com'] },
];

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalises user input or a URL into a host name, or returns null when invalid.
 * Accepts "https://www.example.com/path?x", "example.com", "*.example.com", ".example.com", IDNs.
 */
export function normalizeDomain(input) {
  let s = String(input ?? '').trim();
  if (!s || s.length > 2048) return null;
  if (/\s/.test(s)) s = s.split(/\s+/).find((t) => t.includes('.')) ?? '';
  if (!s) return null;
  if (s.includes('://')) {
    const scheme = s.slice(0, s.indexOf('://')).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
    s = s.slice(s.indexOf('://') + 3);
  }
  s = s.split(/[/?#]/)[0];
  s = s.slice(s.lastIndexOf('@') + 1).replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
  if (!s || s.startsWith('[')) return null;
  s = s.split(':')[0];
  let ascii;
  try {
    ascii = new URL(`http://${s}/`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (ascii.length > 253 || !ascii.includes('.') || isIpv4(ascii)) return null;
  const labels = ascii.split('.');
  if (labels.some((l) => !LABEL_RE.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  const stripped = ascii.startsWith('www.') ? ascii.slice(4) : ascii;
  return stripped.includes('.') ? stripped : ascii;
}

/** True when `host` equals one of `domains` or is a subdomain of one. */
export function matchesDomain(host, domains) {
  const set = domains instanceof Set ? domains : new Set(domains);
  let h = String(host).toLowerCase().replace(/\.$/, '');
  for (;;) {
    if (set.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
}

/** Domains and CIDRs routed in "Only my sites" mode. */
export function collectSiteRules(settings) {
  const domains = new Set(settings.sites || []);
  const cidrs = new Set();
  for (const id of settings.presets || []) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) continue;
    p.domains.forEach((d) => domains.add(d));
    (p.cidrs || []).forEach((c) => cidrs.add(c));
  }
  return { domains: [...domains], cidrs: [...cidrs] };
}

/** "91.108.4.0/22" -> ["91.108.4.0", "255.255.252.0"], for PAC isInNet(). */
export function cidrToNetMask(cidr) {
  const [ip, bitsStr = '32'] = String(cidr).split('/');
  const bits = Number(bitsStr);
  if (!isIpv4(ip) || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const maskStr = [24, 16, 8, 0].map((s) => (mask >>> s) & 255).join('.');
  const ipNum = ip.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0) & mask;
  const netStr = [24, 16, 8, 0].map((s) => (ipNum >>> s) & 255).join('.');
  return [netStr, maskStr];
}
