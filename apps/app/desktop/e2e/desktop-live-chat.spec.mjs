import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

import { DeterministicGateway } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..');
const APP_ROOT = resolve(DESKTOP_ROOT, '..');
const WEB_ROOT = join(APP_ROOT, 'universal', 'dist');

test('live chat survives navigation and a child first-frame reasoning signal', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'openagent-live-chat-e2e-'));
  const userData = join(testRoot, 'electron-user-data');
  await mkdir(userData, { recursive: true });

  const accountId = 'desktop-live-e2e-account';
  const networkId = 'desktop-live-e2e-network';
  const gateway = await new DeterministicGateway({
    webRoot: WEB_ROOT,
    accountId,
    networkId,
    deviceId: 'desktop-live-e2e-device',
    agentNodeId: 'desktop-live-e2e-agent',
  }).start();
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
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/chat?session=e2e-session`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    electronApp.process().stdout?.on('data', (chunk) => mainOutput.push(chunk.toString()));
    electronApp.process().stderr?.on('data', (chunk) => mainOutput.push(chunk.toString()));
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1_440, height: 960 });

    const account = {
      id: accountId,
      name: 'Desktop Live E2E',
      network: 'desktop-live-e2e',
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
    await page.goto(`${gateway.baseUrl}/chat?session=e2e-session`);
    await expect(page.getByText('Local capability E2E', { exact: true })).toBeVisible();

    // Reproduce the live-turn rollback: optimistic user + partial assistant,
    // leave Chat, receive a metadata upsert whose projection still says
    // live=false, then return through the real sidebar.
    gateway.sendChatFrame({
      type: 'text_final', session_id: 'e2e-session', text: 'latest live request',
    });
    gateway.sendChatFrame({
      type: 'delta', session_id: 'e2e-session', text: 'partial live answer',
    });
    await expect(page.getByText('latest live request', { exact: true })).toBeVisible();
    await expect(page.getByText('partial live answer', { exact: true })).toBeVisible();

    await page.getByLabel('Settings', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/settings$/);
    const stamp = new Date().toISOString();
    gateway.sendChatFrame({
      type: 'history_changed',
      action: 'upsert',
      item: {
        id: 'activity:session:e2e-session',
        kind: 'chat',
        resource_id: 'e2e-session',
        session_id: 'e2e-session',
        title: 'Local capability E2E',
        origin: 'chat',
        occurred_at: stamp,
        updated_at: stamp,
        live: false,
        completeness: 'partial',
      },
    });
    await page.getByText('Local capability E2E', { exact: true }).click();
    await expect(page.getByText('latest live request', { exact: true })).toBeVisible();
    await expect(page.getByText('partial live answer', { exact: true })).toBeVisible();

    // Reproduce the sub-agent case: reasoning is the child's first frame,
    // before its sidebar metadata exists. Open it through the production
    // delegation card and verify the animated state survived routing.
    const childId = 'e2e-session::sub::researcher::run-1';
    gateway.sendChatFrame({
      type: 'reasoning', session_id: childId, active: true,
    });
    gateway.sendChatFrame({
      type: 'status',
      session_id: 'e2e-session',
      text: JSON.stringify({
        tool_name: 'delegate_task',
        tool_call_id: 'delegate-e2e-1',
        tool_args: { model_id: 'researcher' },
        child_session_id: childId,
        child_session_title: 'Research child',
        result: JSON.stringify({ child_session_id: childId }),
        status: 'completed',
      }),
    });
    await page.getByText('Research child', { exact: true }).click();
    await expect(page).toHaveURL(/session=e2e-session%3A%3Asub%3A%3Aresearcher%3A%3Arun-1/);
    await expect(page.getByLabel('Reasoning', { exact: true })).toBeVisible();
  } catch (error) {
    const output = mainOutput.join('').trim();
    if (output) error.message += `\n\nElectron main output:\n${output}`;
    throw error;
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    await gateway.close().catch(() => {});
    await rm(testRoot, { recursive: true, force: true });
  }
});
