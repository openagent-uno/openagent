import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { resolveHostToolsBinary, StaticRendererServer } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..');
const APP_ROOT = resolve(DESKTOP_ROOT, '..');
const WEB_ROOT = join(APP_ROOT, 'universal', 'dist');
const REAL_IROH_ENABLED = process.env.OPENAGENT_REAL_DESKTOP_IROH_E2E === '1';

test('real Electron enrolls and executes client:filesystem over coordinator + Gateway + Iroh', async () => {
  test.skip(
    !REAL_IROH_ENABLED,
    'set OPENAGENT_REAL_DESKTOP_IROH_E2E=1 with a server checkout to run the real-wire E2E',
  );
  test.slow();

  const testRoot = await mkdtemp(join(tmpdir(), 'openagent-desktop-real-iroh-'));
  const userData = join(testRoot, 'electron-user-data');
  const clientHome = join(testRoot, 'client-home');
  const hostHomeCandidate = join(testRoot, 'host-tools-home');
  const serverState = join(testRoot, 'server-state');
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(clientHome, { recursive: true }),
    mkdir(hostHomeCandidate, { recursive: true }),
    mkdir(serverState, { recursive: true }),
  ]);
  const hostHome = await realpath(hostHomeCandidate);
  const hostBinary = resolveHostToolsBinary(DESKTOP_ROOT);
  const brokerPidsBefore = await listOwnedBrokerPids(hostBinary, hostHome);
  let renderer;
  let harness;
  let electronApp;
  const mainOutput = [];

  try {
    renderer = await new StaticRendererServer({ webRoot: WEB_ROOT }).start();
    harness = await startServerHarness(serverState);
    electronApp = await electron.launch({
      args: [DESKTOP_ROOT, `--user-data-dir=${userData}`],
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OPENAGENT_DESKTOP_E2E: '1',
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: renderer.baseUrl,
        OPENAGENT_HOST_TOOLS_BIN: hostBinary,
        OPENAGENT_HOST_TOOLS_HOME: hostHome,
        HOME: clientHome,
        USERPROFILE: clientHome,
        XDG_CONFIG_HOME: join(clientHome, '.config'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    electronApp.process().stdout?.on('data', (chunk) => mainOutput.push(chunk.toString()));
    electronApp.process().stderr?.on('data', (chunk) => mainOutput.push(chunk.toString()));

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1_440, height: 960 });
    await expect(page).toHaveURL(renderer.baseUrl + '/');

    // Retain the first BrowserWindow before evaluating in Electron's main
    // realm.  Cold macOS CI launches can otherwise collect the pending
    // Playwright promise.  Preserve production consent IPC and replace only
    // the physical click in the native warning dialog.
    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });

    const enabled = await page.evaluate(() => window.desktop.setCapabilityEnabled(true));
    expect(enabled.consent.enabled).toBe(true);

    // Drive the actual onboarding UI. Electron's main process creates its own
    // device identity, redeems the one-use invitation through coordinator
    // SRP, pins the returned certificate, and opens the native TS Iroh proxy.
    await page.getByPlaceholder('oa1abcdef… (from `openagent invite`)')
      .fill(harness.ready.ticket);
    await page.getByPlaceholder('alice').fill(harness.ready.handle);
    const password = page.locator('input[type="password"]');
    await password.fill(harness.ready.password);
    // React Native Web's TouchableOpacity is intentionally a non-native div
    // here, but the password input's production submit handler invokes the
    // same handleJoin callback and is stable across its generated DOM.
    await password.press('Enter');

    await expect(page.getByPlaceholder('Message OpenAgent...')).toBeVisible({ timeout: 30_000 });
    await expect.poll(
      async () => (await page.evaluate(() => window.desktop.getCapabilityStatus())).phase,
      { timeout: 20_000 },
    ).toBe('connected');

    const status = await page.evaluate(() => window.desktop.getCapabilityStatus());
    const clientInstanceId = await page.evaluate(() => window.desktop.clientInstanceId);
    expect(clientInstanceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(status.connectedAccounts).toBe(1);
    expect(status.servers.some((server) => server.name === 'filesystem')).toBe(true);

    const composer = page.getByPlaceholder('Message OpenAgent...');
    await composer.fill('desktop: write and read the Desktop Iroh sentinel');
    await composer.press('Enter');
    await expect(page.getByText('desktop file written', { exact: true }))
      // A clean release runner pays the full first-turn MCP/provider startup
      // cost; local developer environments usually have this state warm.
      .toBeVisible({ timeout: 90_000 });

    await expect.poll(
      async () => readTextOrEmpty(harness.ready.target_path),
      { timeout: 10_000 },
    ).toBe('desktop-sentinel');

    // ExecutionHost must survive the runtime envelope and the live Gateway
    // stream into the real renderer, not merely exist in a server-side log.
    const deviceLabel = `${hostname()} (OpenAgent Desktop)`;
    const locationLabel = `This computer · ${deviceLabel}`;
    await expect(page.getByText(locationLabel, { exact: true }).last())
      .toBeVisible({ timeout: 15_000 });
    await page.getByText(locationLabel, { exact: true }).last().click();
    await expect(page.getByText('Execution host', { exact: true }).last()).toBeVisible();
    await expect(page.getByText(
      `${deviceLabel} · client ${clientInstanceId}`,
      { exact: true },
    ).last()).toBeVisible();

    const evidence = await waitForModelEvidence(harness.ready.evidence_path, 3);
    const transcript = JSON.stringify(evidence);
    expect(transcript).toContain('client:filesystem');
    expect(transcript).toContain('desktop-sentinel');
    expect(transcript).toContain('execution_host');
    expect(transcript).toContain(clientInstanceId);
    // The runtime may append a separate summarization model call after the
    // agent loop. Select the latest request that actually contains both tool
    // results instead of assuming the final provider request is the turn.
    const toolResults = [...evidence].reverse()
      .map((call) => (call?.messages || []).filter((message) => message?.role === 'tool'))
      .find((messages) => messages.length >= 2) || [];
    expect(toolResults).toHaveLength(2);
    const readResult = JSON.stringify(toolResults.at(-1)?.content);
    expect(readResult).toContain('desktop-sentinel');
    expect(readResult).not.toMatch(/"isError"\s*:\s*true/i);
    const enrolledNetworks = await readFile(
      join(clientHome, '.openagent', 'user', 'networks.toml'),
      'utf8',
    );
    expect(enrolledNetworks).toContain(harness.ready.network_id);

    // The renderer origin is static-only. If chat or capability traffic ever
    // bypassed the native loopback, this list would expose the regression.
    expect(renderer.requests.filter((request) => request.path.startsWith('/api/'))).toEqual([]);
  } catch (error) {
    const electronOutput = mainOutput.join('').trim();
    if (electronOutput) error.message += `\n\nElectron main output:\n${electronOutput}`;
    if (harness?.output.trim()) {
      error.message += `\n\nServer harness output:\n${harness.output.trim()}`;
    }
    throw error;
  } finally {
    try {
      if (electronApp) await electronApp.close();
    } finally {
      await stopServerHarness(harness).catch(() => {});
      await stopNewOwnedBrokerPids(hostBinary, hostHome, brokerPidsBefore);
      await renderer?.close().catch(() => {});
      await rm(testRoot, { recursive: true, force: true });
    }
  }
});

async function startServerHarness(stateRoot) {
  const serverRoot = resolveServerRoot();
  const python = resolveServerPython(serverRoot);
  const script = join(serverRoot, 'scripts', 'desktop_real_iroh_harness.py');
  if (!existsSync(script)) throw new Error(`real-Iroh harness missing: ${script}`);

  const child = spawn(python, ['-u', script, '--root', stateRoot], {
    cwd: serverRoot,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const holder = { child, output: '', ready: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { holder.output += chunk; });

  try {
    holder.ready = await new Promise((resolvePromise, reject) => {
      let stdoutBuffer = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`real-Iroh server harness did not become ready\n${holder.output}`));
      }, 30_000);
      const onData = (chunk) => {
        holder.output += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          const marker = 'OPENAGENT_DESKTOP_IROH_READY ';
          if (!line.startsWith(marker)) continue;
          try {
            const value = JSON.parse(line.slice(marker.length));
            cleanup();
            resolvePromise(value);
          } catch (error) {
            cleanup();
            reject(error);
          }
        }
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(
          `real-Iroh server harness exited before ready (code=${code}, signal=${signal})\n` +
          holder.output,
        ));
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      child.stdout.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  } catch (error) {
    try { child.stdin.end(); } catch { /* process may already be gone */ }
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    try {
      await waitForExit(child, 5_000);
    } catch {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      await waitForExit(child, 5_000).catch(() => {});
    }
    throw error;
  }
  // Continue retaining stdout after the readiness parser detached.
  child.stdout.on('data', (chunk) => { holder.output += chunk; });
  return holder;
}

async function stopServerHarness(harness) {
  const child = harness?.child;
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.stdin.end('stop\n');
  try {
    await waitForExit(child, 20_000);
  } catch {
    try { child.kill('SIGTERM'); } catch { /* process already exited */ }
    try {
      await waitForExit(child, 5_000);
    } catch {
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
      await waitForExit(child, 5_000).catch(() => {});
    }
  }
  if (child.exitCode !== 0 && child.signalCode == null) {
    throw new Error(`real-Iroh harness cleanup failed (code=${child.exitCode})\n${harness.output}`);
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    child.once('exit', onExit);
  });
}

function resolveServerRoot() {
  const override = process.env.OPENAGENT_REAL_DESKTOP_SERVER_ROOT?.trim();
  const candidate = override || resolve(APP_ROOT, '..', 'openagent-server');
  if (!existsSync(join(candidate, 'src', 'gateway', 'server.py'))) {
    throw new Error(
      `OpenAgent server checkout not found at ${candidate}; set ` +
      'OPENAGENT_REAL_DESKTOP_SERVER_ROOT',
    );
  }
  return candidate;
}

function resolveServerPython(serverRoot) {
  const override = process.env.OPENAGENT_REAL_DESKTOP_PYTHON?.trim();
  const candidates = [
    override,
    process.platform === 'win32'
      ? join(serverRoot, '.venv', 'Scripts', 'python.exe')
      : join(serverRoot, '.venv', 'bin', 'python'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `server Python environment missing; set OPENAGENT_REAL_DESKTOP_PYTHON. ` +
      `Checked: ${candidates.join(', ')}`,
    );
  }
  return found;
}

async function readTextOrEmpty(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function waitForModelEvidence(path, minimumCalls) {
  const deadline = Date.now() + 10_000;
  let last = [];
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(path, 'utf8'));
      if (Array.isArray(last) && last.length >= minimumCalls) return last;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`expected at least ${minimumCalls} deterministic model calls, got ${last.length}`);
}

async function listOwnedBrokerPids(hostBinary, hostHome) {
  const marker = (await readTextOrEmpty(join(hostHome, 'host-tools', 'broker.pid'))).trim();
  const ownerPid = Number(marker);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return new Set();

  if (process.platform === 'win32') {
    const escapedBinary = hostBinary.replaceAll("'", "''");
    const script = [
      `$item = Get-CimInstance Win32_Process -Filter "ProcessId = ${ownerPid}"`,
      `$bin = [Regex]::Escape('${escapedBinary}')`,
      '$pids = @($item | Where-Object { $_.CommandLine -match $bin -and $_.CommandLine -match "--broker" } | ForEach-Object { $_.ProcessId })',
      '$pids | ConvertTo-Json -Compress',
    ].join('; ');
    const output = await runProcess('powershell', ['-NoProfile', '-Command', script]);
    const parsed = output.trim() ? JSON.parse(output) : [];
    return new Set((Array.isArray(parsed) ? parsed : [parsed]).map(Number));
  }
  let command;
  try {
    command = await runProcess('ps', ['-p', String(ownerPid), '-o', 'command=']);
  } catch {
    return new Set();
  }
  const isBroker = command.includes(hostBinary) || command.includes('openagent_host_tools');
  return isBroker && /(?:^|\s)--broker(?:\s|$)/.test(command)
    ? new Set([ownerPid])
    : new Set();
}

async function stopNewOwnedBrokerPids(hostBinary, hostHome, before) {
  let owned = [...await listOwnedBrokerPids(hostBinary, hostHome)]
    .filter((pid) => !before.has(pid));
  for (const pid of owned) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  const deadline = Date.now() + 5_000;
  while (owned.length && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const live = await listOwnedBrokerPids(hostBinary, hostHome);
    owned = owned.filter((pid) => live.has(pid));
  }
  for (const pid of owned) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  const leaked = [...await listOwnedBrokerPids(hostBinary, hostHome)]
    .filter((pid) => !before.has(pid));
  expect(leaked, 'real-Iroh E2E must reap its isolated capability broker').toEqual([]);
}

function runProcess(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}
