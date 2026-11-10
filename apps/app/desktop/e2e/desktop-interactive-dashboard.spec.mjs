import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { DeterministicGateway } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { DASHBOARD_FRAME_CSP } = createRequire(import.meta.url)('../dist/security-policy.js');
const view = {
  id: 'interactive-test', title: 'Interactive lab', surface: 'sidebar', revision: 1, status: 'active', canExecute: true,
  spec: { schemaVersion: 1, root: { type: 'interactive', props: {
    src: 'asset:lab.html', title: 'Lab surface', assets: ['asset:labels.txt', 'asset:calculation.js'],
  } } },
  data: { sample: { value: 42, version: 1 } },
  actions: { recalculate: { kind: 'set_data', label: 'Recalculate dashboard' } },
};

class DashboardGateway extends DeterministicGateway {
  externalRequests = 0;
  actions = [];
  async handleHttp(request, response) {
    const path = new URL(request.url, this.baseUrl).pathname;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    const reply = value => response.writeHead(200, headers).end(JSON.stringify(value));
    if (path === '/dashboard-frame.html') {
      const file = await readFile(resolve(root, '../universal/dist/dashboard-frame.html'));
      return response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': DASHBOARD_FRAME_CSP }).end(file);
    }
    if (path === '/api/ui/views') return reply({ views: [view] });
    if (path === '/api/ui/views/interactive-test') {
      return reply({ view: this.actions.length ? { ...view, data: { sample: { value: 44, version: 2 } } } : view });
    }
    if (path === '/api/ui/views/interactive-test/actions/recalculate' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      this.actions.push(JSON.parse(Buffer.concat(chunks).toString()));
      return reply({ status: 'success' });
    }
    if (path === '/api/ui/views/interactive-test/revisions/1/assets/labels.txt') {
      return response.writeHead(200, { ...headers, 'Content-Type': 'text/plain' }).end('Bundled label');
    }
    if (path === '/api/ui/views/interactive-test/revisions/1/assets/calculation.js') {
      return response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' }).end('export const message = "Loaded module"');
    }
    if (path === '/api/ui/views/interactive-test/revisions/1/assets/lab.html') {
      return response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' }).end(`
        <canvas id="scene" width="100" height="100"></canvas>
        <output id="status"></output><output id="asset"></output><output id="module"></output>
        <button id="increment">Increment</button><button id="escape">Try external navigation</button>
        <button id="action">Request recalculation</button>
        <script>
          let count = 0, value = 0;
          const gl = document.querySelector('#scene').getContext('webgl2');
          if (gl) { gl.clearColor(0.2, 0.4, 0.8, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
          function render() { document.querySelector('#status').textContent = (gl ? 'WebGL' : 'No WebGL') + ' ' + value + ' / ' + count; }
          OpenAgent.onData(data => { value = data.sample ?? 0; render(); });
          OpenAgent.assetBytes('asset:labels.txt').then(result => {
            document.querySelector('#asset').textContent = new TextDecoder().decode(result.bytes);
          });
          OpenAgent.import('asset:calculation.js').then(result => {
            document.querySelector('#module').textContent = result.message;
          });
          document.querySelector('#increment').onclick = () => { count++; render(); };
          document.querySelector('#action').onclick = () => { void OpenAgent.run('recalculate', { count }); };
          document.querySelector('#escape').onclick = () => {
            fetch(${JSON.stringify(this.baseUrl + '/forbidden-data-probe')}).catch(() => {});
            location.href = ${JSON.stringify(this.baseUrl + '/forbidden-data-probe')};
          };
        </script>
      `);
    }
    if (path === '/forbidden-data-probe') { this.externalRequests++; return reply({}); }
    return super.handleHttp(request, response);
  }
}

test('interactive dashboard renders WebGL and scoped assets without allowing network navigation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'openagent-dashboard-ui-'));
  const userData = join(temporary, 'profile');
  await mkdir(userData);
  const gateway = await new DashboardGateway({
    webRoot: resolve(root, '../universal/dist'), accountId: 'dashboard-test',
    networkId: 'dashboard-network', deviceId: 'device-certificate', agentNodeId: 'agent-node',
  }).start();
  let app;
  try {
    app = await electron.launch({
      ...(process.env.OPENAGENT_E2E_ELECTRON_PATH ? { executablePath: process.env.OPENAGENT_E2E_ELECTRON_PATH } : {}),
      args: [root, `--user-data-dir=${userData}`], cwd: root,
      env: { ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1',
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/chat`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()) },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async port => {
      const account = { id: 'dashboard-test', name: 'Dashboard Test', network: 'dashboard-network',
        handle: 'alice', agentHandle: 'agent', isLocal: true, createdAt: Date.now() };
      await window.desktop.setItem('openagent:accounts', JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection', JSON.stringify({ accountId: account.id, sidecarPort: port }));
    }, Number(new URL(gateway.baseUrl).port));
    await page.reload();
    await page.getByRole('button', { name: 'Interactive lab', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Lab surface"]');
    await expect(frame.getByText('WebGL 42 / 0', { exact: true })).toBeVisible();
    await expect(frame.getByText('Bundled label', { exact: true })).toBeVisible();
    await expect(frame.getByText('Loaded module', { exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Increment' }).click();
    await expect(frame.getByText('WebGL 42 / 1', { exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Request recalculation' }).click();
    await expect(page.getByText('Recalculate dashboard', { exact: true })).toBeVisible();
    expect(gateway.actions).toHaveLength(0);
    await page.getByRole('button', { name: 'RUN', exact: true }).click();
    await expect.poll(() => gateway.actions.length).toBe(1);
    expect(gateway.actions[0].input).toEqual({ count: 1 });
    await expect(frame.getByText('WebGL 44 / 1', { exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Try external navigation' }).click();
    await expect(frame.getByText('WebGL 44 / 1', { exact: true })).toBeVisible();
    expect(gateway.externalRequests).toBe(0);
  } finally {
    await app?.close();
    await gateway.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
