/**
 * Firefox path: routing via proxy.onRequest. Real Firefox is exercised manually / in CI lint; here the
 * background controller runs against a simulated Firefox `chrome` API, and the shared route() is checked
 * to give the same answer as the generated PAC script for every host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildPac, route, compileRouting, toFirefoxProxyInfo } from '../../src/lib/pac.js';
import { browserUnsupportedReason } from '../../src/lib/proxyList.js';

const HOSTS = [
  'example.com', 'www.youtube.com', 'youtube.com', 'notyoutube.com', 't.me', '149.154.167.50', '149.155.0.1',
  '192.168.1.10', '10.2.3.4', '172.20.0.1', '127.0.0.1', '203.0.113.9', 'printer', 'nas.local', 'bank.com',
  'login.bank.com', '1.1.1.1', 'one.one.one.one', 'example.com.', 'EXAMPLE.org', '::1', 'fd00::1', '2001:db8::5',
];

const CONFIGS = [
  { active: null },
  { active: null, tests: { '1.1.1.1': 'SOCKS5 9.9.9.9:1080' } },
  { active: { protocol: 'http', host: '5.5.5.5', port: 8080 }, mode: 'all', bypass: ['bank.com', '203.0.113.0/24'] },
  { active: { protocol: 'socks5', host: '6.6.6.6', port: 1080 }, mode: 'sites', domains: ['youtube.com', 't.me'], cidrs: ['149.154.160.0/20'] },
  { active: { protocol: 'http', host: '2001:db8::1', port: 3128 }, mode: 'all', killSwitch: false, tests: { 'one.one.one.one': 'DIRECT' } },
];

test('PAC script (Chromium) and route() (Firefox) agree for every host', () => {
  for (const cfg of CONFIGS) {
    const ctx = { isPlainHostName: (h) => !h.includes('.') };
    vm.createContext(ctx);
    vm.runInContext(buildPac(cfg), ctx);
    const C = compileRouting(cfg);
    for (const h of HOSTS) {
      // Chromium passes IPv6 literals without brackets and host names lower-cased; both are normalised by route().
      assert.equal(ctx.FindProxyForURL(`https://${h}/`, h), route(C, h), `${JSON.stringify(cfg)} ${h}`);
    }
  }
});

test('directives convert to Firefox ProxyInfo', () => {
  assert.deepEqual(toFirefoxProxyInfo('DIRECT'), [{ type: 'direct' }]);
  assert.deepEqual(toFirefoxProxyInfo('PROXY 1.2.3.4:8080; DIRECT'), [{ type: 'http', host: '1.2.3.4', port: 8080, failoverTimeout: 5 }, { type: 'direct' }]);
  assert.deepEqual(toFirefoxProxyInfo('SOCKS5 [2001:db8::1]:1080', () => ({ username: 'u', password: 'p' })), [
    { type: 'socks', host: '2001:db8::1', port: 1080, failoverTimeout: 5, proxyDNS: true, username: 'u', password: 'p' },
  ]);
});

test('Firefox can use SOCKS5 proxies with a password, Chromium cannot', () => {
  const ep = { protocol: 'socks5', host: 'a.b', port: 1, username: 'u', password: 'p' };
  assert.ok(browserUnsupportedReason(ep, { socksAuth: false }));
  assert.equal(browserUnsupportedReason(ep, { socksAuth: true }), null);
});

/** Minimal simulated Firefox WebExtension API. */
function fakeFirefox() {
  const data = { local: {}, session: {} };
  const area = (name) => ({
    get: async (keys) => {
      const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data[name]);
      return Object.fromEntries(ks.filter((k) => k in data[name]).map((k) => [k, structuredClone(data[name][k])]));
    },
    set: async (obj) => Object.assign(data[name], structuredClone(obj)),
  });
  const listeners = {};
  const ev = (name) => ({ addListener: (fn, ...rest) => (listeners[name] = { fn, rest }) });
  return {
    listeners,
    chrome: {
      runtime: { getURL: (p) => `moz-extension://1234/${p}` },
      storage: { local: area('local'), session: area('session') },
      proxy: {
        onRequest: ev('onRequest'),
        onError: ev('onError'),
        settings: { set: () => assert.fail('Firefox must not use proxy.settings'), clear: () => assert.fail('Firefox must not use proxy.settings') },
      },
      webRequest: { onAuthRequired: ev('onAuthRequired') },
      permissions: { contains: async () => true },
      privacy: { network: { webRTCIPHandlingPolicy: { set: async () => {}, clear: async () => {} } } },
    },
  };
}

test('Firefox controller routes requests via proxy.onRequest and logs in to proxies', async () => {
  const ff = fakeFirefox();
  globalThis.chrome = ff.chrome;
  const ctl = await import(`../../src/bg/controller.js?firefox=${Date.now()}`);
  const { IS_FIREFOX } = await import(`../../src/lib/platform.js?firefox=${Date.now()}`);
  assert.ok(IS_FIREFOX);
  ctl.registerProxyHandler();
  ctl.registerAuthHandler();
  let proxyErrors = 0;
  ctl.onProxyError(() => proxyErrors++);
  assert.ok(ff.listeners.onRequest && ff.listeners.onAuthRequired && ff.listeners.onError);
  assert.deepEqual(ff.listeners.onAuthRequired.rest[1], ['blocking']);

  await ctl.restore();
  const req = (url) => ff.listeners.onRequest.fn({ url });
  assert.deepEqual(await req('https://example.com/'), [{ type: 'direct' }]);

  // Connected through a SOCKS5 server with a password (Firefox-only capability).
  await ctl.setActive({ protocol: 'socks5', host: '7.7.7.7', port: 1080, username: 'bob', password: 's3cret' });
  assert.deepEqual(await req('https://example.com/path'), [{ type: 'socks', host: '7.7.7.7', port: 1080, failoverTimeout: 5, proxyDNS: true, username: 'bob', password: 's3cret' }]);
  assert.deepEqual(await req('http://192.168.0.1/'), [{ type: 'direct' }]);

  // Test slot: one trace host goes through the proxy under test.
  ctl.setTest('1.1.1.1', { protocol: 'http', host: '8.8.8.8', port: 3128, username: 'amy', password: 'pw' });
  await ctl.apply();
  assert.deepEqual(await req('https://1.1.1.1/cdn-cgi/trace'), [{ type: 'http', host: '8.8.8.8', port: 3128, failoverTimeout: 5 }]);
  const auth = await ff.listeners.onAuthRequired.fn({ isProxy: true, requestId: 'r1', challenger: { host: '8.8.8.8', port: 3128 } });
  assert.deepEqual(auth, { authCredentials: { username: 'amy', password: 'pw' } });
  assert.deepEqual(await ff.listeners.onAuthRequired.fn({ isProxy: false, requestId: 'r2', challenger: { host: 'x', port: 1 } }), {});
  await ctl.clearTests();
  assert.deepEqual(await req('https://1.1.1.1/cdn-cgi/trace'), [{ type: 'socks', host: '7.7.7.7', port: 1080, failoverTimeout: 5, proxyDNS: true, username: 'bob', password: 's3cret' }]);

  // "Only my sites" mode follows settings changes.
  await ctl.setSettings({ mode: 'sites', sites: ['youtube.com'], presets: [], bypass: [], killSwitch: false });
  assert.equal((await req('https://m.youtube.com/')).length, 2); // proxy + DIRECT fallback (kill switch off)
  assert.deepEqual(await req('https://example.com/'), [{ type: 'direct' }]);

  await ctl.setActive(null);
  assert.deepEqual(await req('https://m.youtube.com/'), [{ type: 'direct' }]);
  ff.listeners.onError.fn(new Error('x'));
  assert.equal(proxyErrors, 1);
  assert.equal(await ctl.levelOfControl(), 'controlled_by_this_extension');
  delete globalThis.chrome;
});
