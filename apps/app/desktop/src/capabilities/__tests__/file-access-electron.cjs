// After compiling Desktop, run with its macOS Electron executable:
// node_modules/electron/dist/Electron.app/Contents/MacOS/Electron src/capabilities/__tests__/file-access-electron.cjs
const { app } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { run } = require('node:test');

const profile = mkdtempSync(join(tmpdir(), 'openagent-permission-electron-'));
app.setPath('userData', profile);
app.setActivationPolicy('prohibited');
process.once('exit', () => rmSync(profile, { recursive: true, force: true }));
const deadline = setTimeout(() => {
  console.error('Electron permission fixture did not finish');
  app.exit(1);
}, 15_000);

app.whenReady().then(async () => {
  console.log(`Testing file permissions in Electron ${process.versions.electron}`);
  const tests = run({ files: [join(__dirname, 'file-access.test.mjs')], isolation: 'none' });
  let passed = 0;
  let failed = 0;
  tests.on('test:pass', result => { passed++; console.log(`PASS ${result.name}`); });
  tests.on('test:fail', result => { failed++; console.error(result); });
  tests.resume();
  const { complete } = await import('./file-access.test.mjs');
  const completed = await complete();
  clearTimeout(deadline);
  app.exit(failed === 0 && passed === completed.length && passed > 0 ? 0 : 1);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
