import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { ProvidersGateway } from './provider-fixtures.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class DetailGateway extends ProvidersGateway {
  details = [];
  denied = new Set(['denied-tool']);
  async handleHttp(request, response) {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path.startsWith('/api/tool-invocations/')) {
      this.details.push(path);
      await new Promise(done => setTimeout(done, 250));
      const id = path.split('/').at(-1);
      const json = this.denied.has(id) ? { error: 'target_not_found' } : {
        id, tool_name: 'shell_execute', status: 'success', args_safe: { command: 'fixture command' },
        result_safe: 'Authorized result loaded on demand', error_safe: null,
      };
      response.writeHead(this.denied.has(id) ? 404 : 200,
        { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify(json));
      return;
    }
    return super.handleHttp(request, response);
  }
}

test('tool summaries load details only when opened and retain errors without leaking another result', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'openagent-tool-details-'));
  const userData = join(temporary, 'profile'); await mkdir(userData);
  const gateway = await new DetailGateway({ webRoot: resolve(ROOT, '../universal/dist'),
    accountId: 'details-test', networkId: 'details-network', deviceId: 'fixture-device', agentNodeId: 'fixture-agent' }).start();
  gateway.setRunMessages([
    { id: 'human', role: 'user', text: 'Inspect the saved results.', timestamp: 1700000000 },
    ...['saved-tool', 'denied-tool'].map((id, index) => ({ id, role: 'tool', text: '', timestamp: 1700000001 + index,
      toolInfo: { tool_name: 'shell_execute', tool_call_id: id, tool_invocation_id: id,
        result: '', status: 'success', details_deferred: true } })),
    { id: 'answer', role: 'assistant', text: 'Conversation ready.', timestamp: 1700000003 },
  ]);
  let app;
  try {
    app = await electron.launch({ args: [ROOT, `--user-data-dir=${userData}`], cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1',
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.evaluate(async ({ port }) => {
      const account = { id: 'details-test', name: 'Details fixture', network: 'details-network', handle: 'alice',
        agentHandle: 'agent', isLocal: true, createdAt: Date.now() };
      await window.desktop.setItem('openagent:accounts', JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection', JSON.stringify({ accountId: account.id, sidecarPort: port }));
    }, { port: Number(new URL(gateway.baseUrl).port) });
    await page.reload();
    await expect(page.getByText('Conversation ready.', { exact: true })).toBeVisible();
    expect(gateway.details).toEqual([]);
    const saved = page.getByTestId('tool-invocation-saved-tool');
    await saved.click();
    await expect(saved.getByLabel('Loading tool details')).toBeVisible();
    await expect(saved.getByText('Authorized result loaded on demand', { exact: true })).toBeVisible();
    await saved.click(); await saved.click();
    await expect(saved.getByText('Authorized result loaded on demand', { exact: true })).toBeVisible();
    expect(gateway.details).toEqual(['/api/tool-invocations/saved-tool', '/api/tool-invocations/saved-tool']);
    await saved.click(); gateway.denied.add('saved-tool'); await saved.click();
    await expect(saved.getByRole('alert')).toContainText('could not be loaded');
    await expect(saved.getByText('Authorized result loaded on demand', { exact: true })).toHaveCount(0);
    const denied = page.getByTestId('tool-invocation-denied-tool'); await denied.click();
    await expect(denied.getByRole('alert')).toContainText('could not be loaded');
    await expect(denied.getByText('Authorized result loaded on demand', { exact: true })).toHaveCount(0);
    await denied.click(); await denied.click();
    await expect.poll(() => gateway.details.filter(x => x.endsWith('/denied-tool')).length).toBe(2);
    await expect(page.getByText('Conversation ready.', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await app?.close(); await gateway.close(); }
});
