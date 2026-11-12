import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { _electron as electron, expect, test } from '@playwright/test';
import { DeterministicGateway } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sid = 'e2e-session';

class RecoveryGateway extends DeterministicGateway {
  readers = [];
  turns = [];
  current = { type: 'shared_state', session_id: sid, revision: 0, turns: [] };
  shared = new WebSocketServer({ noServer: true });
  pendingReply = null;
  ignorePing = false;
  child = null;

  async start() {
    await super.start();
    const [upgrade] = this.server.listeners('upgrade');
    this.server.removeListener('upgrade', upgrade);
    this.server.on('upgrade', (request, socket, head) => {
      if (new URL(request.url, this.baseUrl).pathname !== '/ws/collaboration') return upgrade(request, socket, head);
      this.shared.handleUpgrade(request, socket, head, ws => {
        this.readers.push(ws);
        ws.send(JSON.stringify({ type: 'auth_ok', shared: true, heartbeat: true }));
        ws.on('message', raw => {
          const frame = JSON.parse(raw.toString());
          if (frame.type === 'observe') {
            for (const state of [this.current, this.child])
              if (state && frame.sessions.includes(state.session_id)) ws.send(JSON.stringify(state));
          }
          if (frame.type === 'ping' && !this.ignorePing) {
            ws.send(JSON.stringify(this.current));
            ws.send(JSON.stringify({ type: 'pong', id: frame.id }));
          }
        });
      });
    });
    return this;
  }

  async close() {
    for (const ws of this.shared.clients) ws.terminate();
    await new Promise(resolve => this.shared.close(resolve));
    await super.close();
  }

  publish(turn) {
    this.current = { type: 'shared_state', session_id: sid, revision: this.current.revision + 1, turns: [turn] };
    for (const ws of this.shared.clients) ws.send(JSON.stringify(this.current));
  }

  async handleHttp(request, response) {
    const path = new URL(request.url, 'http://fixture').pathname;
    const json = value => response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      .end(JSON.stringify(value));
    if (path === '/api/collaboration') return json({ version: 1 });
    if (path.endsWith('/commands')) return json({ turns: [] });
    if (path === '/api/collaboration/turns') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      this.turns.push(body);
      const now = Date.now() / 1000;
      this.publish({ id: 'save-turn', runId: body.request_id, providerRunId: body.request_id, active: true,
        startedAt: now, messages: [{ id: 'input', role: 'user', text: body.message, timestamp: now }],
        tools: Array.from({ length: 6 }, (_, i) => ({ id: `write-${i}`, timestamp: now, afterText: 0,
          toolInfo: { tool_name: 'vault_write_note', tool_call_id: `write-${i}`, ...(i < 2 ? { result: 'Saved' } : {}) } })) });
      this.pendingReply = () => {
        this.runMessages = [
          { id: 'input', role: 'user', text: body.message, timestamp: now * 1000 },
          ...Array.from({ length: 6 }, (_, i) => ({ id: `tool-${i}`, role: 'tool', text: '', timestamp: now * 1000,
            toolInfo: { tool_name: 'vault_write_note', tool_call_id: `write-${i}`, result: 'Saved' } })),
          { id: 'answer', role: 'assistant', text: 'All six notes were saved', timestamp: now * 1000 + 1000 },
        ];
        // The backend completed, but this reader misses every final frame.
        this.current = { ...this.current, revision: this.current.revision + 1, turns: [] };
        json({ session_id: sid, request_id: body.request_id, response: 'All six notes were saved' });
      };
      return;
    }
    return super.handleHttp(request, response);
  }
}

test('recovers missing terminal frames and a silent observer in the real Mac renderer', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'openagent-shared-recovery-'));
  const userData = join(temporary, 'profile');
  await mkdir(userData);
  const gateway = await new RecoveryGateway({ webRoot: resolve(root, '../universal/dist'), accountId: 'recovery',
    networkId: 'recovery', deviceId: 'recovery-device', agentNodeId: 'recovery-agent' }).start();
  let app;
  try {
    app = await electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root,
      env: { ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1',
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/chat?session=${sid}`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()) } });
    const page = await app.firstWindow();
    await page.evaluate(async port => {
      const account = { id: 'recovery', name: 'Recovery agent', network: 'recovery', handle: 'e2e-user',
        agentHandle: 'recovery-agent', isLocal: true, createdAt: Date.now() };
      await window.desktop.setItem('openagent:accounts', JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection', JSON.stringify({ accountId: account.id, sidecarPort: port }));
    }, Number(new URL(gateway.baseUrl).port));
    await page.reload();
    await expect.poll(() => gateway.readers.length).toBeGreaterThan(0);
    await expect(page.getByText('Local capability E2E', { exact: true })).toBeVisible();
    await page.getByPlaceholder('Message OpenAgent...').fill('Save these six notes');
    await page.getByLabel('Send message', { exact: true }).click();
    await expect(page.getByText('running', { exact: true })).toHaveCount(4);
    const readers = gateway.readers.length;
    gateway.pendingReply();
    await expect(page.getByText('All six notes were saved', { exact: true })).toBeVisible();
    await expect(page.getByText('running', { exact: true })).toHaveCount(0);
    await expect(page.getByText('done', { exact: true })).toHaveCount(6);
    await expect(page.getByTestId('oa-user-message').filter({ hasText: 'Save these six notes' })).toHaveCount(1);
    expect(gateway.turns).toHaveLength(1);
    await expect.poll(() => gateway.readers.length).toBeGreaterThan(readers);

    // A different participant's turn has no local HTTP receipt to rescue it.
    gateway.publish({ id: 'remote-turn', runId: 'remote-request', providerRunId: 'remote-request', active: true,
      startedAt: Date.now() / 1000, messages: [{ id: 'response', role: 'assistant', text: 'Inspecting remotely', timestamp: Date.now() / 1000 }],
      tools: [{ id: 'remote-tool', timestamp: Date.now() / 1000, afterText: 0,
        toolInfo: { tool_name: 'inspect', tool_call_id: 'remote-tool' } }] });
    await expect(page.getByText('running', { exact: true })).toHaveCount(1);
    gateway.ignorePing = true;
    gateway.runMessages = [...gateway.runMessages, { id: 'remote-final', role: 'assistant', text: 'Remote work completed', timestamp: Date.now() }];
    gateway.current = { ...gateway.current, revision: gateway.current.revision + 1, turns: [] };
    const beforeHealthRecovery = gateway.readers.length;
    await expect(page.getByText('Remote work completed', { exact: true })).toBeVisible({ timeout: 35_000 });
    await expect(page.getByText('running', { exact: true })).toHaveCount(0);
    expect(gateway.readers.length).toBeGreaterThan(beforeHealthRecovery);
    expect(gateway.turns).toHaveLength(1);

    // A delegated tool becomes navigable on its admitted child link, before
    // its tool result exists. The child must show ongoing tools and tokens.
    gateway.ignorePing = false;
    const childId = sid + '::sub::specialist::live';
    const parent = { id: 'delegation-turn', runId: 'delegation-request', providerRunId: 'delegation-request', active: true,
      startedAt: Date.now() / 1000, messages: [], tools: [{ id: 'catalog-delegate', timestamp: Date.now() / 1000, afterText: 0,
        toolInfo: { tool_name: 'delegate_task', tool_call_id: 'catalog-delegate', tool_args: { model_id: 'local:active-specialist' } } }] };
    gateway.publish(parent);
    const card = page.getByRole('button', { name: 'Open sub-agent session local:active-specialist', exact: true });
    await expect(card).toBeDisabled();
    gateway.child = { type: 'shared_state', session_id: childId, revision: 1, turns: [{
      id: 'child-turn', runId: 'child-run', providerRunId: 'child-run', active: true, startedAt: Date.now() / 1000,
      messages: [{ id: 'response', role: 'assistant', text: 'Sub-agent streaming before completion', timestamp: Date.now() / 1000 }],
      tools: [{ id: 'child-tool', timestamp: Date.now() / 1000, afterText: 0,
        toolInfo: { tool_name: 'inspect', tool_call_id: 'child-tool' } }],
    }] };
    parent.tools[0].toolInfo.child_session_id = childId;
    gateway.publish(parent);
    await expect(card).toBeEnabled();
    await card.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(childId);
    await expect(page.getByText('Sub-agent streaming before completion', { exact: true })).toBeVisible();
    await expect(page.getByText('running', { exact: true })).toHaveCount(1);
    gateway.child = { ...gateway.child, revision: 2, turns: [{ ...gateway.child.turns[0], messages: [{
      ...gateway.child.turns[0].messages[0], text: 'Sub-agent streaming before completion: new tokens',
    }] }] };
    for (const ws of gateway.shared.clients) ws.send(JSON.stringify(gateway.child));
    await expect(page.getByText('Sub-agent streaming before completion: new tokens', { exact: true })).toBeVisible();
    expect(gateway.child.turns[0].active).toBe(true);
    expect(gateway.current.turns[0].active).toBe(true);
    expect(gateway.turns).toHaveLength(1);
  } finally {
    if (app) await app.close();
    await gateway.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
