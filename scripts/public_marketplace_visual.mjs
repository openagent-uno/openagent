// Actual published Electron UI only: no route fixtures, token injection or model.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [executable, profile, driverRoot, evidence, expectationPath] = process.argv.slice(2);
const require = createRequire(path.join(driverRoot, 'package.json'));
const { _electron: electron, expect } = require('@playwright/test');
const expected = expectationPath ? JSON.parse(await readFile(expectationPath, 'utf8'))
  : { appVersion: '1.1.0-beta.17', serverVersion: '1.1.0b39', officialIds: null };
assert(/^1\.1\.0-beta\.(17|18)$/.test(expected.appVersion));
assert(/^1\.1\.0b(39|40)$/.test(expected.serverVersion));
assert(expected.officialIds === null || (Array.isArray(expected.officialIds)
  && expected.officialIds.length === 14 && new Set(expected.officialIds).size === 14
  && expected.officialIds.every(id => typeof id === 'string' && /^[a-z0-9_-]{1,64}$/.test(id))));
const screenshotPrefix = `app${expected.appVersion.split('.').at(-1)}-server${expected.serverVersion.split('b').at(-1)}`;

let input = '';
for await (const block of process.stdin) { input += block; assert(input.length < 20000); }
const invitation = JSON.parse(input); input = '';
let app;
let phase = 'launch-public-package';
let receipt;
async function markPhase(value) {
  phase = value;
  await writeFile(path.join(evidence, 'ui-progress.json'), JSON.stringify({ phase }) + '\n', { mode: 0o600 });
}
try {
  await markPhase('launch-public-package');
  app = await electron.launch({ executablePath: executable,
    args: ['--no-sandbox', '--local-e2e', `--e2e-user-data-dir=${profile}`],
    env: process.env, timeout: 60000 });
  let page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1040 });
  await markPhase('wait-for-ordinary-join-form');
  const ticket = page.getByPlaceholder('oa1abcdef… (from `openagent invite`)');
  // A fresh ordinary profile automatically opens this form after storage loads.
  await expect(ticket).toBeVisible({ timeout: 30000 });
  await markPhase('fill-invite-ticket'); await ticket.fill(invitation.ticket);
  await markPhase('fill-join-handle');
  await page.getByPlaceholder('alice').fill(invitation.handle);
  await markPhase('fill-join-password');
  const password = page.locator('input[type="password"]');
  await password.fill(invitation.password);
  await markPhase('keep-remembered-password-disabled');
  for (const toggle of await page.getByRole('switch').all()) {
    if (await toggle.getAttribute('aria-checked') === 'true') await toggle.click();
  }
  await markPhase('submit-ordinary-join');
  await password.press('Enter');
  invitation.ticket = ''; invitation.password = '';
  await markPhase('wait-for-connected-agent-window');
  await expect.poll(async () => {
    for (const window of app.windows()) {
      if (await window.getByText('Connectors', { exact: true }).first().isVisible()) { page = window; return true; }
    }
    return false;
  }, { timeout: 60000 }).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1040 });
  await markPhase('select-authenticated-marketplace');
  const rendererOrigin = new URL(page.url()).origin;
  const responses = new Map();
  page.on('response', async response => {
    const url = new URL(response.url());
    if (!['/api/marketplace/official', '/api/connectors', '/api/marketplace/search'].includes(url.pathname)) return;
    try {
      assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.origin, rendererOrigin);
      const body = response.status() === 200 ? await response.json() : null;
      responses.set(url.pathname, { status: response.status(), body });
    } catch { responses.set(url.pathname, { status: 0, body: null }); }
  });
  await page.getByText('Connectors', { exact: true }).first().click();
  await markPhase('wait-for-marketplace-search');
  await expect(page.getByPlaceholder('Search marketplace')).toBeVisible({ timeout: 30000 });
  await markPhase('wait-for-first-registry-response');
  await expect.poll(() => responses.has('/api/marketplace/search'), { timeout: 30000 }).toBe(true);
  if (responses.get('/api/marketplace/search').status !== 200) {
    await markPhase('retry-registry-once');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
  }
  await markPhase('wait-for-authenticated-catalog-responses');
  await expect.poll(() => responses.get('/api/marketplace/official')?.status, { timeout: 30000 }).toBe(200);
  await expect.poll(() => responses.get('/api/connectors')?.status, { timeout: 30000 }).toBe(200);
  await expect.poll(() => responses.get('/api/marketplace/search')?.status, { timeout: 30000 }).toBe(200);
  const official = responses.get('/api/marketplace/official').body.connectors;
  const registry = responses.get('/api/marketplace/search').body.servers;
  await markPhase('verify-live-catalog-and-auth-screen-absence');
  assert.equal(official.length, expected.officialIds?.length ?? 12);
  if (expected.officialIds) assert.deepEqual(official.map(item => item.id).sort(), expected.officialIds);
  assert(registry.length > 0);
  assert.equal(responses.get('/api/connectors').body.connections.length, 0);
  for (const item of official) await expect(page.getByText(item.name, { exact: true }).first()).toHaveCount(1);
  const verifiedIcons = [];
  if (expected.officialIds) {
    await markPhase('verify-new-provider-local-images');
    for (const id of ['github', 'notion', 'slack-import', 'atlassian']) {
      const item = official.find(connector => connector.id === id); assert(item);
      const logo = page.getByText(item.name, { exact: true }).first().locator('..').locator('img').first();
      await expect.poll(() => logo.evaluate((image, reference) => {
        const source = new URL(image.currentSrc || image.src);
        const basename = source.pathname.split('/').at(-1);
        return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
          && source.origin === reference.origin
          && new RegExp(`^${reference.id}(?:\\.[a-f0-9]+)?\\.png$`).test(basename);
      }, { origin: rendererOrigin, id }), { timeout: 15000 }).toBe(true);
      verifiedIcons.push(id);
    }
  }
  // Semantic labels/tabs are stable; unlabelled visual dividers remain screenshot evidence.
  await expect(page.getByText(/^official(?: connectors)?$/i)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /official/i })).toHaveCount(0);
  await expect(page.getByRole('separator', { name: /official/i })).toHaveCount(0);
  await expect(page.getByText('Some marketplace results could not load.', { exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByPlaceholder('oa1abcdef… (from `openagent invite`)')).toHaveCount(0);
  // Capture only after ordinary authentication and live catalog responses.
  await markPhase('capture-authenticated-marketplace-top');
  await page.screenshot({ path: path.join(evidence, `${screenshotPrefix}-marketplace-top.png`) });
  await markPhase('scroll-with-pointer-over-marketplace-cards');
  await page.mouse.move(900, 600);
  await page.mouse.wheel(0, 850); await page.waitForTimeout(500);
  await markPhase('capture-authenticated-marketplace-scroll');
  await page.screenshot({ path: path.join(evidence, `${screenshotPrefix}-marketplace-scroll.png`) });
  receipt = { status: 'passed', appVersion: expected.appVersion, serverVersion: expected.serverVersion,
    verifiedLocalProviderIcons: verifiedIcons, officialLabelOrTabAbsent: true,
    unlabelledDividerAcceptance: 'screenshot review only',
    officialCount: official.length, officialIds: official.map(item => item.id).sort(), registryCount: registry.length,
    transport: 'ordinary UI join/SRP/device certificate/native Iroh proxy',
    backendMocked: false, modelInvoked: false, cookieOrTokenExported: false,
    hostedElectronSandboxDisabled: true, sandboxSecurityAcceptance: false,
    profilePolicy: 'packaged --local-e2e isolates temp profile/updater only; authentication unchanged',
    apiStatus: Object.fromEntries([...responses].map(([key, value]) => [key, value.status])),
    guiScope: 'real Linux x64 packaged marketplace; no provider grants or Mac/Windows GUI acceptance' };
} catch {
  receipt = { status: 'failed', phase, reason: 'actual-ui-contract-failed' };
} finally {
  try {
    if (app) {
      const child = app.process();
      await app.close();
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 10000 }).toBe(true);
      receipt.clientExitCode = Number.isInteger(child.exitCode) ? child.exitCode : null;
      receipt.clientExitSignal = ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(child.signalCode) ? child.signalCode : null;
    }
    receipt.clientCleanupConfirmed = true;
  } catch {
    if (receipt.status === 'passed') receipt = { status: 'failed', phase: 'owned-client-cleanup', reason: 'client-cleanup-failed' };
    receipt.clientCleanupConfirmed = false;
    receipt.clientCleanupReason = 'client-cleanup-failed';
  }
}
await writeFile(path.join(evidence, 'ui-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
if (receipt.status !== 'passed') process.exit(1);
console.log(JSON.stringify(receipt));
