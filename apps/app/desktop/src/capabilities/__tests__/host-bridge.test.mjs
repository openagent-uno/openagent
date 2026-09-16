import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverHostTools, LocalHostBridge } from '../../../dist/capabilities/host-bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('NDJSON host bridge initializes, shares consent, catalogs and invokes', async () => {
  const bridge = new LocalHostBridge({
    launch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      source: 'development',
    },
    principal: { kind: 'desktop', client_instance_id: 'test-instance' },
  });
  try {
    const initialized = await bridge.start();
    assert.equal(initialized.consent.enabled, false);
    await bridge.setConsent(true);
    const status = await bridge.status();
    assert.equal(status.consent.enabled, true);
    const catalog = await bridge.catalog();
    assert.equal(catalog.servers[0].name, 'filesystem');
    const result = await bridge.call({
      callId: 'call-1', server: 'filesystem', tool: 'echo',
      toolArgs: { value: 'hello' }, idempotencyKey: 'idem-1',
      argumentsSha256: '0'.repeat(64),
    });
    assert.equal(result.content[0].text, 'hello');
  } finally {
    await bridge.stop();
  }
});

test('packaged discovery pins executable and the complete host bundle manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-host-pin-'));
  try {
    const key = `${process.platform}-${process.arch}`;
    const name = process.platform === 'win32' ? 'openagent-host-tools.exe' : 'openagent-host-tools';
    const executable = path.join(root, 'host-tools', key, name);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'trusted-host-binary');
    const executableBytes = fs.readFileSync(executable);
    const sha256 = createHash('sha256').update(executableBytes).digest('hex');
    const bundleManifestPath = path.join(path.dirname(executable), 'bundle-manifest.json');
    fs.writeFileSync(bundleManifestPath, JSON.stringify({
      manifest_version: 1,
      version: '0.1.0',
      platform: key,
      files: { [name]: { size: executableBytes.length, sha256 } },
    }));
    const bundleManifestSha256 = createHash('sha256')
      .update(fs.readFileSync(bundleManifestPath)).digest('hex');
    const manifestPath = path.join(root, 'host-tools-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: 2,
      host_tools_version: '0.1.0',
      bundles: { [key]: {
        executable: `${key}/${name}`,
        size: executableBytes.length,
        sha256,
        host_tools_version: '0.1.0',
        bundle_manifest: `${key}/bundle-manifest.json`,
        bundle_manifest_sha256: bundleManifestSha256,
        file_count: 1,
      } },
    }));
    const options = {
      isPackaged: true, resourcesPath: root, appPath: root, manifestPath,
      platform: process.platform, arch: process.arch,
    };
    assert.equal(discoverHostTools(options).unavailableReason, undefined);
    fs.appendFileSync(executable, '-tampered');
    assert.match(discoverHostTools(options).unavailableReason, /integrity/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
