#!/usr/bin/env node

/**
 * Builds a deployable zip.
 *
 * Copies the source tree — minus `node_modules`, `.next` and local files — into
 * a staging folder and zips it. The result is what you upload: unzip it on the
 * server, run `npm ci && npm run build && npm start`.
 *
 * Zipping is delegated to the platform (PowerShell on Windows, `zip`
 * elsewhere) so the project needs no archiving dependency.
 */

import { cp, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const OUTPUT_DIR = join(PROJECT_ROOT, 'dist');
const OUTPUT_ZIP = join(OUTPUT_DIR, 'smash-and-go-voice-order.zip');

/** Everything the server needs, and nothing it does not. */
const INCLUDE = [
  'src',
  'data',
  'scripts',
  'tests',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'next.config.mjs',
  'vitest.config.ts',
  'eslint.config.mjs',
  'next-env.d.ts',
  '.env.example',
  'README.md',
];

function zip(sourceDirectory, destination) {
  if (process.platform === 'win32') {
    const command = `Compress-Archive -Path '${sourceDirectory}\\*' -DestinationPath '${destination}' -Force`;
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      stdio: 'inherit',
    });
  }
  return spawnSync('zip', ['-r', '-q', destination, '.'], {
    cwd: sourceDirectory,
    stdio: 'inherit',
  });
}

async function main() {
  const staging = await mkdtemp(join(tmpdir(), 'smash-and-go-'));

  try {
    for (const entry of INCLUDE) {
      const source = join(PROJECT_ROOT, entry);
      if (!existsSync(source)) {
        console.warn(`skipping missing entry: ${entry}`);
        continue;
      }
      await cp(source, join(staging, entry), { recursive: true });
    }

    await mkdir(OUTPUT_DIR, { recursive: true });
    await rm(OUTPUT_ZIP, { force: true });

    const result = zip(staging, OUTPUT_ZIP);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`the archiver exited with code ${result.status}`);
    }

    console.log(`\nPackaged: ${OUTPUT_ZIP}`);
    console.log('On the server: unzip, then `npm ci && npm run build && npm start`.');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Packaging failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
