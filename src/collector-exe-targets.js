// Platforms the home collector can be downloaded for as a single program.
// (No Mac: Apple requires programs to be signed on a Mac, so Mac users get the zip.)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LAUNCHER = 'src/collector-launcher.cjs';

export const TARGETS = {
  'windows-x64': { label: 'Windows', dist: 'win-x64', windows: true, filename: 'grocery-collector.exe' },
  // Linux: in a .tar.gz, which keeps the program executable (a bare download loses that).
  'linux-x64': { label: 'Linux (x64)', dist: 'linux-x64', filename: 'grocery-collector', archive: 'grocery-collector-linux-x64.tar.gz' },
  'linux-arm64': { label: 'Linux (ARM, e.g. Raspberry Pi)', dist: 'linux-arm64', filename: 'grocery-collector', archive: 'grocery-collector-linux-arm64.tar.gz' },
};

/** Changes when a program needs rebuilding: the launcher's code or the Node.js version. */
export function buildKey() {
  const launcher = fs.readFileSync(path.join(ROOT, LAUNCHER));
  return `${process.version}-${crypto.createHash('sha256').update(launcher).digest('hex').slice(0, 10)}`;
}

/** File name of a built program; prebuilt ones (made when the Docker image is built) are gzipped. */
export const programName = (target, gz = false) => `${buildKey()}-${target}.bin${gz ? '.gz' : ''}`;
