import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { DeterministicGateway } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.now();

const PROVIDERS = [
  { id: 1, name: 'local', framework: 'api-based', kind: 'llm', base_url: 'http://claude-proxy.default.svc.cluster.local:8787/v1', enabled: true, metadata: {}, api_key_display: '••••1234' },
  { id: 2, name: 'codex', framework: 'api-based', kind: 'llm', base_url: 'http://codex-proxy.default.svc.cluster.local:8788/v1', enabled: true, metadata: {}, api_key_display: '••••5678' },
  { id: 3, name: 'windows-local', framework: 'api-based', kind: 'llm', base_url: 'http://100.89.54.20:8099/v1', enabled: true, metadata: {}, api_key_display: '' },
  { id: 4, name: 'anthropic', framework: 'api-based', kind: 'llm', base_url: null, enabled: true, metadata: {}, api_key_display: 'sk-…9z' },
  { id: 5, name: 'elevenlabs', framework: 'api-based', kind: 'tts', base_url: null, enabled: true, metadata: {}, api_key_display: '••••ab' },
];
const llm = (id, provider_id, provider_name, model, extra = {}) => ({
  id, provider_id, provider_name, framework: 'api-based', kind: 'llm', runtime_id: `${provider_name}:${model}`, model,
  display_name: null, tier_hint: null, enabled: true, is_classifier: false, provider_enabled: true,
  input_cost_per_million: 0, output_cost_per_million: 0, ...extra,
});
const MODELS = [
  llm(1, 1, 'local', 'claude-opus-5', { display_name: 'Claude Opus 5', is_classifier: true,
    metadata: { input_modalities: ['text', 'image', 'file'], input_modalities_source: 'provider' } }),
  llm(2, 2, 'codex', 'gpt-5.6-sol', { display_name: 'GPT-5.6 sol',
    metadata: { input_modalities: ['text', 'image'], input_modalities_source: 'provider', fallback_priority: 1 } }),
  llm(3, 3, 'windows-local', 'qwen3-moe-local', { display_name: 'Qwen3 MoE',
    metadata: { input_modalities: ['text'], input_modalities_source: 'default', fallback_priority: 2 } }),
  llm(4, 4, 'anthropic', 'claude-haiku-5-5', { display_name: 'Claude Haiku 5.5', input_cost_per_million: 1, output_cost_per_million: 5,
    metadata: { input_modalities: ['text', 'image', 'audio'], input_modalities_source: 'manual', fallback_priority: 3 } }),
  { id: 5, provider_id: 5, provider_name: 'elevenlabs', framework: 'api-based', kind: 'tts', runtime_id: 'elevenlabs:eleven_flash', model: 'eleven_flash',
    display_name: 'ElevenLabs Flash', enabled: true, is_classifier: false, provider_enabled: true, metadata: { voice_id: 'Bella' },
    input_cost_per_million: 0, output_cost_per_million: 0 },
];
const ACCOUNTS = { providers: [
  { provider: 'local', provider_id: 1, base_url: PROVIDERS[0].base_url, enabled: true, reachable: true, status: 'ok', metrics: null, error: null,
    accounts: [
      { id: 'a1', name: 'Work', priority: 10, plan: 'max', limited: false, status: 'ok', quota: null, source: 'proxy' },
      { id: 'a2', name: 'Personal', priority: 20, plan: 'pro', limited: true, limited_until_ms: NOW + 3_600_000, status: 'rate_limited', quota: null, source: 'proxy' },
    ] },
  { provider: 'codex', provider_id: 2, base_url: PROVIDERS[1].base_url, enabled: true, reachable: true, status: 'auth_expired', metrics: null, error: null,
    accounts: [
      { id: 'c1', name: 'ChatGPT Pro', priority: 10, plan: 'pro', limited: false, status: 'auth_expired', source: 'proxy',
        quota: { primary_used_percent: 41, primary_window_minutes: 300, primary_reset_after_s: 7800, secondary_used_percent: 12, secondary_window_minutes: 10080, secondary_reset_after_s: 400000 } },
    ] },
  { provider: 'windows-local', provider_id: 3, base_url: PROVIDERS[2].base_url, enabled: true, reachable: false, status: 'unreachable', accounts: [], metrics: null, error: 'timeout' },
] };

class ModelsGateway extends DeterministicGateway {
  refreshes = [];
  async handleHttp(request, response) {
    const path = new URL(request.url, 'http://fixture').pathname;
    const reply = (value, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (path === '/api/providers' && request.method === 'GET') return reply({ providers: PROVIDERS });
    if (path === '/api/models' && request.method === 'GET') return reply({ models: MODELS });
    if (path === '/api/accounts') return reply(ACCOUNTS);
    if (path === '/api/models/available') return reply({ provider_id: 4, provider: 'anthropic', framework: 'api-based', models: [
      { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', kind: 'llm', runtime_id: 'anthropic:claude-haiku-5-5', added: true },
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', kind: 'llm', runtime_id: 'anthropic:claude-sonnet-5', added: false,
        detected_input_modalities: ['text', 'image', 'file'], detected_input_modalities_source: 'default' },
    ] });
    const refresh = /^\/api\/providers\/(\d+)\/refresh-capabilities$/.exec(path);
    if (refresh) { this.refreshes.push(Number(refresh[1])); return reply({ ok: true, provider_id: Number(refresh[1]), reachable: true, updated: [], manual: 0 }); }
    if (path === '/api/budgets/usage') return reply({ usage: [] });
    return super.handleHttp(request, response);
  }
}

test('models grid shows access, inputs, status, quota and pricing, and the add wizard walks its steps', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'openagent-models-ui-'));
  const userData = join(temporary, 'profile'); await mkdir(userData);
  const gateway = await new ModelsGateway({ webRoot: resolve(ROOT, '../universal/dist'), accountId: 'models-test', networkId: 'models-network', deviceId: 'device-certificate', agentNodeId: 'agent-node' }).start();
  let app;
  try {
    app = await electron.launch({ ...(process.env.OPENAGENT_E2E_ELECTRON_PATH ? { executablePath: process.env.OPENAGENT_E2E_ELECTRON_PATH } : {}),
      args: [ROOT, `--user-data-dir=${userData}`], cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1', OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(async ({ port }) => {
      const account = { id: 'models-test', name: 'Models Test', network: 'models-network', handle: 'alice', agentHandle: 'agent', isLocal: true, createdAt: Date.now() };
      await window.desktop.setItem('openagent:accounts', JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection', JSON.stringify({ accountId: account.id, sidecarPort: port }));
    }, { port: Number(new URL(gateway.baseUrl).port) });
    await page.reload();
    await page.getByLabel('Settings', { exact: true }).first().click();
    await page.getByText('Models & Providers', { exact: true }).first().click();
    await expect(page.getByText('Claude Opus 5', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Sign-in expired').first()).toBeVisible();
    await expect(page.getByText('Not reachable').first()).toBeVisible();
    await expect(page.getByText('Quota not reported').first()).toBeVisible();
    await expect(page.getByText(/41% used/).first()).toBeVisible();
    await page.screenshot({ path: join(temporary, 'models-grid-wide.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(temporary, 'models-grid-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: 'Add model' }).first().click();
    await expect(page.getByText('How do you access it?', { exact: false }).first()).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(temporary, 'models-wizard-step1.png') });
    await page.getByText('API key', { exact: true }).first().click();
    await page.getByText(/^next$/i).last().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(temporary, 'models-wizard-step2.png') });
    await page.getByText('anthropic', { exact: true }).last().click();
    await page.getByText(/^next$/i).last().click();
    await expect(page.getByText('Claude Sonnet 5', { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(temporary, 'models-wizard-step3.png') });
    expect(pageErrors).toEqual([]);
  } finally {
    await app?.close();
    await gateway.close();
  }
});
