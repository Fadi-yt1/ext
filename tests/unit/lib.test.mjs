import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseList, parseLine, endpointKey, toUrl, browserUnsupportedReason } from '../../src/lib/proxyList.js';
import { normalizeDomain, matchesDomain, cidrToNetMask, collectSiteRules } from '../../src/lib/domains.js';
import { buildPac, directive } from '../../src/lib/pac.js';
import { rank, decide, isClearlyFaster, score } from '../../src/lib/ranking.js';
import { parseTrace, traceCountry } from '../../src/lib/trace.js';
import { parseProxio } from '../../src/lib/proxio.js';
import { flag, duration } from '../../src/lib/format.js';

test('parses every supported proxy line format', () => {
  assert.deepEqual(parseLine('1.2.3.4:8080'), { protocol: 'http', host: '1.2.3.4', port: 8080 });
  assert.deepEqual(parseLine('1.2.3.4:1080', 'socks5'), { protocol: 'socks5', host: '1.2.3.4', port: 1080 });
  assert.deepEqual(parseLine('h.example.com:3128:bob:pa:ss'), { protocol: 'http', host: 'h.example.com', port: 3128, username: 'bob', password: 'pa:ss' });
  assert.deepEqual(parseLine('bob:secret@1.2.3.4:8080'), { protocol: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'secret' });
  assert.deepEqual(parseLine('bob:secret:1.2.3.4:8080'), { protocol: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'secret' });
  assert.deepEqual(parseLine('socks5h://u%40x:p%3Aw@[2001:db8::1]:1080/'), { protocol: 'socks5', host: '2001:db8::1', port: 1080, username: 'u@x', password: 'p:w' });
  assert.deepEqual(parseLine('https://5.6.7.8:443'), { protocol: 'http', host: '5.6.7.8', port: 443 });
  assert.deepEqual(parseLine('9.9.9.9:80 US elite'), { protocol: 'http', host: '9.9.9.9', port: 80 });
  for (const bad of ['', '1.2.3.4', '1.2.3.4:0', '1.2.3.4:70000', '999.1.1.1:80', 'ftp://1.2.3.4:21', 'a b']) assert.equal(parseLine(bad), null, bad);
});

test('parseList dedupes, counts invalid lines and Xray links', () => {
  const r = parseList('# comment\n1.2.3.4:80\n1.2.3.4:80\nnope\nvless://uuid@h:443?x#name\nsocks5://5.5.5.5:1080 # trailing\n');
  assert.equal(r.proxies.length, 2);
  assert.equal(r.duplicates, 1);
  assert.equal(r.invalid, 1);
  assert.equal(r.xray, 1);
  assert.equal(endpointKey(r.proxies[1]), 'socks5://5.5.5.5:1080');
});

test('toUrl round-trips with credentials', () => {
  const ep = { protocol: 'http', host: 'a.b', port: 81, username: 'u s', password: 'p@ss' };
  assert.deepEqual(parseLine(toUrl(ep)), ep);
});

test('SOCKS5 with password is flagged as unsupported in browsers', () => {
  assert.ok(browserUnsupportedReason({ protocol: 'socks5', host: 'a', port: 1, username: 'u' }));
  assert.equal(browserUnsupportedReason({ protocol: 'http', host: 'a', port: 1, username: 'u' }), null);
});

test('normalizes domains like the app', () => {
  assert.equal(normalizeDomain('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(normalizeDomain('*.example.org'), 'example.org');
  assert.equal(normalizeDomain('.example.org.'), 'example.org');
  assert.equal(normalizeDomain('user@example.org:8443/x'), 'example.org');
  assert.equal(normalizeDomain('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(normalizeDomain('check this https://news.ycombinator.com/item'), 'news.ycombinator.com');
  for (const bad of ['localhost', '1.2.3.4', 'ftp://x.com', 'exa mple', 'a..b', '-a.com', 'example.123']) assert.equal(normalizeDomain(bad), null, bad);
});

test('matches domains and subdomains only', () => {
  assert.ok(matchesDomain('m.youtube.com', ['youtube.com']));
  assert.ok(matchesDomain('youtube.com.', ['youtube.com']));
  assert.ok(!matchesDomain('notyoutube.com', ['youtube.com']));
});

test('CIDR to PAC net/mask', () => {
  assert.deepEqual(cidrToNetMask('91.108.4.0/22'), ['91.108.4.0', '255.255.252.0']);
  assert.deepEqual(cidrToNetMask('10.1.2.3/8'), ['10.0.0.0', '255.0.0.0']);
  assert.deepEqual(cidrToNetMask('0.0.0.0/0'), ['0.0.0.0', '0.0.0.0']);
  assert.equal(cidrToNetMask('1.2.3.4/33'), null);
});

test('collectSiteRules merges presets and custom sites', () => {
  const r = collectSiteRules({ sites: ['example.com'], presets: ['telegram'] });
  assert.ok(r.domains.includes('example.com') && r.domains.includes('t.me'));
  assert.ok(r.cidrs.includes('149.154.160.0/20'));
});

/** Evaluates a generated PAC script with minimal implementations of the PAC helper functions. */
function pac(o) {
  const ctx = {
    isPlainHostName: (h) => !h.includes('.'),
    isInNet: (h, net, mask) => {
      const n = (s) => s.split('.').reduce((a, x) => ((a << 8) | Number(x)) >>> 0, 0);
      return ((n(h) & n(mask)) >>> 0) === ((n(net) & n(mask)) >>> 0);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(buildPac(o), ctx);
  return (host) => ctx.FindProxyForURL(`https://${host}/`, host);
}

test('PAC: all-sites mode with bypass, local networks and test slots', () => {
  const active = { protocol: 'socks5', host: '5.5.5.5', port: 1080 };
  const f = pac({ active, mode: 'all', bypass: ['bank.com', '203.0.113.0/24'], tests: { '1.1.1.1': 'PROXY 9.9.9.9:80' } });
  assert.equal(f('example.com'), 'SOCKS5 5.5.5.5:1080');
  assert.equal(f('www.bank.com'), 'DIRECT');
  assert.equal(f('203.0.113.9'), 'DIRECT');
  assert.equal(f('192.168.1.1'), 'DIRECT');
  assert.equal(f('printer'), 'DIRECT');
  assert.equal(f('nas.local'), 'DIRECT');
  assert.equal(f('1.1.1.1'), 'PROXY 9.9.9.9:80');
});

test('PAC: only-my-sites mode routes listed domains and CIDRs', () => {
  const active = { protocol: 'http', host: '6.6.6.6', port: 3128 };
  const f = pac({ active, mode: 'sites', domains: ['youtube.com'], cidrs: ['149.154.160.0/20'] });
  assert.equal(f('www.youtube.com'), 'PROXY 6.6.6.6:3128');
  assert.equal(f('149.154.167.50'), 'PROXY 6.6.6.6:3128');
  assert.equal(f('example.com'), 'DIRECT');
});

test('PAC: kill switch off adds DIRECT fallback; disconnected is DIRECT except tests', () => {
  const active = { protocol: 'http', host: '6.6.6.6', port: 3128 };
  assert.equal(pac({ active, killSwitch: false })('a.com'), 'PROXY 6.6.6.6:3128; DIRECT');
  const off = pac({ active: null, tests: { 'one.one.one.one': 'SOCKS5 [2001:db8::2]:1080' } });
  assert.equal(off('a.com'), 'DIRECT');
  assert.equal(off('one.one.one.one'), 'SOCKS5 [2001:db8::2]:1080');
  assert.equal(directive({ protocol: 'socks5', host: '2001:db8::2', port: 1080 }), 'SOCKS5 [2001:db8::2]:1080');
});

test('ranking prefers fast, fresh, reliable and favorite servers', () => {
  const now = 1_000_000;
  const s = (key, latencyMs, extra = {}) => ({ key, latencyMs, alive: true, lastChecked: now, failCount: 0, ...extra });
  const r = rank([s('a', 300), s('b', 200), s('c', 100, { alive: false }), s('d', 210, { favorite: true }), s('e', 150, { country: 'DE' })], null, now);
  assert.deepEqual(r.map((x) => x.key), ['e', 'd', 'b', 'a']);
  assert.deepEqual(rank([s('a', 1, { country: 'US' }), s('b', 1, { country: 'DE' })], 'DE', now).map((x) => x.key), ['b']);
  assert.ok(score(s('x', 100, { failCount: 1 }), now) > score(s('y', 300), now));
});

test('auto-switch policy: 40 % rule, hysteresis and cool-down', () => {
  const active = { key: 'a', alive: true, latencyMs: 1000 };
  const fast = { key: 'b', alive: true, latencyMs: 500 };
  const base = { autoSwitch: true, active, activeAlive: true, candidates: [fast], thresholdPct: 40, lastSwitchAt: 0, now: 10 * 60000 };
  assert.ok(isClearlyFaster(600, 1000, 40));
  assert.ok(!isClearlyFaster(601, 1000, 40));
  assert.equal(decide({ ...base, consecutiveFasterChecks: 0 }).switchTo, null);
  assert.equal(decide({ ...base, consecutiveFasterChecks: 1 }).switchTo, fast);
  assert.equal(decide({ ...base, consecutiveFasterChecks: 1, lastSwitchAt: 9 * 60000 }).switchTo, null);
  assert.equal(decide({ ...base, activeAlive: false, consecutiveFasterChecks: 0 }).switchTo, fast);
  assert.equal(decide({ ...base, autoSwitch: false, activeAlive: false }).switchTo, null);
});

test('trace parsing and country validation', () => {
  const t = parseTrace('fl=1\nip=203.0.113.5\nloc=de\nwarp=off');
  assert.equal(t.ip, '203.0.113.5');
  assert.equal(traceCountry(t), 'DE');
  assert.equal(traceCountry({ loc: 'XX' }), null);
  assert.equal(traceCountry({ loc: 'T1' }), null);
});

test('Proxio responses: text, JSON arrays, objects and errors', () => {
  assert.equal(parseProxio('1.1.1.1:80\n2.2.2.2:81', 'http').length, 2);
  assert.deepEqual(parseProxio('{"data":[{"ip":"3.3.3.3","port":"1080","type":"socks5","login":"u","pass":"p"}]}', 'http'), [
    { protocol: 'socks5', host: '3.3.3.3', port: 1080, username: 'u', password: 'p' },
  ]);
  assert.equal(parseProxio('["socks5://4.4.4.4:1080","4.4.4.4:1080"]', 'socks5').length, 1);
  assert.throws(() => parseProxio('{"error":"bad key"}', 'http'), /bad key/);
});

test('format helpers', () => {
  assert.equal(flag('DE'), '🇩🇪');
  assert.equal(flag(null), '🌐');
  assert.equal(duration(3_725_000), '1:02:05');
  assert.equal(duration(65_000), '01:05');
});
