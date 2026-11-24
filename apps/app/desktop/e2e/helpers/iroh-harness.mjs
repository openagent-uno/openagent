import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export async function startServerHarness(stateRoot, flags = []) {
  const serverRoot = resolveServerRoot();
  const python = resolveServerPython(serverRoot);
  const script = join(serverRoot, 'scripts', 'desktop_real_iroh_harness.py');
  if (!existsSync(script)) throw new Error(`real-Iroh harness missing: ${script}`);

  const child = spawn(python, ['-u', script, '--root', stateRoot, ...flags], {
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

export async function stopServerHarness(harness) {
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
  const candidate = override || resolve(APP_ROOT, '..', 'server');
  if (!existsSync(join(candidate, 'src', 'openagent_server', 'gateway', 'server.py'))) {
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
