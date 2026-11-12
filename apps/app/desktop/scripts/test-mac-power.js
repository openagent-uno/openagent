// Read-only native qualification: no daemon registration or power mutation.
const { spawnSync, execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
if (process.platform === 'darwin') {
  require('./build-mac-power.js');
  const native = path.resolve(__dirname, '../native-build', process.arch);
  const test = spawnSync(path.join(native, 'openagent-power-guard'), ['--self-test'], {
    argv0: 'openagent-power-guard', encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(test.status, 0, test.stderr);
  assert.deepEqual(JSON.parse(test.stdout), { ok: true, tests: 5 });
  const temporary = mkdtempSync(path.join(tmpdir(), 'openagent-power-layout-'));
  try {
    const app = path.join(temporary, 'OpenAgent.app');
    const contents = path.join(app, 'Contents');
    const mac = path.join(contents, 'MacOS');
    mkdirSync(mac, { recursive: true });
    writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>ai.openagent.desktop</string>
      <key>CFBundleExecutable</key><string>OpenAgent</string>
      <key>CFBundleName</key><string>OpenAgent</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string></dict></plist>`);
    copyFileSync(path.join(native, 'openagent-power-client'), path.join(mac, 'openagent-power-client'));
    copyFileSync(path.join(native, 'openagent-power-guard'), path.join(mac, 'OpenAgent'));
    const services = path.join(contents, 'Library/LaunchServices');
    const daemons = path.join(contents, 'Library/LaunchDaemons');
    mkdirSync(services, { recursive: true }); mkdirSync(daemons);
    copyFileSync(path.join(native, 'openagent-power-guard'), path.join(services, 'openagent-power-guard'));
    const plist = 'ai.openagent.desktop.power-guard.plist';
    copyFileSync(path.resolve(__dirname, '../native', plist), path.join(daemons, plist));
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
    execFileSync('/usr/bin/plutil', ['-lint', path.join(daemons, plist)], { stdio: 'pipe' });
    const status = JSON.parse(execFileSync(path.join(mac, 'openagent-power-client'), ['--status'], { encoding: 'utf8', timeout: 15_000 }));
    assert.equal(status.hostApp, 'ai.openagent.desktop');
    assert.ok(['setup-required', 'approval-required', 'ready'].includes(status.status));
    console.log('macOS power: 5 lease/recovery checks and packaged read-only service discovery passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
