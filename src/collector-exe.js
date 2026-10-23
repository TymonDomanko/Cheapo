// The home collector as a single program to download (see
// src/collector-launcher.cjs). The Docker image comes with them prebuilt
// (gzipped, in /app/collector-exe). Otherwise each platform's program is
// built once, in the background, by src/cli/build-collector-exe.js and cached
// under DATA_DIR/collector-exe — that needs about 1 GB of memory for a moment.
// A program only needs rebuilding when the launcher or the server's Node.js
// version changes: it fetches the collector's code itself when it runs.
//
// Each download is the cached program plus this site's address, collector
// token and settings appended to the end, which the launcher reads.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { DB_FILE } from './db.js';
import { TARGETS, ROOT, programName } from './collector-exe-targets.js';

export { TARGETS };

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const builds = {}; // target -> { promise, error, log }

export function exeDir() {
  return process.env.COLLECTOR_EXE_DIR || path.join(path.dirname(DB_FILE), 'collector-exe');
}

export function prebuiltDir() {
  return process.env.COLLECTOR_EXE_PREBUILT || path.join(ROOT, 'collector-exe');
}

const fileFor = (target) => path.join(exeDir(), programName(target));

/** The ready-to-send program for a platform, if there is one. */
function findProgram(target) {
  const prebuilt = path.join(prebuiltDir(), programName(target, true));
  if (fs.existsSync(prebuilt)) {
    // gzip records the original size in its last 4 bytes.
    const fd = fs.openSync(prebuilt, 'r');
    const tail = Buffer.alloc(4);
    fs.readSync(fd, tail, 0, 4, fs.fstatSync(fd).size - 4);
    fs.closeSync(fd);
    return { file: prebuilt, gz: true, bytes: tail.readUInt32LE(0) };
  }
  const built = fileFor(target);
  return fs.existsSync(built) ? { file: built, gz: false, bytes: fs.statSync(built).size } : null;
}

export function exeStatus(target) {
  const t = TARGETS[target];
  const found = findProgram(target);
  return {
    id: target,
    label: t.label,
    ready: !!found,
    bytes: found?.bytes ?? null,
    building: !!builds[target]?.promise,
    error: builds[target]?.error || null,
  };
}

export function exeStatuses() {
  return Object.keys(TARGETS).map(exeStatus);
}

/** Start building a platform's program (no-op if it's ready or already building). */
export function buildExe(target) {
  if (!TARGETS[target]) throw Object.assign(new Error('Unknown platform'), { status: 404 });
  if (exeStatus(target).ready) return Promise.resolve();
  if (builds[target]?.promise) return builds[target].promise;
  const file = fileFor(target);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(exeDir(), { recursive: true });
  const state = (builds[target] = { error: null, log: '' });
  state.promise = new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli/build-collector-exe.js'), target, tmp], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: BUILD_TIMEOUT_MS,
    });
    const keep = (d) => (state.log = (state.log + d).slice(-4000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => keep(e.message));
    child.on('close', (code, signal) => {
      if (code === 0 && fs.existsSync(tmp)) {
        fs.renameSync(tmp, file);
        prune(target, file);
      } else {
        fs.rmSync(tmp, { force: true });
        const last = state.log.trim().split('\n').pop();
        state.error = signal === 'SIGKILL' ? 'The build ran out of memory or time (it needs about 1 GB; the Docker image comes with the programs ready-made)' : last || `Build failed (exit ${code})`;
        console.error(`[collector-exe] ${target}: ${state.error}`);
      }
      state.promise = null;
      resolve();
    });
  });
  return state.promise;
}

/** Remove older builds of a platform. */
function prune(target, keep) {
  for (const f of fs.readdirSync(exeDir())) {
    const full = path.join(exeDir(), f);
    if (full !== keep && f.includes(`-${target}.bin`)) fs.rmSync(full, { force: true });
  }
}

export const CONFIG_MARK = '\n#GROCERY-COLLECTOR-CONFIG#';
export const CONFIG_END = '#END#\n';

/** The settings appended to a download. */
export function configTrailer(config) {
  return Buffer.from(CONFIG_MARK + Buffer.from(JSON.stringify(config)).toString('base64') + CONFIG_END, 'latin1');
}

/** Send a platform's program with `config` appended. */
export function sendExe(res, target, config) {
  const t = TARGETS[target];
  const found = findProgram(target);
  const trailer = configTrailer(config);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${t.filename}"`,
    'Content-Length': String(found.bytes + trailer.length),
    'Cache-Control': 'no-store',
  });
  const raw = fs.createReadStream(found.file);
  const stream = found.gz ? raw.pipe(zlib.createGunzip()) : raw;
  raw.on('error', () => res.destroy());
  stream.on('error', () => res.destroy());
  stream.on('end', () => res.end(trailer));
  stream.pipe(res, { end: false });
}
