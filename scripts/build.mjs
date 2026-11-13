/**
 * Builds a ready-to-load extension folder and a store-ready zip for every browser family:
 *
 *   extensions/chromium/   Chrome, Edge, Brave, Opera, Vivaldi, Arc… (service worker, PAC routing)
 *   extensions/firefox/    Firefox desktop & Firefox for Android (event page, proxy.onRequest)
 *   dist/tervyn-vpn-<version>-<target>.zip
 *
 * Both are built from the same sources; only manifest.json differs. No dependencies (Node 22+).
 * Run with --check to verify the committed extensions/ folders are up to date (used by CI).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['src', 'icons'];

function walk(base, rel = '') {
  const abs = path.join(base, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).sort().flatMap((n) => walk(base, rel ? path.posix.join(rel, n) : n));
  return [rel];
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zip(base, files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const name of files) {
    const data = fs.readFileSync(path.join(base, name));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function chromiumManifest() {
  return { ...base };
}

function firefoxManifest() {
  const m = { ...base };
  delete m.minimum_chrome_version;
  // Firefox runs MV3 backgrounds as event pages, and needs webRequestBlocking for proxy logins.
  m.background = { scripts: [base.background.service_worker], type: 'module' };
  m.permissions = base.permissions.filter((p) => p !== 'webRequestAuthProvider').concat('webRequestBlocking');
  m.browser_specific_settings = {
    gecko: {
      id: 'tervyn-vpn@tervyn.app',
      strict_min_version: '128.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '128.0' },
  };
  return m;
}

const TARGETS = { chromium: chromiumManifest, firefox: firefoxManifest };
const check = process.argv.includes('--check');
let stale = false;

for (const [target, makeManifest] of Object.entries(TARGETS)) {
  const outDir = path.join(ROOT, 'extensions', target);
  const files = new Map();
  for (const top of INCLUDE) for (const f of walk(ROOT, top)) files.set(f, fs.readFileSync(path.join(ROOT, f)));
  files.set('manifest.json', Buffer.from(JSON.stringify(makeManifest(), null, 2) + '\n'));

  if (check) {
    const existing = new Set(walk(outDir));
    for (const [f, data] of files) {
      if (!existing.has(f) || !fs.readFileSync(path.join(outDir, f)).equals(data)) {
        console.error(`extensions/${target}/${f} is out of date`);
        stale = true;
      }
      existing.delete(f);
    }
    existing.forEach((f) => {
      console.error(`extensions/${target}/${f} should not exist`);
      stale = true;
    });
    continue;
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [f, data] of files) {
    fs.mkdirSync(path.dirname(path.join(outDir, f)), { recursive: true });
    fs.writeFileSync(path.join(outDir, f), data);
  }
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const out = path.join(ROOT, 'dist', `tervyn-vpn-${base.version}-${target}.zip`);
  const list = walk(outDir);
  fs.writeFileSync(out, zip(outDir, list));
  console.log(`extensions/${target}/  ->  ${path.relative(ROOT, out)}  (${list.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}

if (check) {
  if (stale) {
    console.error('Run `npm run build` and commit the result.');
    process.exit(1);
  }
  console.log('extensions/ folders are up to date.');
}
