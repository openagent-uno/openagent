import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { ProvidersGateway } from './provider-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const accountPolicy of [false, true]) {
test(`providers keep concurrent accounts and typed models independent (account policy ${accountPolicy})`, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'openagent-providers-ui-'));
  const userData = join(temporary, 'profile'); await mkdir(userData);
  const gateway = await new ProvidersGateway({ webRoot: resolve(ROOT, '../universal/dist'), accountId: 'models-test', networkId: 'models-network', deviceId: 'device-certificate', agentNodeId: 'agent-node' }).start();
  gateway.accountPolicyFields = accountPolicy ? ['fallback_enabled'] : [];
  for (const provider of gateway.providers.slice(0, 2)) Object.assign(provider.metadata,
    { account_fallback_group: 'declared-fixture-group', account_fallback_enabled: true, ...(accountPolicy ? { account_fallback_kinds: ['llm', 'image'] } : {}) });
  // Plain API vendors have no subscription-account endpoint. That probe's
  // negative result must never masquerade as an inference outage.
  gateway.accounts.push({ provider: gateway.providers[2].name, provider_id: 3,
    enabled: true, reachable: false, status: 'unreachable', accounts: [] });
  let app;
  try {
    app = await electron.launch({ ...(process.env.OPENAGENT_E2E_ELECTRON_PATH ? { executablePath: process.env.OPENAGENT_E2E_ELECTRON_PATH } : {}),
      args: [ROOT, `--user-data-dir=${userData}`], cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1', OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const page = await app.firstWindow();
    const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.evaluate(async ({ port }) => {
      const account = { id: 'models-test', name: 'Models Test', network: 'models-network', handle: 'alice', agentHandle: 'agent', isLocal: true, createdAt: Date.now() };
      await window.desktop.setItem('openagent:accounts', JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection', JSON.stringify({ accountId: account.id, sidecarPort: port }));
    }, { port: Number(new URL(gateway.baseUrl).port) });
    await page.reload();
    await page.getByLabel('Settings', { exact: true }).first().click();
    await page.getByText('Models & Providers', { exact: true }).first().click();
    await expect(page.getByTestId('provider-card-1:account-1')).toBeVisible();
    await expect(page.getByTestId('provider-card-2:account-2')).toBeVisible();
    await expect(page.getByTestId('provider-card-3:connection')).toBeVisible();
    await expect(page.getByTestId('provider-card-3:connection').getByText('Configured', { exact: true })).toBeVisible();
    await expect(page.getByTestId('provider-card-3:connection').getByText('Not reachable', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('provider-card-4:account-4')).toBeVisible();
    await expect(page.getByTestId('provider-card-5:account-5')).toBeVisible();
    await expect(page.getByTestId('provider-card-6:connection')).toBeVisible();
    // A new vendor continues the connection grid instead of leaving empty columns.
    const firstRow = await page.getByTestId('provider-card-1:account-1').boundingBox();
    const nextRow = await page.getByTestId('provider-card-4:account-4').boundingBox();
    expect(nextRow.y - firstRow.y - firstRow.height).toBeLessThan(20);
    await expect(page.getByText('Sign-in expired').first()).toBeVisible();
    await expect(page.getByText('Quota not reported').first()).toBeVisible();
    await expect(page.getByText('42% used').first()).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: join(temporary, 'providers-grid-wide.png'), fullPage: true });
    await page.getByTestId('provider-card-1:account-1').getByRole('switch').click();
    await expect(page.getByTestId('provider-card-1:account-1').getByRole('switch')).not.toBeChecked();
    await expect(page.getByTestId('provider-card-2:account-2').getByRole('switch')).toBeChecked();
    expect(gateway.mutations.at(-1).path).toBe('/api/providers/1/accounts/account-1');
    await page.getByTestId('provider-card-2:account-2').getByRole('button', { name: /^Models & settings$/i }).click();
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Automatic account fallback', exact: true })).toBeChecked();
    await page.getByRole('switch', { name: 'Automatic account fallback', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Automatic account fallback', exact: true })).not.toBeChecked();
    if (accountPolicy) {
      expect(gateway.mutations.at(-1)).toMatchObject({ path: '/api/providers/2/accounts/account-2', value: { fallback_enabled: false } });
      await expect(page.getByText(/same text or image model/)).toBeVisible();
    } else {
      expect(gateway.mutations.at(-1).value.metadata).toMatchObject({ account_fallback_group: 'declared-fixture-group', account_fallback_enabled: false });
      await expect(page.getByText(/same text model/)).toBeVisible();
    }
    await page.getByRole('button', { name: /^All providers$/i }).click();
    await expect(page.getByTestId('provider-card-1:account-1').getByRole('switch')).not.toBeChecked();
    await expect(page.getByTestId('provider-card-2:account-2').getByRole('switch')).toBeChecked();
    await page.getByTestId('provider-card-6:connection').getByRole('button', { name: /^Models\ \&\ settings$/i, exact: true }).click();
    await expect(page.getByRole('button', { name: 'All providers', exact: true })).toBeInViewport();
    await expect(page.getByText('Speech model', { exact: true })).toBeVisible();
    await expect(page.getByText('Image model', { exact: true })).toBeVisible();
    await expect(page.getByText('Transcription model', { exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: join(temporary, 'provider-models.png'), fullPage: true });
    await page.getByRole('button', { name: /^Settings & budget$/i }).first().click();
    await expect(page.getByText('Reasoning effort', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Temperature', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'API key', exact: true })).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: join(temporary, 'model-settings.png'), fullPage: true });
    await page.getByRole('button', { name: /^high$/i, exact: true }).click();
    await page.getByRole('switch', { name: 'Use as backup', exact: true }).click();
    await page.getByRole('textbox', { name: 'Backup priority', exact: true }).fill('2');
    await page.getByRole('button', { name: /^Save\ settings$/i, exact: true }).click();
    await expect(page.getByText('Reasoning effort', { exact: true })).toHaveCount(0);
    expect(gateway.mutations.at(-1).value.metadata).toMatchObject({ reasoning_effort: 'high', fallback_priority: 2 });
    for (const [id, field, value] of [[62, 'Voice', 'fixture-voice'], [63, 'Language', 'it']]) {
      await page.getByTestId(`model-card-${id}`).getByRole('button', { name: 'Settings & budget', exact: true }).click();
      await page.getByRole('textbox', { name: field, exact: true }).fill(value);
      await expect(page.getByRole('switch', { name: 'Use as backup', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Save settings', exact: true }).click();
      expect(gateway.mutations.at(-1).value.metadata[field === 'Voice' ? 'voice_id' : 'language']).toBe(value);
    }
    await page.getByRole('button', { name: /^Add\ models$/i, exact: true }).click();
    await page.getByRole('button', { name: /^Speech\ \(TTS\)$/i, exact: true }).last().click();
    await expect(page.getByText('New tts model', { exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: join(temporary, 'add-speech-model.png'), fullPage: true });
    await page.getByRole('button', { name: /^Select$/i, exact: true }).click();
    await page.getByRole('button', { name: /^Add\ 1\ models$/i, exact: true }).click();
    await expect(page.getByText('new-tts', { exact: true })).toBeVisible();
    expect(gateway.mutations.at(-1).value).toMatchObject({ provider_id: 6, kind: 'tts', model: 'new-tts' });
    await page.getByRole('button', { name: /^Usage\ \&\ budget$/i, exact: true }).click();
    await page.getByRole('button', { name: /^New cap for Production · Connection budget$/i, exact: true }).click();
    await page.getByLabel('Limit (USD)', { exact: true }).fill('20');
    await page.screenshot({ animations: 'disabled', path: join(temporary, 'connection-budget.png'), fullPage: true });
    await page.getByRole('button', { name: /^Create$/i, exact: true }).click();
    await expect(page.getByRole('button', { name: /^New cap for Production · Connection budget$/i })).toBeVisible();
    expect(gateway.mutations.at(-1).value).toMatchObject({ scope_kind: 'provider', scope_value: 'openai-api-6', amount: 20 });
    await page.getByRole('button', { name: /^All\ providers$/i, exact: true }).click();
    await page.getByTestId('provider-card-6:connection').getByRole('button', { name: /^Models & settings$/i }).click();
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    gateway.connectionTestOk = false;
    await page.getByRole('button', { name: /^Test connection$/i }).click();
    await expect(page.getByText('Connection test failed.', { exact: true })).toBeVisible();
    await expect(page.getByText('Connection works.', { exact: true })).toHaveCount(0);
    gateway.connectionTestOk = true;
    await page.getByRole('button', { name: /^Test connection$/i }).click();
    await expect(page.getByText('Connection works.', { exact: true })).toBeVisible();
    await expect(page.getByText('Connection test failed.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^All providers$/i }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: join(temporary, 'providers-grid-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.getByRole('button', { name: 'Connect provider', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'API key', exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: join(temporary, 'connect-api.png'), fullPage: true });
    await page.getByRole('button', { name: 'Claude subscription', exact: true }).click();
    await expect(page.getByLabel('Account name', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'API key', exact: true })).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: join(temporary, 'connect-subscription.png'), fullPage: true });
    await page.getByRole('button', { name: 'DeepSeek', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'API key', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claude subscription', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Custom / compatible', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Service identifier', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Endpoint', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Local', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'API key (optional)', exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
    console.log('Provider screenshots:', temporary);
  } finally { await app?.close(); await gateway.close(); }
});

}
