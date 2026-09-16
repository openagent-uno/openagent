#!/usr/bin/env node
/** Prove the pinned Iroh N-API binding loads under Electron's embedded Node. */
const { spawnSync } = require('node:child_process');

if (process.argv.includes('--electron-worker')) {
  void import('@number0/iroh').then(({ Iroh }) => {
    if (!process.versions.electron || typeof Iroh?.memory !== 'function') {
      throw new Error('Iroh N-API binding is unavailable in the Electron runtime');
    }
    process.stdout.write(
      `[iroh-smoke] Electron ${process.versions.electron}: Iroh.memory available\n`,
    );
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const electron = require('electron');
  const completed = spawnSync(electron, [__filename, '--electron-worker'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (completed.stdout) process.stdout.write(completed.stdout);
  if (completed.stderr) process.stderr.write(completed.stderr);
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(
      `Electron/Iroh runtime smoke failed with exit code ${String(completed.status)}`,
    );
  }
}
