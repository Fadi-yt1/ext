/** Cloudflare /cdn-cgi/trace parsing. */

export function parseTrace(body) {
  const out = {};
  for (const line of String(body).split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Valid ISO country from `loc` (XX = unknown, T1 = Tor). */
export function traceCountry(t) {
  const loc = (t.loc || '').toUpperCase();
  return /^[A-Z]{2}$/.test(loc) && loc !== 'XX' && loc !== 'T1' ? loc : null;
}
