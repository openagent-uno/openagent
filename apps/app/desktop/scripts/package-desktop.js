#!/usr/bin/env node
/** Cross-platform, fail-closed Electron packaging entry point. */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const platform = args.includes('--mac')
  ? 'darwin'
  : args.includes('--win') ? 'win32' : args.includes('--linux') ? 'linux' : process.platform;
const arch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : process.arch;
if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  throw new Error(`Unsupported packaged host target: ${platform}-${arch}`);
}
if (!args.some((arg) => arg === '--arm64' || arg === '--x64')) args.push(`--${arch}`);

const env = {
  ...process.env,
  OPENAGENT_REQUIRE_HOST_TOOLS: '1',
  OPENAGENT_HOST_TOOLS_PLATFORM_KEY: `${platform}-${arch}`,
};

run('stage host-tools', process.execPath, [path.join(__dirname, 'stage-host-tools.js')]);
run('TypeScript', process.execPath, [require.resolve('typescript/bin/tsc')]);
run('Electron main bundle', process.execPath, [path.join(__dirname, 'bundle-main.js')]);
run('electron-builder', process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), ...args]);

function run(label, command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: desktop,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[package] ${label} failed with exit code ${String(result.status)}`);
    process.exit(result.status ?? 1);
  }
}
