#!/usr/bin/env node
// Builds the home collector as a single program for one platform:
//   node src/cli/build-collector-exe.js <windows-x64|linux-x64|linux-arm64> <output file>
// or, when building the Docker image, gzipped programs for several platforms:
//   node src/cli/build-collector-exe.js --prebuild <folder> [platforms…]
//
// Downloads the official Node.js binary (the same version as this one, checked
// against nodejs.org's published SHA-256 sums), packs src/collector-launcher.cjs
// into it with Node's single-executable-application support, and writes the
// result. The server runs this in its own process (it needs a few hundred MB of
// memory for a moment) and caches the result; see src/collector-exe.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TARGETS, LAUNCHER, ROOT, programName } from '../collector-exe-targets.js';

const require = createRequire(import.meta.url);
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const MIRROR = (process.env.NODE_DIST_MIRROR || 'https://nodejs.org/dist').replace(/\/$/, '');
const VERSION = process.version;

const argv = process.argv.slice(2);
const prebuild = argv[0] === '--prebuild';
const jobs = prebuild
  ? (argv.length > 2 ? argv.slice(2) : Object.keys(TARGETS)).map((t) => [t, path.join(argv[1] || '', programName(t, true))])
  : [[argv[0], argv[1]]];
if ((prebuild && !argv[1]) || jobs.some(([t, out]) => !TARGETS[t] || !out)) {
  console.error(`Usage: build-collector-exe.js <${Object.keys(TARGETS).join('|')}> <output file>\n       build-collector-exe.js --prebuild <folder> [platforms…]`);
  process.exit(2);
}

// Downloads go through HTTPS_PROXY when one is set (like the scrapers).
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher = PROXY ? new (await import('undici')).ProxyAgent(PROXY) : undefined;

async function get(url) {
  const res = await fetch(url, { dispatcher });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

/** Stream a download to a file, returning its SHA-256. */
async function download(url, file) {
  const res = await get(url);
  const hash = crypto.createHash('sha256');
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => hash.update(chunk));
  await pipeline(src, fs.createWriteStream(file));
  return hash.digest('hex');
}

/** Pull one file out of a .tar.gz without unpacking the rest. */
async function extractFromTarGz(archive, wanted, dest) {
  const gunzip = fs.createReadStream(archive).pipe(zlib.createGunzip());
  let buf = Buffer.alloc(0);
  let entry = null; // { kind: 'skip' | 'file' | 'longname', size, left (incl. padding), fd?, parts? }
  let longName = null;
  for await (const chunk of gunzip) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length) {
      if (entry) {
        const n = Math.min(entry.left, buf.length);
        const used = entry.size - (entry.padded - entry.left); // data bytes still to keep
        const data = buf.subarray(0, Math.max(0, Math.min(n, used)));
        if (entry.kind === 'file') fs.writeSync(entry.fd, data);
        if (entry.kind === 'longname') entry.parts.push(Buffer.from(data));
        entry.left -= n;
        buf = buf.subarray(n);
        if (entry.left) continue;
        if (entry.kind === 'file') {
          fs.closeSync(entry.fd);
          gunzip.destroy();
          return;
        }
        if (entry.kind === 'longname') longName = Buffer.concat(entry.parts).toString('utf8').replace(/\0.*$/s, '');
        entry = null;
        continue;
      }
      if (buf.length < 512) break;
      const header = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (header.every((b) => b === 0)) continue;
      const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
      const size = parseInt(field(124, 12).trim() || '0', 8);
      const type = field(156, 1);
      const prefix = field(345, 155);
      const name = longName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = null;
      const padded = Math.ceil(size / 512) * 512;
      const kind = type === 'L' ? 'longname' : name === wanted && (type === '0' || type === '') ? 'file' : 'skip';
      if (!padded && kind !== 'file') continue;
      entry = { kind, size, padded, left: padded, fd: kind === 'file' ? fs.openSync(dest, 'w') : null, parts: [] };
    }
  }
  throw new Error(`${wanted} not found in ${path.basename(archive)}`);
}

/**
 * Remove the Authenticode signature from a Windows .exe. Adding the collector
 * invalidates it anyway, and a broken signature looks worse than none.
 */
function stripPeSignature(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a Windows program');
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96); // PE32+ : PE32
  const entry = dirs + 4 * 8; // data directory 4 = certificate table
  const offset = buf.readUInt32LE(entry);
  const size = buf.readUInt32LE(entry + 4);
  if (!offset || !size) return buf;
  buf.writeUInt32LE(0, entry);
  buf.writeUInt32LE(0, entry + 4);
  return offset + size >= buf.length ? buf.subarray(0, offset) : buf;
}

async function build(targetId, outFile) {
  const target = TARGETS[targetId];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-exe-'));
  try {
    const sums = await (await get(`${MIRROR}/${VERSION}/SHASUMS256.txt`)).text();
    const sumFor = (name) => sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === name)?.[0];
    const node = path.join(work, target.windows ? 'node.exe' : 'node');

    if (target.windows) {
      const name = `${target.dist}/node.exe`;
      console.log(`Downloading Node.js ${VERSION} for ${target.label}…`);
      const got = await download(`${MIRROR}/${VERSION}/${name}`, node);
      if (got !== sumFor(name)) throw new Error(`Checksum mismatch for ${name}`);
      fs.writeFileSync(node, stripPeSignature(node));
    } else {
      const name = `node-${VERSION}-${target.dist}.tar.gz`;
      const archive = path.join(work, name);
      console.log(`Downloading Node.js ${VERSION} for ${target.label}…`);
      const got = await download(`${MIRROR}/${VERSION}/${name}`, archive);
      if (got !== sumFor(name)) throw new Error(`Checksum mismatch for ${name}`);
      await extractFromTarGz(archive, `node-${VERSION}-${target.dist}/bin/node`, node);
      fs.rmSync(archive);
    }

    console.log('Packing the collector in…');
    const config = path.join(work, 'sea-config.json');
    const blob = path.join(work, 'sea-prep.blob');
    // No snapshot or code cache, so the blob works on any platform.
    fs.writeFileSync(config, JSON.stringify({
      main: path.join(ROOT, LAUNCHER), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
    }));
    const r = spawnSync(process.execPath, ['--experimental-sea-config', config], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Couldn't prepare the program: ${r.stderr || r.stdout}`);
    const { inject } = require('postject');
    await inject(node, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: SENTINEL });

    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    const tmp = `${outFile}.tmp`;
    if (outFile.endsWith('.gz')) await pipeline(fs.createReadStream(node), zlib.createGzip(), fs.createWriteStream(tmp));
    else fs.copyFileSync(node, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, outFile);
    console.log(`Built ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(0)} MB)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  for (const [t, out] of jobs) await build(t, out);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
