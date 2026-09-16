#!/usr/bin/env node
// Post-tsc bundling step. Resolves the ERR_REQUIRE_ESM crash by
// inlining pure-ESM deps (@noble/ed25519, cbor2) into a single CJS
// bundle that Electron's main process can require() at startup.
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

// Externals = deps we DON'T want bundled:
//   electron          built into Electron, never bundled
//   electron-updater  uses asar-aware paths at runtime
//   electron-store    relies on app.getPath() at runtime
//   @number0/iroh     native .node binary, can't be bundled
const externals = [
  'electron',
  'electron-updater',
  'electron-store',
  '@number0/iroh',
];

function bundle(entry) {
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: entry,
    allowOverwrite: true,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: externals,
    sourcemap: 'inline',
    logLevel: 'info',
  });
}

const dist = path.resolve(__dirname, '..', 'dist');
const targets = [
  path.join(dist, 'main.js'),
  path.join(dist, 'preload.js'),
  path.join(dist, 'network', 'identity.js'),
  path.join(dist, 'network', 'device-cert.js'),
  path.join(dist, 'network', 'coordinator-rpc.js'),
  path.join(dist, 'network', 'ticket.js'),
];
for (const t of targets) bundle(t);

// Copy the tray icon into dist/ so it ships inside the asar at runtime.
// Uses the standalone polygon-bird logo (not the full app icon) so the
// tray shows the bird shape against a transparent background.
const trayIconSrc = path.resolve(__dirname, '..', '..', 'universal', 'assets', 'openagent-icon.png');
const trayIconDst = path.join(dist, 'tray-icon.png');
fs.copyFileSync(trayIconSrc, trayIconDst);
console.log(`[bundle] copied tray icon: ${trayIconSrc} → ${trayIconDst}`);

// Pin staged native host-tool executables inside the signed asar. Runtime
// verifies this manifest before spawning anything from extraResources.
const hostManifestSrc = path.resolve(__dirname, '..', 'resources', 'host-tools', 'manifest.json');
const hostManifestDst = path.join(dist, 'host-tools-manifest.json');
if (fs.existsSync(hostManifestSrc)) {
  fs.copyFileSync(hostManifestSrc, hostManifestDst);
  console.log(`[bundle] copied host-tools checksum manifest`);
} else {
  // Never retain a manifest from an earlier build after staging failed or was
  // skipped. Release packaging sets OPENAGENT_REQUIRE_HOST_TOOLS=1.
  if (fs.existsSync(hostManifestDst)) fs.rmSync(hostManifestDst, { force: true });
  if (process.env.OPENAGENT_REQUIRE_HOST_TOOLS === '1') {
    throw new Error('Required staged host-tools checksum manifest is missing');
  }
}

// Guard: fail loudly if either ESM-only dep wasn't actually inlined in any target.
const offenders = [/require\(["']@noble\/ed25519["']\)/, /require\(["']cbor2["']\)/];
for (const t of targets) {
  const src = fs.readFileSync(t, 'utf8');
  for (const re of offenders) {
    if (re.test(src)) {
      console.error(`bundle ${path.relative(dist, t)} still contains ${re} — would ship broken`);
      process.exit(1);
    }
  }
}
