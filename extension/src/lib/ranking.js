/** Server ranking and the auto-switch decision policy (port of Ranking.kt; pure logic, unit tested). */

/** Lower is better. Unverified/dead servers rank last. Recent failures add a penalty. */
export function score(s, now = Date.now()) {
  if (!s.alive || s.latencyMs == null) return Number.MAX_VALUE;
  const agePenalty = (Math.max(0, now - (s.lastChecked || 0)) / 60000) * 2; // +2 ms per minute since check
  const failPenalty = (s.failCount || 0) * 250;
  const favoriteBonus = s.favorite ? -15 : 0;
  return s.latencyMs + agePenalty + failPenalty + favoriteBonus;
}

export function rank(servers, country = null, now = Date.now()) {
  return servers
    .filter((s) => s.alive && s.latencyMs != null && (!country || s.country === country))
    .sort((a, b) => score(a, now) - score(b, now));
}

/** `candidateMs` is at least `thresholdPct` % faster than `currentMs`. */
export function isClearlyFaster(candidateMs, currentMs, thresholdPct) {
  return candidateMs * 100 <= currentMs * (100 - thresholdPct);
}

/**
 * Decides whether to move off the active server.
 * - Active dead: switch to the best backup (only when auto-switch is on).
 * - Active alive: switch only if a backup is at least thresholdPct % faster, the advantage was seen on
 *   `requiredConsecutive` consecutive checks (hysteresis), and the last switch was at least minIntervalMs ago.
 */
export function decide({
  autoSwitch,
  active,
  activeAlive,
  candidates,
  thresholdPct,
  consecutiveFasterChecks,
  requiredConsecutive = 2,
  lastSwitchAt,
  now,
  minIntervalMs = 5 * 60000,
}) {
  if (!autoSwitch) return { switchTo: null, reason: 'Auto-switch disabled' };
  const best = candidates.find((c) => c.key !== active?.key && c.alive && c.latencyMs != null);
  if (!active || !activeAlive) {
    return best ? { switchTo: best, reason: 'Active server unavailable' } : { switchTo: null, reason: 'No backup available' };
  }
  if (!best) return { switchTo: null, reason: 'No faster server' };
  const cur = active.latencyMs;
  if (cur == null) return { switchTo: null, reason: 'Active latency unknown' };
  if (!isClearlyFaster(best.latencyMs, cur, thresholdPct)) return { switchTo: null, reason: 'Current server is fast enough' };
  if (consecutiveFasterChecks + 1 < requiredConsecutive) return { switchTo: null, reason: 'Waiting to confirm faster server', faster: true };
  if (now - lastSwitchAt < minIntervalMs) return { switchTo: null, reason: 'Switched recently', faster: true };
  return { switchTo: best, reason: `Found a server ${100 - Math.floor((best.latencyMs * 100) / cur)}% faster`, faster: true };
}
