import { getSettings, updateSettings, getState, DEFAULT_STATE } from '../bg/store.js';
import { normalizeDomain, matchesDomain, collectSiteRules, PRESETS } from '../lib/domains.js';
import { rank } from '../lib/ranking.js';
import { flag, countryName, duration, latencyClass, ago } from '../lib/format.js';

const $ = (id) => document.getElementById(id);
const send = (cmd, extra = {}) => chrome.runtime.sendMessage({ cmd, ...extra });

let settings;
let state = { ...DEFAULT_STATE };
let servers = {};
let progress = null;
let currentDomain = null;

const STATUS_TEXT = {
  off: ['Not protected', 'Tap to connect to the fastest free server'],
  connecting: ['Connecting…', 'Finding the fastest server'],
  on: ['Protected', ''],
  error: ['Not connected', ''],
};

async function load() {
  const data = await chrome.storage.local.get(['servers']);
  servers = data.servers || {};
  settings = await getSettings();
  state = await getState();
  progress = (await chrome.storage.session.get('progress')).progress || null;
  render();
}

function render() {
  renderHero();
  renderServerCard();
  renderCountries();
  renderMode();
  renderProgress();
  const working = rank(Object.values(servers)).length;
  $('serverCount').textContent = working;
  if (!$('servers').classList.contains('hidden')) renderList();
}

function renderHero() {
  const st = state.status;
  $('hero').dataset.status = st;
  const [title, sub] = STATUS_TEXT[st] || STATUS_TEXT.off;
  $('statusText').textContent = st === 'on' && state.message?.includes('kill switch') ? 'Blocked' : title;
  $('statusSub').textContent = state.message || sub;
  $('power').setAttribute('aria-label', st === 'on' || st === 'connecting' ? 'Disconnect' : 'Connect');
  $('timer').classList.toggle('hidden', st !== 'on' || !state.connectedAt);
  tick();
}

function tick() {
  if (state.status === 'on' && state.connectedAt) $('timer').textContent = `Connected for ${duration(Date.now() - state.connectedAt)}`;
}

function renderServerCard() {
  const s = state.status === 'on' || state.status === 'connecting' ? servers[state.activeKey] : null;
  const lat = $('srvLatency');
  if (s) {
    $('srvFlag').textContent = flag(s.country);
    $('srvTitle').textContent = s.name && s.origin !== 'free' ? s.name : countryName(s.country);
    $('srvSub').textContent = `IP ${s.ip || '—'} · ${s.protocol.toUpperCase()}${s.origin !== 'free' ? ' · ' + (s.origin === 'custom' ? 'your server' : 'Proxio') : ''}`;
    lat.textContent = `${s.latencyMs} ms`;
    lat.className = `pill ${latencyClass(s.latencyMs)}`;
  } else {
    $('srvFlag').textContent = settings.country ? flag(settings.country) : '⚡';
    $('srvTitle').textContent = settings.country ? countryName(settings.country) : 'Fastest server';
    $('srvSub').textContent = 'Chosen automatically when you connect';
    lat.className = 'pill hidden';
  }
}

function countryCounts() {
  const counts = new Map();
  rank(Object.values(servers)).forEach((s) => s.country && counts.set(s.country, (counts.get(s.country) || 0) + 1));
  return counts;
}

function fillCountrySelect(sel, first, selected) {
  const counts = countryCounts();
  if (selected && !counts.has(selected)) counts.set(selected, 0);
  const list = [...counts.entries()].sort((a, b) => countryName(a[0]).localeCompare(countryName(b[0])));
  sel.replaceChildren(new Option(first, ''));
  for (const [cc, n] of list) sel.add(new Option(`${flag(cc)} ${countryName(cc)} (${n})`, cc));
  sel.value = selected || '';
}

function renderCountries() {
  fillCountrySelect($('country'), '⚡ Fastest available', settings.country);
}

function renderMode() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
  const row = $('siteRow');
  row.classList.toggle('hidden', settings.mode !== 'sites' || !currentDomain);
  if (!currentDomain) return;
  $('siteName').textContent = currentDomain;
  const own = settings.sites.some((d) => matchesDomain(currentDomain, [d]));
  const preset = PRESETS.find((p) => settings.presets.includes(p.id) && matchesDomain(currentDomain, p.domains));
  const toggle = $('siteToggle');
  toggle.checked = own || Boolean(preset);
  toggle.disabled = Boolean(preset) && !own;
  $('siteHint').textContent = preset && !own ? `Included by the ${preset.label} preset` : toggle.checked ? 'Routed through Tervyn' : 'Not routed — tap to add';
  const total = collectSiteRules(settings).domains.length;
  if (!total) $('siteHint').textContent = 'Add this site to start using “Only my sites”';
}

function renderProgress() {
  const running = progress?.running;
  $('progressWrap').classList.toggle('hidden', !running);
  if (!running) return;
  $('progressPhase').textContent = progress.phase || 'Working…';
  const bar = $('progressBar');
  if (progress.total) {
    bar.classList.remove('indeterminate');
    bar.firstElementChild.style.width = `${Math.min(100, (progress.tested / progress.total) * 100)}%`;
    $('progressCount').textContent = progress.phase === 'Testing servers' ? `${progress.working} working · ${progress.tested}/${progress.total}` : `${progress.tested}/${progress.total}`;
  } else {
    bar.classList.add('indeterminate');
    $('progressCount').textContent = '';
  }
}

// ---- servers view ----

function renderList() {
  fillCountrySelect($('filterCountry'), 'All countries', $('filterCountry').value || null);
  const cc = $('filterCountry').value;
  const onlyWorking = $('onlyWorking').checked;
  const all = Object.values(servers);
  const alive = rank(all, cc || null);
  const rest = onlyWorking ? [] : all.filter((s) => !alive.includes(s) && (!cc || s.country === cc)).sort((a, b) => (b.lastChecked || 0) - (a.lastChecked || 0));
  const items = [...alive, ...rest].slice(0, 300);
  const ul = $('serverList');
  ul.replaceChildren(
    ...items.map((s) => {
      const li = document.createElement('li');
      li.className = (s.key === state.activeKey && state.status === 'on' ? 'active ' : '') + (s.alive ? '' : 'dead');
      li.title = s.alive ? `Connect · checked ${ago(s.lastChecked)}` : `Not working: ${s.lastError || 'untested'}`;
      const f = document.createElement('div');
      f.className = 'flag';
      f.textContent = flag(s.country);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.name && s.origin !== 'free' ? s.name : countryName(s.country);
      if (s.origin !== 'free') {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = s.origin === 'custom' ? 'yours' : 'proxio';
        name.append(tag);
      }
      const host = document.createElement('div');
      host.className = 'host';
      host.textContent = `${s.protocol.toUpperCase()} · ${s.ip || s.host}`;
      meta.append(name, host);
      const lat = document.createElement('span');
      lat.className = `pill ${s.alive ? latencyClass(s.latencyMs) : 'bad'}`;
      lat.textContent = s.alive ? `${s.latencyMs} ms` : 'down';
      const star = document.createElement('button');
      star.className = 'star';
      star.textContent = '★';
      star.setAttribute('aria-pressed', String(Boolean(s.favorite)));
      star.setAttribute('aria-label', 'Favorite');
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        send('setFavorite', { key: s.key, value: !s.favorite });
      });
      li.append(f, meta, lat, star);
      li.addEventListener('click', () => {
        send('connect', { key: s.key });
        showView('home');
      });
      return li;
    }),
  );
  $('emptyList').classList.toggle('hidden', items.length > 0);
}

function showView(v) {
  $('home').classList.toggle('hidden', v !== 'home');
  $('servers').classList.toggle('hidden', v !== 'servers');
  if (v === 'servers') renderList();
}

// ---- events ----

$('power').addEventListener('click', () => {
  if (state.status === 'on' || state.status === 'connecting') send('disconnect');
  else send('connect');
});
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openServers').addEventListener('click', () => showView('servers'));
$('back').addEventListener('click', () => showView('home'));
$('refresh').addEventListener('click', () => send('refreshServers'));
$('retest').addEventListener('click', () => {
  const keys = rank(Object.values(servers)).slice(0, 30).map((s) => s.key);
  const own = Object.values(servers).filter((s) => s.origin !== 'free').map((s) => s.key);
  send('testKeys', { keys: [...new Set([...keys, ...own])] });
});
$('filterCountry').addEventListener('change', renderList);
$('onlyWorking').addEventListener('change', renderList);

$('country').addEventListener('change', async (e) => {
  const country = e.target.value || null;
  settings = await updateSettings({ country });
  const active = servers[state.activeKey];
  if (state.status === 'on' && country && active?.country !== country) send('connect');
  render();
});

document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', async () => {
    settings = await updateSettings({ mode: b.dataset.mode });
    render();
  }),
);

$('siteToggle').addEventListener('change', async (e) => {
  if (!currentDomain) return;
  const sites = e.target.checked ? [...new Set([...settings.sites, currentDomain])] : settings.sites.filter((d) => !matchesDomain(currentDomain, [d]));
  settings = await updateSettings({ sites });
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.servers) servers = changes.servers.newValue || {};
    if (changes.state) state = { ...DEFAULT_STATE, ...changes.state.newValue };
    if (changes.settings) settings = { ...settings, ...changes.settings.newValue };
  }
  if (area === 'session' && changes.progress) progress = changes.progress.newValue;
  render();
});

setInterval(tick, 1000);

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentDomain = tab?.url && /^https?:/.test(tab.url) ? normalizeDomain(tab.url) : null;
  } catch {
    currentDomain = null;
  }
  await load();
  const r = await send('levelOfControl').catch(() => null);
  const banner = $('controlBanner');
  if (r?.level === 'controlled_by_other_extensions') {
    banner.textContent = 'Another extension controls your proxy settings. Disable it so Tervyn can protect your traffic.';
    banner.classList.remove('hidden');
  } else if (r?.level === 'not_controllable') {
    banner.textContent = 'Your proxy settings are managed by your administrator; Tervyn cannot change them.';
    banner.classList.remove('hidden');
  }
})();
