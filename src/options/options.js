import { getSettings, updateSettings, DEFAULT_SETTINGS } from '../bg/store.js';
import { PRESETS, normalizeDomain } from '../lib/domains.js';
import { DEFAULT_SOURCES, DEFAULT_TRACE_URLS, guessProtocol } from '../lib/sources.js';
import { flag, countryName, ago, latencyClass } from '../lib/format.js';
import { IS_FIREFOX } from '../lib/platform.js';

const $ = (id) => document.getElementById(id);
const send = (cmd, extra = {}) => chrome.runtime.sendMessage({ cmd, ...extra });

let settings;
let servers = {};

function msg(id, text, error = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', error);
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
}

async function save(patch, note = 'Saved') {
  settings = await updateSettings(patch);
  toast(note);
  render();
}

// ---- simple bound inputs ----

function bindInputs() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const ev = el.type === 'checkbox' ? 'change' : el.tagName === 'SELECT' ? 'change' : 'change';
    el.addEventListener(ev, () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) return;
        if (el.min) v = Math.max(Number(el.min), v);
        if (el.max) v = Math.min(Number(el.max), v);
      }
      if (key === 'proxioKey') v = String(v).trim();
      save({ [key]: v });
    });
  });
}

function renderInputs() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (document.activeElement !== el) el.value = v ?? '';
  });
}

// ---- my sites ----

function renderSites() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
  $('presets').replaceChildren(
    ...PRESETS.map((p) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = p.label;
      b.title = p.domains.join(', ');
      b.setAttribute('aria-pressed', String(settings.presets.includes(p.id)));
      b.addEventListener('click', () => {
        const on = settings.presets.includes(p.id);
        save({ presets: on ? settings.presets.filter((x) => x !== p.id) : [...settings.presets, p.id] });
      });
      return b;
    }),
  );
  $('siteList').replaceChildren(
    ...settings.sites.map((d) => {
      const li = document.createElement('li');
      li.textContent = d;
      const x = document.createElement('button');
      x.textContent = '✕';
      x.setAttribute('aria-label', `Remove ${d}`);
      x.addEventListener('click', () => save({ sites: settings.sites.filter((s) => s !== d) }, 'Removed'));
      li.append(x);
      return li;
    }),
  );
  if (document.activeElement !== $('bypass')) $('bypass').value = settings.bypass.join('\n');
}

$('addSiteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('siteInput').value;
  const domains = raw.split(/[\s,]+/).filter(Boolean).map(normalizeDomain);
  const valid = domains.filter(Boolean);
  if (!valid.length) return msg('siteMsg', 'That does not look like a website address.', true);
  $('siteInput').value = '';
  msg('siteMsg', domains.length !== valid.length ? 'Some entries were not valid and were skipped.' : '');
  save({ sites: [...new Set([...settings.sites, ...valid])] }, 'Added');
});

$('bypass').addEventListener('change', () => {
  const list = $('bypass').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  save({ bypass: [...new Set(list)] });
});

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => save({ mode: b.dataset.mode })));

// ---- sources ----

function renderSources() {
  const items = [
    ...DEFAULT_SOURCES.map((s) => ({ ...s, builtin: true, enabled: settings.enabledSources.includes(s.url) })),
    ...settings.customSources.map((s) => {
      const u = new URL(s.url);
      return { name: `${u.hostname}/${u.pathname.split('/').pop()}`, url: s.url, protocol: s.protocol, builtin: false, enabled: s.enabled !== false };
    }),
  ];
  $('sourceList').replaceChildren(
    ...items.map((s) => {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.enabled;
      cb.disabled = !settings.useFreeLists;
      cb.addEventListener('change', () => {
        if (s.builtin) {
          const set = new Set(settings.enabledSources);
          cb.checked ? set.add(s.url) : set.delete(s.url);
          save({ enabledSources: DEFAULT_SOURCES.map((x) => x.url).filter((u) => set.has(u)) });
        } else {
          save({ customSources: settings.customSources.map((c) => (c.url === s.url ? { ...c, enabled: cb.checked } : c)) });
        }
      });
      const label = document.createElement('span');
      label.textContent = s.name;
      label.title = s.url;
      const proto = document.createElement('span');
      proto.className = 'faint';
      proto.style.flex = 'none';
      proto.textContent = s.protocol.toUpperCase();
      li.append(cb, label, proto);
      if (!s.builtin) {
        const x = document.createElement('button');
        x.textContent = '✕';
        x.setAttribute('aria-label', 'Remove list');
        x.addEventListener('click', () => save({ customSources: settings.customSources.filter((c) => c.url !== s.url) }, 'Removed'));
        li.append(x);
      }
      return li;
    }),
  );
}

$('sourceUrl').addEventListener('input', () => ($('sourceProto').value = guessProtocol($('sourceUrl').value)));
$('addSourceForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let url;
  try {
    url = new URL($('sourceUrl').value.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return msg('sourceMsg', 'Enter an http(s) URL of a text list.', true);
  }
  if (settings.customSources.some((s) => s.url === url.href) || DEFAULT_SOURCES.some((s) => s.url === url.href)) return msg('sourceMsg', 'That list is already added.', true);
  $('sourceUrl').value = '';
  msg('sourceMsg', '');
  save({ customSources: [...settings.customSources, { url: url.href, protocol: $('sourceProto').value, enabled: true }] }, 'List added');
});

$('refreshLists').addEventListener('click', async () => {
  msg('sourceMsg', 'Downloading lists and testing servers… (you can close this page)');
  const r = await send('refreshServers');
  msg('sourceMsg', r?.ok ? `${r.working} working servers ready.` : r?.error || 'Failed', !r?.ok);
});
$('clearFree').addEventListener('click', async () => {
  await send('clearFree');
  msg('sourceMsg', 'Free servers forgotten. They will be downloaded and tested again on the next connect.');
});

// ---- your servers ----

function renderOwn() {
  const own = Object.values(servers).filter((s) => s.origin === 'custom' || s.origin === 'proxio');
  own.sort((a, b) => (a.origin === b.origin ? (b.addedAt || 0) - (a.addedAt || 0) : a.origin === 'custom' ? -1 : 1));
  $('ownList').replaceChildren(
    ...own.map((s) => {
      const li = document.createElement('li');
      const f = document.createElement('span');
      f.textContent = flag(s.country);
      f.style.fontSize = '20px';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const n = document.createElement('div');
      n.className = 'name';
      n.textContent = s.name || `${s.host}:${s.port}`;
      const h = document.createElement('div');
      h.className = 'host';
      const status = s.alive ? `${countryName(s.country)} · exit ${s.ip}` : s.lastError ? `Not working: ${s.lastError}` : 'Not tested yet';
      h.textContent = `${s.protocol.toUpperCase()} ${s.host}:${s.port}${s.username ? ' · auth' : ''}${s.origin === 'proxio' ? ' · Proxio' : ''} — ${status} (${ago(s.lastChecked)})`;
      meta.append(n, h);
      const lat = document.createElement('span');
      lat.className = `pill ${s.alive ? latencyClass(s.latencyMs) : 'bad'}`;
      lat.textContent = s.alive ? `${s.latencyMs} ms` : s.lastChecked ? 'down' : '—';
      const test = document.createElement('button');
      test.className = 'btn small';
      test.textContent = 'Test';
      test.addEventListener('click', async () => {
        test.disabled = true;
        test.textContent = '…';
        const r = await send('testServer', { key: s.key });
        toast(r?.ok ? `Working · ${r.latencyMs} ms · ${r.country || ''}` : `Not working: ${r?.error}`);
      });
      const use = document.createElement('button');
      use.className = 'btn small';
      use.textContent = 'Connect';
      use.addEventListener('click', async () => {
        use.disabled = true;
        const r = await send('connect', { key: s.key });
        toast(r?.ok ? 'Connected' : r?.error || 'Failed');
        use.disabled = false;
      });
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        const r = await send('removeServer', { key: s.key });
        if (!r?.ok) toast(r?.error || 'Failed');
      });
      li.append(f, meta, lat, test, use, del);
      return li;
    }),
  );
}

async function importText(text) {
  const r = await send('importServers', { text, name: $('importName').value.trim() || null });
  if (!r || r.ok === false) return msg('importMsg', r?.error || 'Import failed', true);
  const parts = [`${r.added} added`];
  if (r.duplicates) parts.push(`${r.duplicates} duplicates`);
  if (r.invalid) parts.push(`${r.invalid} invalid lines skipped`);
  if (r.xray) parts.push(`${r.xray} VLESS/VMess/Trojan/SS links need the Android app`);
  if (r.unsupported) parts.push(`${r.unsupported} SOCKS5 with password not supported by this browser`);
  msg('importMsg', parts.join(' · ') + (r.added ? ' — testing…' : ''), r.added === 0);
  if (r.added) {
    $('importText').value = '';
    $('importName').value = '';
    const t = await send('testKeys', { keys: r.keys });
    msg('importMsg', `${parts.join(' · ')} — ${t.working}/${t.tested} working.`);
  }
}

$('importBtn').addEventListener('click', () => {
  const text = $('importText').value;
  if (!text.trim()) return msg('importMsg', 'Paste at least one proxy.', true);
  importText(text);
});
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 3_000_000) return msg('importMsg', 'File too large.', true);
  importText(await file.text());
  e.target.value = '';
});

// ---- advanced ----

function renderTrace() {
  if (document.activeElement !== $('traceUrls')) $('traceUrls').value = settings.traceUrls.join('\n');
}

$('traceUrls').addEventListener('change', () => {
  const urls = $('traceUrls')
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => {
      try {
        return /^https?:$/.test(new URL(s).protocol);
      } catch {
        return false;
      }
    });
  if (!urls.length) return msg('calMsg', 'Keep at least one valid URL.', true);
  save({ traceUrls: [...new Set(urls)] });
});
$('resetTrace').addEventListener('click', () => save({ traceUrls: DEFAULT_TRACE_URLS }, 'Restored'));
$('recalibrate').addEventListener('click', async () => {
  msg('calMsg', 'Checking…');
  const r = await send('recalibrate');
  if (!r || r.ok === false) return msg('calMsg', r?.error || 'Failed', true);
  msg('calMsg', r.directOk ? `${r.directOk} of ${new Set(settings.traceUrls).size} endpoints answer from your network. Your IP: ${r.directIp}.` : 'No endpoint answered directly (Cloudflare may be blocked on your network). Tests will still try all of them through proxies.', !r.directOk);
});

$('exportBtn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['settings', 'servers']);
  const own = Object.fromEntries(Object.entries(data.servers || {}).filter(([, s]) => s.origin !== 'free' || s.favorite));
  const blob = new Blob([JSON.stringify({ app: 'tervyn-vpn-extension', version: 1, settings: data.settings || {}, servers: own }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tervyn-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  msg('backupMsg', 'Backup downloaded. It contains your server passwords and Proxio key — keep it private.');
});

$('importBackup').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'tervyn-vpn-extension') throw new Error('Not a Tervyn backup');
    const known = Object.keys(DEFAULT_SETTINGS);
    const patch = Object.fromEntries(Object.entries(data.settings || {}).filter(([k]) => known.includes(k)));
    const cur = (await chrome.storage.local.get('servers')).servers || {};
    await chrome.storage.local.set({ servers: { ...cur, ...(data.servers || {}) } });
    await save(patch, 'Backup restored');
    msg('backupMsg', `Restored settings and ${Object.keys(data.servers || {}).length} servers.`);
  } catch (err) {
    msg('backupMsg', `Could not import: ${err.message}`, true);
  }
});

$('resetAll').addEventListener('click', async () => {
  if (!confirm('Disconnect and delete all Tervyn settings, servers and history?')) return;
  await send('disconnect');
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  settings = await getSettings();
  servers = {};
  render();
  msg('backupMsg', 'Everything was reset.');
});

// ---- about ----

async function renderHistory() {
  const { history } = await chrome.storage.local.get('history');
  const items = (history || []).slice(0, 12);
  $('history').replaceChildren(
    ...(items.length
      ? items.map((h) => {
          const li = document.createElement('li');
          const what = { connect: 'Connected', switch: 'Switched server', disconnect: 'Disconnected' }[h.event] || h.event;
          li.textContent = `${new Date(h.at).toLocaleString()} — ${what}${h.country ? ` · ${flag(h.country)} ${countryName(h.country)}` : ''}${h.latencyMs ? ` · ${h.latencyMs} ms` : ''}`;
          return li;
        })
      : [Object.assign(document.createElement('li'), { textContent: 'Nothing yet.' })]),
  );
}

function render() {
  renderInputs();
  renderSites();
  renderSources();
  renderOwn();
  renderTrace();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.servers) {
    servers = changes.servers.newValue || {};
    renderOwn();
  }
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    render();
  }
  if (changes.history) renderHistory();
});

(async () => {
  settings = await getSettings();
  servers = (await chrome.storage.local.get('servers')).servers || {};
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  if (IS_FIREFOX) {
    const ALL = { origins: ['<all_urls>'] };
    const checkPerm = async () => $('permCard').classList.toggle('hidden', await chrome.permissions.contains(ALL));
    $('grantPerm').addEventListener('click', async () => {
      await chrome.permissions.request(ALL);
      checkPerm();
    });
    chrome.permissions.onAdded?.addListener(checkPerm);
    chrome.permissions.onRemoved?.addListener(checkPerm);
    checkPerm();
  }
  bindInputs();
  render();
  renderHistory();
})();
