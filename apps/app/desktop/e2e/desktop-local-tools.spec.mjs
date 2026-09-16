import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron, expect, test } from '@playwright/test';
import {
  DeterministicGateway,
  resolveHostToolsBinary,
} from './fixtures.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..');
const APP_ROOT = resolve(DESKTOP_ROOT, '..');
const WEB_ROOT = join(APP_ROOT, 'universal', 'dist');
const LOCAL_PLUGIN_FIXTURE = join(HERE, 'local-plugin-fixture.mjs');
const LOCAL_PLUGIN_SECRET = 'desktop-e2e-plugin-secret-never-on-gateway';

test('real Electron host executes local tools, reports its host, audits, and never falls back', async () => {
  test.slow();
  const testRoot = await mkdtemp(join(tmpdir(), 'openagent-desktop-e2e-'));
  const userData = join(testRoot, 'electron-user-data');
  const hostHomeCandidate = join(testRoot, 'host-tools-home');
  const localFile = join(testRoot, 'client-local-note.txt');
  await mkdir(userData, { recursive: true });
  await mkdir(hostHomeCandidate, { recursive: true });
  // macOS exposes its temporary directory through both /var and
  // /private/var. The broker canonicalises it; use the same path for the
  // launch environment and exact-PID cleanup marker.
  const hostHome = await realpath(hostHomeCandidate);

  const accountId = 'desktop-e2e-account';
  const networkId = 'network-certified-e2e';
  const deviceId = 'device-certificate-e2e';
  const agentNodeId = 'agent-node-e2e';
  const gateway = await new DeterministicGateway({
    webRoot: WEB_ROOT,
    accountId,
    networkId,
    deviceId,
    agentNodeId,
  }).start();
  const hostBinary = resolveHostToolsBinary(DESKTOP_ROOT);
  const brokerPidsBefore = await listBrokerPids(hostBinary, hostHome);
  const shimPidsBefore = await listShimPids(hostBinary);
  let electronApp;
  const mainOutput = [];

  try {
    electronApp = await electron.launch({
      args: [DESKTOP_ROOT, `--user-data-dir=${userData}`],
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OPENAGENT_DESKTOP_E2E: '1',
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/settings`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()),
        OPENAGENT_HOST_TOOLS_BIN: hostBinary,
        OPENAGENT_HOST_TOOLS_HOME: hostHome,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    electronApp.process().stdout?.on('data', (chunk) => mainOutput.push(chunk.toString()));
    electronApp.process().stderr?.on('data', (chunk) => mainOutput.push(chunk.toString()));

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1_440, height: 960 });
    await expect(page).toHaveURL(`${gateway.baseUrl}/settings`);

    // Keep the Electron main realm alive before installing the native-dialog
    // substitute.  On a cold CI launch, evaluating before the first window is
    // retained can let Playwright collect the pending main-realm promise.
    // Only the physical click is replaced; IPC and CapabilityManager remain
    // the production implementations.
    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });

    const account = {
      id: accountId,
      name: 'Desktop E2E',
      network: 'desktop-e2e',
      handle: 'e2e-user',
      agentHandle: 'e2e-agent',
      isLocal: true,
      createdAt: Date.now(),
    };
    await page.evaluate(async ({ accountValue, accountKey, connectionKey, port }) => {
      await window.desktop.setItem(accountKey, JSON.stringify([accountValue]));
      await window.desktop.setItem(connectionKey, JSON.stringify({
        accountId: accountValue.id,
        sidecarPort: port,
      }));
    }, {
      accountValue: account,
      accountKey: 'openagent:accounts',
      connectionKey: 'openagent:activeConnection',
      port: Number(new URL(gateway.baseUrl).port),
    });
    await page.reload();
    await expect.poll(
      () => gateway.chatFrames.filter((frame) => frame.type === 'auth').length,
    ).toBeGreaterThan(0);

    await page.getByText('This Computer', { exact: true }).first().click();
    await expect(page.getByText('Allow full computer access', { exact: true })).toBeVisible();
    await expect.poll(async () => (await capabilityStatus(page)).phase).toBe('disabled');
    expect(gateway.capabilityFrames, 'disabled clients must not advertise a capability catalog')
      .toHaveLength(0);

    const consentSwitch = page.getByRole('switch').first();
    await consentSwitch.click();
    const hello = await gateway.waitForCapabilityHello();
    await expect.poll(async () => (await capabilityStatus(page)).phase).toBe('connected');
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();

    expect(hello.protocol).toBe('client-capabilities/1');
    expect(hello.client_instance_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(hello.device_label).toBe(`${hostname()} (OpenAgent Desktop)`);
    const chatAuth = gateway.chatFrames.find((frame) => frame.type === 'auth');
    expect(chatAuth?.client_kind).toBe('desktop');
    expect(chatAuth?.client_instance_id).toBe(hello.client_instance_id);
    const advertisedServers = new Set(hello.servers.map((server) => server.name));
    for (const server of ['filesystem', 'editor', 'shell']) {
      expect(advertisedServers.has(server), `missing advertised server ${server}`).toBe(true);
    }
    const consent = JSON.parse(await readFile(join(hostHome, 'client-tools-consent.json'), 'utf8'));
    expect(consent.enabled).toBe(true);

    const auditExpectations = new Map();
    const invoke = async (server, tool, args, options) => {
      const value = await gateway.call(server, tool, args, options);
      auditExpectations.set(value.callId, value.argumentsSha256);
      expect(value.result?._meta?.['openagent/location']).toBe('client');
      expect(value.result?._meta?.['openagent/pathSemantics']).toBe('client-local');
      return value;
    };

    const initialText = 'alpha CLIENT-CONTENT-MUST-NOT-ENTER-AUDIT';
    await invoke('filesystem', 'write_file', { path: localFile, content: initialText });
    const firstRead = await invoke('filesystem', 'read_text_file', { path: localFile });
    expect(firstRead.result.content[0].text).toBe(initialText);

    await invoke('editor', 'edit', {
      file_path: localFile,
      old_string: 'alpha',
      new_string: 'beta',
    });
    const editedRead = await invoke('filesystem', 'read_text_file', { path: localFile });
    expect(editedRead.result.content[0].text).toBe(
      'beta CLIENT-CONTENT-MUST-NOT-ENTER-AUDIT',
    );

    const foregroundArgs = {
      command: foregroundCommand(),
      timeout: 10_000,
    };
    const foregroundPromise = gateway.call('shell', 'shell_exec', foregroundArgs, {
      timeoutMs: 20_000,
    });
    await expect.poll(async () => (await capabilityStatus(page)).activeCalls).toBe(1);
    await expect(page.getByText('Active (1)', { exact: true })).toBeVisible();
    const foreground = await foregroundPromise;
    auditExpectations.set(foreground.callId, foreground.argumentsSha256);
    expect(foreground.result?._meta?.['openagent/location']).toBe('client');
    expect(foreground.result?.structuredContent?.exit_code).toBe(0);
    expect(foreground.result?.structuredContent?.stdout).toContain('foreground-ok');
    await expect.poll(async () => (await capabilityStatus(page)).activeCalls).toBe(0);

    const background = await invoke('shell', 'shell_exec', {
      command: backgroundCommand(),
      run_in_background: true,
      description: 'Desktop E2E background completion',
    });
    const shellId = background.result?.structuredContent?.shell_id;
    expect(shellId).toMatch(/^sh_/);
    const completion = await gateway.waitForEvent(
      (event) => event.type === 'shell_completed' && event.shell_id === shellId,
    );
    expect(completion.exit_code).toBe(0);
    const output = await invoke('shell', 'shell_output', {
      shell_id: shellId,
      since_last: false,
    });
    expect(output.result?.structuredContent?.stdout_delta).toContain('background-ok');

    expect(await readFile(localFile, 'utf8')).toBe(
      'beta CLIENT-CONTENT-MUST-NOT-ENTER-AUDIT',
    );
    const auditPath = join(hostHome, 'host-tools', 'audit.sqlite3');
    const auditRows = await readAudit(auditPath);
    const rowsByCall = new Map(auditRows.map((row) => [row.call_id, row]));
    for (const [callId, expectedHash] of auditExpectations) {
      const row = rowsByCall.get(callId);
      expect(row, `missing local audit row for ${callId}`).toBeTruthy();
      expect(row.target).toBe('client');
      expect(row.outcome).toBe('success');
      expect(row.arguments_sha256).toBe(expectedHash);
      expect(Array.isArray(JSON.parse(row.argument_keys))).toBe(true);
    }
    expect(JSON.stringify(auditRows)).not.toContain('CLIENT-CONTENT-MUST-NOT-ENTER-AUDIT');

    const executionHost = {
      kind: 'client',
      device_label: hello.device_label,
      device_id: deviceId,
      client_instance_id: hello.client_instance_id,
      generation: hello.generation,
    };
    gateway.setRunMessages([{
      id: 'e2e-tool-message',
      role: 'tool',
      text: JSON.stringify({ tool_name: 'client:filesystem.read_text_file' }),
      timestamp: Date.now(),
      toolInfo: {
        tool_name: 'client:filesystem.read_text_file',
        tool_call_id: editedRead.callId,
        tool_args: { path: localFile },
        tool_call_error: false,
        result: JSON.stringify(editedRead.result),
        execution_host: executionHost,
      },
    }]);
    // Open the fixture directly. Clicking its already-selected Recent row now
    // intentionally opens Rename, while the session query still exercises the
    // production lazy runs fetch used to reopen a durable chat.
    await page.goto(`${gateway.baseUrl}/chat?session=e2e-session`);
    const locationLabel = `This computer · ${hello.device_label}`;
    await expect(page.getByText(locationLabel, { exact: true })).toBeVisible();
    await page.getByText(locationLabel, { exact: true }).click();
    await expect(page.getByText('Execution host', { exact: true })).toBeVisible();
    await expect(page.getByText(
      `${hello.device_label} · client ${hello.client_instance_id}`,
      { exact: true },
    )).toBeVisible();

    const beforeDisconnectRows = await readAudit(auditPath);
    const beforeDisconnectContents = await readFile(localFile, 'utf8');
    gateway.disconnectCapabilities();
    await expect.poll(async () => (await capabilityStatus(page)).connectedAccounts).toBe(0);
    await expect.poll(() => gateway.rejectedCapabilityConnections, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect(gateway.call('filesystem', 'write_file', {
      path: localFile,
      content: 'SERVER-FALLBACK-MUST-NOT-HAPPEN',
    })).rejects.toThrow('No registered client capability host');
    expect(await readFile(localFile, 'utf8')).toBe(beforeDisconnectContents);
    expect((await readAudit(auditPath)).length).toBe(beforeDisconnectRows.length);

    await page.goto(`${gateway.baseUrl}/settings`);
    await page.getByText('This Computer', { exact: true }).first().click();
    await page.getByText('EMERGENCY DISABLE LOCAL ACCESS', { exact: true }).click();
    await expect.poll(async () => (await capabilityStatus(page)).phase).toBe('disabled');
    // Runtime blocking is deliberately immediate; canonical broker consent
    // finishes durably just after that fail-closed status transition.
    await expect.poll(async () => {
      const revoked = JSON.parse(
        await readFile(join(hostHome, 'client-tools-consent.json'), 'utf8'),
      );
      return revoked.enabled;
    }).toBe(false);
  } catch (error) {
    const output = mainOutput.join('').trim();
    if (output) error.message += `\n\nElectron main output:\n${output}`;
    error.message += `\n\nFixture HTTP requests:\n${JSON.stringify(gateway.httpRequests)}`;
    throw error;
  } finally {
    try {
      if (electronApp) await electronApp.close();
      const leakedShims = [...await listShimPids(hostBinary)]
        .filter((pid) => !shimPidsBefore.has(pid));
      expect(leakedShims, 'Electron shutdown must reap its exact host-tools stdio shim')
        .toEqual([]);
    } finally {
      // The production broker is intentionally single-instance and durable,
      // so closing its stdio client does not stop it. This isolated E2E owns
      // only broker PIDs created after its snapshot; reap those exact
      // processes so repeated release passes leave no broker sidecars.
      await stopNewBrokerPids(hostBinary, hostHome, brokerPidsBefore);
      await gateway.close().catch(() => {});
      await rm(testRoot, { recursive: true, force: true });
    }
  }
});

test('persistent consent survives Electron relaunch and an explicit local plugin stays local', async () => {
  test.slow();
  const testRoot = await mkdtemp(join(tmpdir(), 'openagent-desktop-plugin-e2e-'));
  const userData = join(testRoot, 'electron-user-data');
  const hostHomeCandidate = join(testRoot, 'host-tools-home');
  const pluginMarker = join(testRoot, 'plugin-invocations.ndjson');
  await mkdir(userData, { recursive: true });
  await mkdir(hostHomeCandidate, { recursive: true });
  const hostHome = await realpath(hostHomeCandidate);

  const pluginConfig = [
    '# Explicit local MCP used by the Desktop release E2E.',
    'version = 1',
    '',
    '[[mcp]]',
    'name = "e2e-local-plugin"',
    `command = [${tomlString(process.execPath)}, ${tomlString(LOCAL_PLUGIN_FIXTURE)}]`,
    'enabled = true',
    `cwd = ${tomlString(HERE)}`,
    `env = { OPENAGENT_E2E_PLUGIN_SECRET = ${tomlString(LOCAL_PLUGIN_SECRET)}, ` +
      `OPENAGENT_E2E_PLUGIN_MARKER = ${tomlString(pluginMarker)} }`,
    '',
  ].join('\n');
  await writeFile(join(hostHome, 'client-mcps.toml'), pluginConfig, { mode: 0o600 });

  const accountId = 'desktop-plugin-e2e-account';
  const networkId = 'network-certified-plugin-e2e';
  const deviceId = 'device-certificate-plugin-e2e';
  const gateway = await new DeterministicGateway({
    webRoot: WEB_ROOT,
    accountId,
    networkId,
    deviceId,
    agentNodeId: 'agent-node-plugin-e2e',
  }).start();
  const hostBinary = resolveHostToolsBinary(DESKTOP_ROOT);
  const brokerPidsBefore = await listBrokerPids(hostBinary, hostHome);
  const shimPidsBefore = await listShimPids(hostBinary);
  const mainOutput = [];
  let electronApp;

  const launchDesktop = async () => {
    const launched = await electron.launch({
      args: [DESKTOP_ROOT, `--user-data-dir=${userData}`],
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OPENAGENT_DESKTOP_E2E: '1',
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/settings`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()),
        OPENAGENT_HOST_TOOLS_BIN: hostBinary,
        OPENAGENT_HOST_TOOLS_HOME: hostHome,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    launched.process().stdout?.on('data', (chunk) => mainOutput.push(chunk.toString()));
    launched.process().stderr?.on('data', (chunk) => mainOutput.push(chunk.toString()));
    return launched;
  };

  const closeDesktop = async () => {
    const active = electronApp;
    electronApp = undefined;
    if (active) {
      const child = active.process();
      const exited = waitForProcessExit(child, 20_000);
      // ElectronApplication.close() closes the last BrowserWindow but macOS
      // intentionally keeps the app/main process alive. Drive the production
      // quit lifecycle so this is a genuine process relaunch and the
      // capability manager gets to release its broker principal cleanly.
      await active.evaluate(({ app }) => { app.quit(); }).catch(() => {});
      await exited;
    }
    await expect.poll(() => gateway.capabilitySocket === null).toBe(true);
  };

  try {
    electronApp = await launchDesktop();
    let page = await electronApp.firstWindow();
    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.setViewportSize({ width: 1_440, height: 960 });
    await expect(page).toHaveURL(`${gateway.baseUrl}/settings`);

    const account = {
      id: accountId,
      name: 'Desktop Plugin E2E',
      network: 'desktop-plugin-e2e',
      handle: 'e2e-plugin-user',
      agentHandle: 'e2e-plugin-agent',
      isLocal: true,
      createdAt: Date.now(),
    };
    await page.evaluate(async ({ accountValue, accountKey, connectionKey, port }) => {
      await window.desktop.setItem(accountKey, JSON.stringify([accountValue]));
      await window.desktop.setItem(connectionKey, JSON.stringify({
        accountId: accountValue.id,
        sidecarPort: port,
      }));
    }, {
      accountValue: account,
      accountKey: 'openagent:accounts',
      connectionKey: 'openagent:activeConnection',
      port: Number(new URL(gateway.baseUrl).port),
    });
    await page.reload();
    await page.getByText('This Computer', { exact: true }).first().click();
    await expect.poll(async () => (await capabilityStatus(page)).phase).toBe('disabled');

    await page.getByRole('switch').first().click();
    const firstHello = await gateway.waitForCapabilityHello();
    const firstElectronPid = electronApp.process().pid;
    await expect.poll(async () => (await capabilityStatus(page)).phase).toBe('connected');
    assertPluginCatalog(firstHello);

    const firstInvocation = await gateway.call(
      'e2e-local-plugin',
      'local_probe',
      { marker: 'first-launch' },
    );
    assertLocalPluginResult(firstInvocation.result);
    await expect.poll(async () => (await readPluginInvocations(pluginMarker)).length).toBe(1);
    const firstMarker = (await readPluginInvocations(pluginMarker))[0];
    expect(firstMarker.envVerified).toBe(true);
    expect(firstMarker.arguments).toEqual({ marker: 'first-launch' });

    const consentPath = join(hostHome, 'client-tools-consent.json');
    expect(JSON.parse(await readFile(consentPath, 'utf8')).enabled).toBe(true);
    const hellosBeforeRelaunch = capabilityHellos(gateway).length;
    await closeDesktop();

    // This is a new Electron main process, not a renderer reload. It must read
    // the broker-owned persistent grant and advertise without another dialog.
    electronApp = await launchDesktop();
    expect(electronApp.process().pid).not.toBe(firstElectronPid);
    page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1_440, height: 960 });
    await expect.poll(async () => (await capabilityStatus(page)).clientInstanceId)
      .not.toBe(firstHello.client_instance_id);
    await expect.poll(async () => (await capabilityStatus(page)).phase).toBe('connected');
    await expect.poll(() => capabilityHellos(gateway).length)
      .toBe(hellosBeforeRelaunch + 1);
    const secondHello = capabilityHellos(gateway).at(-1);
    assertPluginCatalog(secondHello);
    expect(secondHello.client_instance_id).not.toBe(firstHello.client_instance_id);
    expect((await capabilityStatus(page)).consent.enabled).toBe(true);
    expect(JSON.parse(await readFile(consentPath, 'utf8')).enabled).toBe(true);

    const secondInvocation = await gateway.call(
      'e2e-local-plugin',
      'local_probe',
      { marker: 'after-real-relaunch' },
    );
    assertLocalPluginResult(secondInvocation.result);
    await expect.poll(async () => (await readPluginInvocations(pluginMarker)).length).toBe(2);
    expect((await readPluginInvocations(pluginMarker))[1].arguments)
      .toEqual({ marker: 'after-real-relaunch' });

    // The Gateway sees only the plugin's public manifest/call/result. Launch
    // command, cwd, env keys, paths and secret remain inside the local broker.
    const gatewayWire = JSON.stringify(gateway.capabilityFrames);
    for (const localOnly of [
      process.execPath,
      LOCAL_PLUGIN_FIXTURE,
      HERE,
      pluginMarker,
      LOCAL_PLUGIN_SECRET,
      'OPENAGENT_E2E_PLUGIN_SECRET',
      'OPENAGENT_E2E_PLUGIN_MARKER',
    ]) {
      expect(gatewayWire).not.toContain(localOnly);
    }

    await page.getByText('This Computer', { exact: true }).first().click();
    await page.getByText('EMERGENCY DISABLE LOCAL ACCESS', { exact: true }).click();
    await expect.poll(async () => (await capabilityStatus(page)).phase).toBe('disabled');
    await expect.poll(async () => JSON.parse(await readFile(consentPath, 'utf8')).enabled)
      .toBe(false);
    const hellosBeforeRevokedRelaunch = capabilityHellos(gateway).length;
    await closeDesktop();

    electronApp = await launchDesktop();
    page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1_440, height: 960 });
    await expect.poll(async () => (await capabilityStatus(page)).phase).toBe('disabled');
    expect((await capabilityStatus(page)).consent.enabled).toBe(false);
    expect(capabilityHellos(gateway)).toHaveLength(hellosBeforeRevokedRelaunch);
    await expect(gateway.call('e2e-local-plugin', 'local_probe', { marker: 'must-not-run' }))
      .rejects.toThrow('No registered client capability host');
    expect(await readPluginInvocations(pluginMarker)).toHaveLength(2);
  } catch (error) {
    const output = mainOutput.join('').trim();
    if (output) error.message += `\n\nElectron main output:\n${output}`;
    error.message += `\n\nCapability frames:\n${JSON.stringify(gateway.capabilityFrames)}`;
    throw error;
  } finally {
    try {
      if (electronApp) await closeDesktop();
      const leakedShims = [...await listShimPids(hostBinary)]
        .filter((pid) => !shimPidsBefore.has(pid));
      expect(leakedShims, 'Electron relaunch E2E must reap every host-tools stdio shim')
        .toEqual([]);
    } finally {
      await stopNewBrokerPids(hostBinary, hostHome, brokerPidsBefore);
      await gateway.close().catch(() => {});
      await rm(testRoot, { recursive: true, force: true });
    }
  }
});

async function capabilityStatus(page) {
  return page.evaluate(() => window.desktop.getCapabilityStatus());
}

function capabilityHellos(gateway) {
  return gateway.capabilityFrames.filter((frame) => frame.type === 'capability_hello');
}

function assertPluginCatalog(hello) {
  const plugin = hello?.servers?.find((server) => server.name === 'e2e-local-plugin');
  expect(plugin, 'explicit client-mcps.toml plugin must be advertised').toBeTruthy();
  expect(plugin.version).toBe('1.0.0');
  expect(plugin.tools.map((tool) => tool.name)).toEqual(['local_probe']);
  expect(plugin.tools[0].classification).toBe('read_only');
}

function assertLocalPluginResult(result) {
  expect(result?._meta?.['openagent/location']).toBe('client');
  expect(result?._meta?.['openagent/pathSemantics']).toBe('client-local');
  expect(result?.content?.[0]?.text).toBe('local-plugin-ok');
  expect(result?.structuredContent).toEqual({ local: true, env_verified: true });
  expect(result?.isError).toBe(false);
}

async function readPluginInvocations(path) {
  try {
    const value = await readFile(path, 'utf8');
    return value.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function tomlString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`Electron main process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    child.once('exit', onExit);
  });
}

function foregroundCommand() {
  if (process.platform === 'win32') {
    return 'powershell -NoProfile -Command "Start-Sleep -Milliseconds 1200; Write-Output foreground-ok"';
  }
  return 'sleep 1.2; printf foreground-ok';
}

function backgroundCommand() {
  if (process.platform === 'win32') {
    return 'powershell -NoProfile -Command "Start-Sleep -Milliseconds 400; Write-Output background-ok"';
  }
  return 'sleep 0.4; printf background-ok';
}

async function readAudit(auditPath) {
  const script = [
    'import json, sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.row_factory = sqlite3.Row',
    'rows = db.execute("SELECT * FROM audit ORDER BY seq").fetchall()',
    'print(json.dumps([dict(row) for row in rows], separators=(",", ":")))',
  ].join('; ');
  const configured = process.env.OPENAGENT_E2E_PYTHON?.trim();
  const candidates = configured
    ? [configured]
    : process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  let lastError;
  for (const command of candidates) {
    try {
      const args = command === 'py'
        ? ['-3', '-c', script, auditPath]
        : ['-c', script, auditPath];
      const { stdout } = await execFileAsync(command, args, { timeout: 10_000 });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Cannot inspect the real host audit SQLite database: ${lastError}`);
}

async function listBrokerPids(hostBinary, hostHome) {
  if (process.platform === 'win32') {
    const script = [
      '$items = Get-CimInstance Win32_Process',
      `$match = [Regex]::Escape('${hostBinary.replaceAll("'", "''")}')`,
      '$pids = @($items | Where-Object { $_.CommandLine -match $match -and $_.CommandLine -match "--broker" } | ForEach-Object { $_.ProcessId })',
      '$pids | ConvertTo-Json -Compress',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return new Set((Array.isArray(parsed) ? parsed : [parsed]).map(Number));
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
  const candidates = stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    const isHostBroker = !!match && (
      match[2].includes(hostBinary) || match[2].includes('openagent_host_tools')
    );
    if (!match || !isHostBroker || !/(?:^|\s)--broker(?:\s|$)/.test(match[2])) {
      return [];
    }
    return [Number(match[1])];
  });
  const homeMarker = `OPENAGENT_HOST_TOOLS_HOME=${hostHome}`;
  const owned = [];
  for (const pid of candidates) {
    try {
      const detail = await execFileAsync(
        'ps', ['eww', '-p', String(pid), '-o', 'command='], { maxBuffer: 4 * 1024 * 1024 },
      );
      if (detail.stdout.includes(homeMarker)) owned.push(pid);
    } catch {
      // The broker exited between the process and environment snapshots.
    }
  }
  return new Set(owned);
}

async function listShimPids(hostBinary) {
  if (process.platform === 'win32') {
    const script = [
      '$items = Get-CimInstance Win32_Process',
      `$match = [Regex]::Escape('${hostBinary.replaceAll("'", "''")}')`,
      '$pids = @($items | Where-Object { $_.CommandLine -match $match -and $_.CommandLine -notmatch "(?:^|\\s)--broker(?:\\s|$)" } | ForEach-Object { $_.ProcessId })',
      '$pids | ConvertTo-Json -Compress',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return new Set((Array.isArray(parsed) ? parsed : [parsed]).map(Number));
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
  return new Set(stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (
      !match || !match[2].includes(hostBinary) ||
      /(?:^|\s)--broker(?:\s|$)/.test(match[2])
    ) return [];
    return [Number(match[1])];
  }));
}

async function stopNewBrokerPids(hostBinary, hostHome, before) {
  let owned = [...await listBrokerPids(hostBinary, hostHome)].filter((pid) => !before.has(pid));
  for (const pid of owned) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* exited between snapshot and signal */ }
  }
  const deadline = Date.now() + 5_000;
  while (owned.length > 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const live = await listBrokerPids(hostBinary, hostHome);
    owned = owned.filter((pid) => live.has(pid));
  }
  for (const pid of owned) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  if (owned.length > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const leaked = [...await listBrokerPids(hostBinary, hostHome)]
    .filter((pid) => !before.has(pid));
  expect(leaked, 'isolated E2E brokers must be reaped after Electron exits').toEqual([]);
}
