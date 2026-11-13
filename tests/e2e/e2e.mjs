/**
 * End-to-end test: loads the unpacked extension into Chromium and drives it against local mock proxies.
 *
 *   direct server  :DIRECT  serves the "real" trace (ip 198.51.100.100), proxy lists, and direct pages
 *   proxy A  HTTP    fast (DE)                      -> should be chosen as fastest
 *   proxy E  SOCKS5  slower (US)
 *   proxy B  HTTP    requires user/pass (NL)        -> imported as "your server", tests proxy auth
 *   proxy C          dead (nothing listening)
 *   proxy D  HTTP    "transparent": reports the real IP -> must be rejected
 *
 * Chromium maps every *.test host name to 127.0.0.1, and the extension's test endpoints are
 * http://tN.test:DIRECT/cdn-cgi/trace, so no Internet access is needed.
 *
 * Run: npm run test:e2e   (set SCREENSHOTS=dir to save popup/options screenshots)
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// require() also finds a globally installed Playwright (NODE_PATH); `npm i -D playwright` works too.
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_IP = '198.51.100.100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function respond(id, ip, loc, reqUrl, hostHeader) {
  const u = new URL(reqUrl, `http://${hostHeader || 'x'}`);
  if (u.pathname === '/cdn-cgi/trace') return { type: 'text/plain', body: `fl=1\nh=${u.hostname}\nip=${ip}\nloc=${loc}\n` };
  return { type: 'text/plain', body: `via ${id} host ${u.hostname}` };
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

/** HTTP proxy that answers requests itself, as if it were the destination. */
async function httpProxy({ id, ip, loc, delay = 0, auth = null }) {
  const server = http.createServer(async (req, res) => {
    await sleep(delay);
    if (auth) {
      const got = req.headers['proxy-authorization'];
      if (got !== `Basic ${Buffer.from(auth).toString('base64')}`) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="tervyn-test"', 'Content-Length': 0 });
        return res.end();
      }
    }
    const r = respond(id, ip, loc, req.url, req.headers.host);
    res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'no-store' });
    res.end(r.body);
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.kill = () => {
    server.close();
    sockets.forEach((s) => s.destroy());
  };
  server.port = await listen(server);
  return server;
}

/** Minimal SOCKS5 proxy (no auth) that serves HTTP itself on the tunnelled stream. */
async function socksProxy({ id, ip, loc, delay = 0 }) {
  const inner = http.createServer(async (req, res) => {
    await sleep(delay);
    const r = respond(id, ip, loc, req.url, req.headers.host);
    res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'no-store' });
    res.end(r.body);
  });
  const server = net.createServer((sock) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        buf = buf.subarray(2 + buf[1]);
        sock.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 5) {
        const atyp = buf[3];
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4];
        if (buf.length < 4 + len + 2) return;
        buf = buf.subarray(4 + len + 2);
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        stage = 2;
        sock.off('data', onData);
        if (buf.length) sock.unshift(buf);
        inner.emit('connection', sock);
      }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  });
  server.port = await listen(server);
  return server;
}

async function main() {
  // ---- mock network ----
  let lists = { http: '', socks: '' };
  const direct = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/http.txt' || u.pathname === '/socks.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(u.pathname === '/http.txt' ? lists.http : lists.socks);
    }
    const r = respond('direct', REAL_IP, 'US', req.url, req.headers.host);
    res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'no-store' });
    res.end(r.body);
  });
  const D = await listen(direct);
  const A = await httpProxy({ id: 'A', ip: '203.0.113.1', loc: 'DE', delay: 20 });
  const B = await httpProxy({ id: 'B', ip: '203.0.113.2', loc: 'NL', delay: 120, auth: 'alice:s3cr:t' });
  const Dt = await httpProxy({ id: 'D', ip: REAL_IP, loc: 'US' });
  const E = await socksProxy({ id: 'E', ip: '203.0.113.5', loc: 'US', delay: 300 });
  const deadPort = await (async () => {
    const s = net.createServer();
    const p = await listen(s);
    s.close();
    return p;
  })();
  lists = {
    http: `# mock list\n127.0.0.1:${A.port}\n127.0.0.1:${Dt.port}\n127.0.0.1:${deadPort}\ngarbage line\n`,
    socks: `127.0.0.1:${E.port}\n`,
  };

  // ---- browser ----
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tervyn-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--host-resolver-rules=MAP *.test 127.0.0.1'],
  });
  let failed = false;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    await sleep(500);
    // The extension opens its options page on install.
    let ext = context.pages().find((p) => p.url().startsWith(`chrome-extension://${extId}/`)) || (await context.newPage());
    if (!ext.url().startsWith('chrome-extension://')) await ext.goto(`chrome-extension://${extId}/src/options/options.html`);
    await ext.waitForLoadState();
    const send = (cmd, extra = {}) => ext.evaluate(([c, e]) => chrome.runtime.sendMessage({ cmd: c, ...e }), [cmd, extra]);
    const storage = (keys) => ext.evaluate((k) => chrome.storage.local.get(k), keys);
    const setSettings = (patch) =>
      ext.evaluate(async (p) => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...(settings || {}), ...p } });
      }, patch);
    const web = await context.newPage();
    const browse = async (host) => {
      const page = web;
      try {
        await page.goto(`http://${host}:${D}/page`, { timeout: 8000 });
        return (await page.textContent('body')).trim();
      } catch (e) {
        return `ERROR ${e.message.split('\n')[0]}`;
      }
    };
    const step = (name) => console.log(`• ${name}`);

    await setSettings({
      enabledSources: [],
      customSources: [
        { url: `http://lists.test:${D}/http.txt`, protocol: 'http', enabled: true },
        { url: `http://lists.test:${D}/socks.txt`, protocol: 'socks5', enabled: true },
      ],
      traceUrls: [1, 2, 3].map((n) => `http://t${n}.test:${D}/cdn-cgi/trace`),
      testTimeoutMs: 3000,
      targetWorking: 5,
      notifications: false,
    });

    step('calibration finds the test endpoints and the real IP');
    const cal = await send('recalibrate');
    assert.equal(cal.directOk, 3);
    assert.equal(cal.directIp, REAL_IP);

    step('before connecting, browsing is direct');
    assert.match(await browse('site.test'), /^via direct/);

    step('connect: downloads lists, tests servers, picks the fastest verified one');
    const c1 = await send('connect');
    assert.ok(c1.ok, JSON.stringify(c1));
    let { state, servers } = await storage(['state', 'servers']);
    assert.equal(state.status, 'on');
    assert.equal(servers[state.activeKey].port, A.port);
    assert.equal(servers[state.activeKey].country, 'DE');
    assert.equal(servers[state.activeKey].ip, '203.0.113.1');
    assert.match(await browse('site.test'), /^via A host site\.test/);

    step('find more: the SOCKS5 server is verified; dead and IP-leaking proxies are rejected');
    const more = await send('refreshServers');
    assert.ok(more.ok, JSON.stringify(more));
    ({ servers } = await storage(['servers']));
    const byPort = (p) => Object.values(servers).find((s) => s.port === p);
    assert.equal(byPort(E.port)?.alive, true);
    assert.equal(byPort(E.port)?.protocol, 'socks5');
    assert.equal(byPort(E.port)?.country, 'US');
    assert.ok(!byPort(deadPort)?.alive);
    assert.ok(!byPort(Dt.port)?.alive, 'transparent proxy must not be accepted');
    const { dead } = await storage(['dead']);
    assert.ok(Object.keys(dead).some((k) => k.endsWith(`:${Dt.port}`)));
    assert.match(await browse('site.test'), /^via A/, 'still connected to A while testing');

    step('import your own server with a password (HTTP proxy auth)');
    const imp = await send('importServers', { text: `alice:s3cr:t@127.0.0.1:${B.port}\nvless://x@h:443\nsocks5://u:p@1.2.3.4:1080`, name: 'My NL box' });
    assert.equal(imp.added, 1);
    assert.equal(imp.xray, 1);
    assert.equal(imp.unsupported, 1);
    const t = await send('testKeys', { keys: imp.keys });
    assert.equal(t.working, 1);
    ({ servers } = await storage(['servers']));
    assert.equal(servers[imp.keys[0]].country, 'NL');
    assert.equal(servers[imp.keys[0]].name, 'My NL box');

    step('connect to a chosen server');
    const c2 = await send('connect', { key: imp.keys[0] });
    assert.ok(c2.ok, JSON.stringify(c2));
    assert.match(await browse('site.test'), /^via B host site\.test/);

    step('"Only my sites" mode routes just the listed sites');
    await setSettings({ mode: 'sites', sites: ['site.test'] });
    await sleep(300);
    assert.match(await browse('www.site.test'), /^via B/);
    assert.match(await browse('other.test'), /^via direct/);
    await setSettings({ mode: 'all', sites: [] });
    await sleep(300);
    assert.match(await browse('other.test'), /^via B/);

    step('failover: when the server dies, Tervyn switches to a working backup');
    B.kill();
    const chk = await send('checkNow');
    ({ state, servers } = await storage(['state', 'servers']));
    if (process.env.DEBUG) console.log(chk, state, servers[state.activeKey], await send('isBusy'));
    assert.equal(state.status, 'on');
    assert.notEqual(state.activeKey, imp.keys[0]);
    assert.ok([A.port, E.port].includes(servers[state.activeKey].port));
    assert.match(state.message, /stopped responding/);
    assert.match(await browse('site.test'), /^via (A|E)/);

    step('popup and options render');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForSelector('#hero[data-status="on"]');
    assert.equal(await popup.textContent('#statusText'), 'Protected');
    if (process.env.SCREENSHOTS) {
      fs.mkdirSync(process.env.SCREENSHOTS, { recursive: true });
      await popup.screenshot({ path: path.join(process.env.SCREENSHOTS, 'popup-connected.png') });
      await popup.click('#openServers');
      await popup.screenshot({ path: path.join(process.env.SCREENSHOTS, 'popup-servers.png') });
      await ext.setViewportSize({ width: 1100, height: 900 });
      await ext.reload();
      await ext.waitForFunction(() => document.querySelector('[data-key="autoSwitch"]').checked);
      await ext.screenshot({ path: path.join(process.env.SCREENSHOTS, 'options.png') });
    }

    step('disconnect restores the direct connection and clears the proxy setting');
    await send('disconnect');
    assert.match(await browse('site.test'), /^via direct/);
    const level = await ext.evaluate(() => chrome.proxy.settings.get({}).then((r) => r.value.mode));
    assert.equal(level, 'system');
    if (process.env.SCREENSHOTS) {
      await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
      await popup.waitForSelector('#hero[data-status="off"]');
      await popup.screenshot({ path: path.join(process.env.SCREENSHOTS, 'popup-off.png') });
    }
    console.log('\nAll end-to-end checks passed.');
  } catch (e) {
    failed = true;
    console.error('\nE2E FAILED:', e);
  } finally {
    await context.close();
    [direct, A, B, Dt, E].forEach((s) => (s.kill ? s.kill() : s.close()));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main();
