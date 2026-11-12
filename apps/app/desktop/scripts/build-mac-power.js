// Native power service is product-owned and ships inside the signed app, never
// downloaded at runtime. No registration/privileged operation occurs at build.
const { spawnSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
function buildMacPower() {
  if (process.platform !== 'darwin') return;
  const arch = process.env.OPENAGENT_NATIVE_MAC_ARCH || process.arch;
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported native power architecture');
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'native/power-guard.swift');
  const out = path.join(root, 'native-build', arch);
  mkdirSync(out, { recursive: true });
  const executable = path.join(out, 'openagent-power-guard');
  const client = path.join(out, 'openagent-power-client');
  const digest = data => createHash('sha256').update(data).digest('hex');
  const input = digest(Buffer.concat([readFileSync(source), Buffer.from('v1:' + arch)]));
  const receiptPath = path.join(out, 'receipt.json');
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath)); } catch {}
  if (receipt?.input === input && existsSync(executable) && existsSync(client)
      && receipt.binary === digest(readFileSync(executable)) && receipt.binary === digest(readFileSync(client))) return;
  const result = spawnSync('xcrun', ['swiftc', '-O', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx13.0`, source, '-o', executable], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Native macOS power service build failed');
  copyFileSync(executable, client);
  writeFileSync(receiptPath, JSON.stringify({ input, binary: digest(readFileSync(executable)), arch }) + '\n');
}
buildMacPower();
