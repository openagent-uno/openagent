import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { DeterministicGateway } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class RailGateway extends DeterministicGateway {
  async handleHttp(request, response) {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/api/agent/identity' && request.method !== 'OPTIONS') {
      if (request.method === 'PATCH') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        this.profile = JSON.parse(Buffer.concat(chunks).toString());
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.end(JSON.stringify({
        name: this.accountId, system_prompt: '', revision: '0'.repeat(64),
        thumbnail: null, ...this.profile,
      }));
      return;
    }
    const empty = {
      '/api/sessions/e2e-session/participants': { participants: [] },
      '/api/sessions/e2e-session/devices': { devices: [] },
      '/api/sessions/e2e-session/computer-targets': { targets: [] },
      '/api/collaboration': { version: 0 },
    }[path];
    if (!empty) return super.handleHttp(request, response);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    response.end(JSON.stringify(empty));
  }

  handleChatSocket(socket) {
    this.chatSocket = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      this.chatFrames.push(frame);
      if (frame.type === 'auth') {
        socket.send(JSON.stringify({ type: 'auth_ok', agent_name: this.accountId, version: 'e2e' }));
      }
    });
  }
}

test('switches agents in place, restores saved logins, and keeps drawer geometry', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'openagent-rail-'));
  const userData = join(temporary, 'profile');
  await mkdir(userData);
  const gateways = await Promise.all(['Atlas', 'Nova'].map(async (accountId) => {
    const server = await new RailGateway({
      accountId, networkId: accountId, deviceId: 'rail-device', agentNodeId: accountId,
      webRoot: resolve(root, '../universal/dist'),
    }).start();
    server.runMessages = [{ role: 'user', text: `Conversation from ${accountId}`, timestamp: 1700000000 }];
    return server;
  }));
  let app;
  try {
    app = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1',
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: gateways[0].baseUrl,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateways.map(gateway => gateway.loopbackConfig())),
      },
    });
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('loopback:listSavedNetworkAgents');
      ipcMain.handle('loopback:listSavedNetworkAgents', (_event, network, handle) => {
        if (network !== 'legacy-network' || handle !== 'e2e-user') throw new Error('Wrong saved network');
        return [{ handle: 'legacy-agent', label: 'Legacy Login' }, { handle: 'other-agent', label: 'Other agent' }];
      });
    });
    page.on('pageerror', error => console.error(error.message));
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect(page.getByText('Add an agent', { exact: true })).toBeVisible();
    await expect(page.getByTestId('agent-rail')).toHaveCount(0);
    await page.evaluate(async () => {
      const accounts = ['Atlas', 'Nova'].map(id => ({
        id, name: id, network: 'desktop-e2e', handle: 'e2e-user', agentHandle: 'e2e-agent',
        isLocal: true, createdAt: Date.now(),
      }));
      accounts.push(
        { id: 'legacy', name: 'Legacy Login', network: 'legacy-network', handle: 'e2e-user',
          isLocal: true, createdAt: Date.now() },
        { id: 'pinned', name: 'Pinned Login', network: 'pinned-network', handle: 'e2e-user',
          agentHandle: 'pinned-agent', isLocal: true, createdAt: Date.now() },
      );
      await window.desktop.setItem('openagent:accounts', JSON.stringify(accounts));
      await window.desktop.setItem('openagent:activeConnection', JSON.stringify({ accountId: 'Atlas' }));
    });
    await page.reload();
    const atlas = page.getByRole('button', { name: 'Atlas', exact: true });
    const nova = page.getByRole('button', { name: 'Nova', exact: true });
    await expect(atlas.getByTestId('selected-agent-marker')).toBeVisible();
    await expect(page.getByText('Conversation from Atlas')).toBeVisible();
    await expect.poll(() => gateways[1].chatFrames.filter(frame => frame.type === 'auth').length).toBe(1);
    await expect(nova).not.toHaveText('Nova');
    await nova.click();
    await expect(nova.getByTestId('selected-agent-marker')).toBeVisible();
    await expect(page.getByText('Conversation from Nova')).toBeVisible();
    await expect(page.getByText('Conversation from Atlas')).toHaveCount(0);
    await atlas.click();
    await expect(page.getByText('Conversation from Atlas')).toBeVisible();
    for (const gateway of gateways) {
      expect(gateway.chatFrames.filter(frame => frame.type === 'auth')).toHaveLength(1);
    }
    expect(app.windows()).toHaveLength(1);

    const header = page.getByTestId('session-workspace-header');
    const drawer = page.getByTestId('session-details-fixed-width');
    const toggle = page.getByRole('button', { name: 'Toggle session details' });
    await toggle.click();
    await expect(page.getByTestId('session-details-drawer-content')).toBeVisible();
    await expect.poll(async () => {
      const h = await header.boundingBox();
      const d = await drawer.boundingBox();
      return d && h ? [Math.round(d.y - h.y), Math.round(d.x - h.x - h.width)] : null;
    }).toEqual([0, 0]);
    await expect(page.getByRole('button', { name: 'Close session details' })).toHaveCount(0);
    const openWidth = (await drawer.boundingBox()).width;
    await toggle.click();
    expect((await drawer.boundingBox()).width).toBe(openWidth);

    const plus = page.getByRole('button', { name: 'Add an agent' });
    await plus.click();
    await expect(page.getByRole('button', { name: /^join network$/i })).toBeVisible();
    await expect(page.getByText('Your agents', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^join network$/i })).toHaveCount(0);
    await atlas.dblclick();
    await expect(page.getByText('Remove saved login', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^cancel$/i }).click();
    await expect(atlas).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const choose = page.getByRole('button', { name: /choose thumbnail/i });
    await expect(choose).toBeEnabled();
    const [picker] = await Promise.all([page.waitForEvent('filechooser'), choose.click()]);
    await picker.setFiles({
      name: 'avatar.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64'),
    });
    await expect(page.getByRole('button', { name: /^remove thumbnail$/i })).toBeVisible();
    await page.getByRole('button', { name: /^save identity$/i }).click();
    await expect.poll(() => gateways[0].profile?.thumbnail).toMatch(/^data:image\/jpeg;base64,/);
    await expect(atlas.locator('img').first()).toBeVisible();

    gateways[0].chatSocket.close(1011);
    const reconnect = page.getByText('Reconnecting…', { exact: true });
    await expect(reconnect).toBeVisible();
    const statusBox = await reconnect.boundingBox();
    for (const name of ['Settings', 'Logs', 'System']) {
      const buttonBox = await page.getByRole('button', { name, exact: true }).boundingBox();
      const offset = (buttonBox.y + buttonBox.height / 2) - (statusBox.y + statusBox.height / 2);
      expect(Math.abs(offset)).toBeLessThanOrEqual(1);
    }

    await page.getByRole('button', { name: 'Pinned Login', exact: true }).click();
    await expect(page.getByPlaceholder('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByPlaceholder('Password', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Legacy Login', exact: true }).click();
    await expect(page.getByRole('radio', { name: /Legacy Login/ })).toHaveAttribute('aria-checked', 'true');
    const other = page.getByRole('radio', { name: /Other agent/ });
    await other.click();
    await expect(other).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByPlaceholder('Password', { exact: true })).toBeVisible();
    await expect(page.getByText('Agent handle', { exact: true })).toHaveCount(0);
  } finally {
    await app?.close();
    await Promise.all(gateways.map(gateway => gateway.close()));
    await rm(temporary, { recursive: true, force: true });
  }
});
