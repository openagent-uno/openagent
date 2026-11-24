import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

export async function readTextOrEmpty(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function listOwnedBrokerPids(hostBinary, hostHome) {
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

export async function stopNewOwnedBrokerPids(hostBinary, hostHome, before) {
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
  assert.deepEqual(leaked, [], 'The isolated capability broker must exit');
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
