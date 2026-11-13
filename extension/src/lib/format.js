/** Small display helpers shared by the popup and the options page. */

export function flag(cc) {
  if (!cc || !/^[A-Z]{2}$/.test(cc)) return '🌐';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let regionNames;
export function countryName(cc) {
  if (!cc) return 'Unknown';
  try {
    regionNames ??= new Intl.DisplayNames(undefined, { type: 'region' });
    return regionNames.of(cc) || cc;
  } catch {
    return cc;
  }
}

export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function ago(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function latencyClass(ms) {
  if (ms == null) return 'bad';
  if (ms < 700) return 'good';
  if (ms < 1800) return 'ok';
  return 'bad';
}
