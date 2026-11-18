import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { ProvidersGateway } from './provider-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DELAYS_MS = {
  '/api/providers': 50,
  '/api/models': 50,
  '/api/accounts': 2500,
  '/api/budgets/usage': 1000,
  '/api/usage': 1000,
  '/api/usage/daily': 1000,
};

class LoadingPerformanceGateway extends ProvidersGateway {
  requests = [];

  async handleHttp(request, response) {
    const url = new URL(request.url || '/', 'http://fixture');
    if (!url.pathname.startsWith('/api/')) return super.handleHttp(request, response);
    const entry = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      startedAt: performance.now(),
      finishedAt: null,
      delayMs: request.method === 'GET' ? (DELAYS_MS[url.pathname] ?? 0) : 0,
    };
    this.requests.push(entry);
    response.once('finish', () => { entry.finishedAt = performance.now(); });
    if (entry.delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, entry.delayMs));
    return super.handleHttp(request, response);
  }
}

const elapsed = (start, end) => Math.round((end - start) * 100) / 100;
const requestCounts = (requests) => requests.reduce((counts, request) => {
  const key = `${request.method} ${request.path}`;
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});

test('benchmark provider cards with independently delayed enrichment', async ({}, testInfo) => {
  test.setTimeout(45_000);
  const temporary = await mkdtemp(join(tmpdir(), 'openagent-loading-performance-'));
  const userData = join(temporary, 'profile');
  await mkdir(userData);
  const gateway = await new LoadingPerformanceGateway({
    webRoot: resolve(ROOT, '../universal/dist'),
    accountId: 'models-test', networkId: 'models-network',
    deviceId: 'device-certificate', agentNodeId: 'agent-node',
  }).start();
  let app;
  try {
    app = await electron.launch({
      ...(process.env.OPENAGENT_E2E_ELECTRON_PATH ? { executablePath: process.env.OPENAGENT_E2E_ELECTRON_PATH } : {}),
      args: [ROOT, `--user-data-dir=${userData}`], cwd: ROOT,
      env: {
        ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1',
        OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/`,
        OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.evaluate(async ({ port }) => {
      const account = {
        id: 'models-test', name: 'Models Test', network: 'models-network',
        handle: 'alice', agentHandle: 'agent', isLocal: true, createdAt: Date.now(),
      };
      await window.desktop.setItem('openagent:accounts', JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection', JSON.stringify({ accountId: account.id, sidecarPort: port }));
    }, { port: Number(new URL(gateway.baseUrl).port) });
    await page.reload();
    await page.getByLabel('Settings', { exact: true }).first().click();
    const modelsNavigation = page.getByText('Models & Providers', { exact: true }).first();
    await expect(modelsNavigation).toBeVisible();

    // Include the navigation dispatch, network, parsing and first visible render.
    // Account identity and quota are separate milestones, not prerequisites for this one.
    const startedAt = performance.now();
    await modelsNavigation.click();
    await expect(page.locator('[data-testid^="provider-card-"]').first()).toBeVisible({ timeout: 15_000 });
    const firstCardAt = performance.now();
    await expect(page.getByTestId('provider-card-1:account-1')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('42% used').first()).toBeVisible({ timeout: 15_000 });
    const enrichmentAt = performance.now();

    const measuredRequests = gateway.requests.filter((request) => request.startedAt >= startedAt);
    const report = {
      benchmark: 'models-and-providers-first-card',
      label: process.env.OPENAGENT_PERF_LABEL ?? 'unlabelled',
      delays_ms: DELAYS_MS,
      first_card_ms: elapsed(startedAt, firstCardAt),
      account_and_quota_ms: elapsed(startedAt, enrichmentAt),
      request_counts: requestCounts(measuredRequests),
      request_counts_before_first_card: requestCounts(measuredRequests.filter((request) => request.startedAt <= firstCardAt)),
      bootstrap_request_counts: requestCounts(gateway.requests.filter((request) => request.startedAt < startedAt)),
      requests: measuredRequests.map((request) => ({
        method: request.method, path: request.path, query: request.query,
        started_ms: elapsed(startedAt, request.startedAt),
        finished_ms: request.finishedAt === null ? null : elapsed(startedAt, request.finishedAt),
        duration_ms: request.finishedAt === null ? null : elapsed(request.startedAt, request.finishedAt),
        delay_ms: request.delayMs,
      })),
      page_errors: pageErrors,
    };
    const json = JSON.stringify(report, null, 2);
    console.log(`OPENAGENT_LOADING_PERFORMANCE ${JSON.stringify(report)}`);
    await testInfo.attach('loading-performance.json', { body: json, contentType: 'application/json' });
    // Retained Settings routes must not poll providers while chat owns focus.
    await page.clock.install();
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.getByPlaceholder('Message OpenAgent...')).toBeVisible();
    const hiddenReads = () => gateway.requests.filter((r) => ['/api/providers', '/api/accounts', '/api/models', '/api/budgets/usage', '/api/usage/daily'].includes(r.path)).length;
    const readsBeforeIdle = hiddenReads();
    await page.clock.fastForward(61_000);
    expect(hiddenReads()).toBe(readsBeforeIdle);
    expect(pageErrors).toEqual([]);
  } finally {
    await app?.close();
    await gateway.close();
  }
});
