import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { resolveHostToolsBinary, StaticRendererServer } from './fixtures.mjs';
import { startServerHarness, stopServerHarness } from './helpers/iroh-harness.mjs';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED_APP = process.env.OPENAGENT_E2E_PACKAGED_APP;
const text = (page, content) => page.getByText(content, { exact: true });
const button = (page, content) => text(page, content.toUpperCase());

async function enroll(member, root, renderer, apps) {
  const profile = join(root, member.handle);
  await mkdir(profile, { mode: 0o700 });
  const app = await electron.launch({
    executablePath: PACKAGED_APP ? join(PACKAGED_APP, 'Contents/MacOS/OpenAgent') : undefined,
    args: PACKAGED_APP
      ? ['--use-mock-keychain', '--local-e2e', '--e2e-user-data-dir=' + profile]
      : ['--use-mock-keychain', DESKTOP, '--user-data-dir=' + profile],
    cwd: DESKTOP,
    env: {
      ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1', OPENAGENT_DESKTOP_E2E_RENDERER_URL: renderer?.baseUrl || '',
      HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: join(profile, '.config'),
      OPENAGENT_HOST_TOOLS_HOME: join(profile, 'tools'), OPENAGENT_HOST_TOOLS_BIN: PACKAGED_APP
        ? join(PACKAGED_APP, 'Contents/Resources/host-tools/darwin-arm64/openagent-host-tools')
        : resolveHostToolsBinary(DESKTOP),
    },
  });
  apps.push(app);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByPlaceholder('oa1abcdef… (from `openagent invite`)').fill(member.ticket);
  await page.getByPlaceholder('alice').fill(member.handle);
  await page.locator('input[type="password"]').fill(member.password);
  await page.locator('input[type="password"]').press('Enter');
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible({ timeout: 50_000 });
  return page;
}

async function finishTask(page, marker, name, commit) {
  const url = new URL(page.url()).origin;
  await page.goto(url + '/projects');
  await expect(button(page, 'Operations manual')).toBeVisible();
  await page.getByLabel('Task instruction', { exact: true }).fill(marker + ' review');
  await button(page, 'Start task').click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const task = new URL(page.url()).pathname.split('/').pop();
  await expect(text(page, 'Completed review for ' + name)).toBeVisible({ timeout: 150_000 });
  await button(page, 'Review changes').click();
  await expect(page.getByText(/diff --git.*review\.txt/s)).toContainText('review for ' + name);
  await button(page, 'Open terminal').click();
  await page.getByLabel('Terminal input', { exact: true }).fill("printf 'session-%s\\n' '" + name + "'");
  await button(page, 'Send to terminal').click();
  await expect(page.getByText('session-' + name, { exact: false })).toBeVisible();
  await button(page, 'Close terminal').click();
  await button(page, 'Open terminal').click();
  await expect(page.getByText('session-' + name, { exact: false })).toBeVisible();
  await button(page, 'Open preview').click();
  await expect(page.frameLocator('iframe[sandbox]').getByText('Preview for ' + name, { exact: true })).toBeVisible();
  await page.goto(url + '/projects');
  await button(page, 'Open task · ' + commit.slice(0, 8)).click();
  await expect(text(page, 'Completed review for ' + name)).toBeVisible();
  await page.reload();
  await expect(text(page, 'Completed review for ' + name)).toBeVisible();
  return task;
}

async function projections(page, task) {
  return page.evaluate(async (id) => {
    const { accountId } = JSON.parse(await window.desktop.getItem('openagent:activeConnection'));
    const port = await window.desktop.getLoopbackPort(accountId);
    const sid = 'project-task-' + id;
    const reads = {
      task: ['/api/project-tasks/' + id], run: ['/api/runtime/runs/' + id],
      messages: ['/api/sessions/' + sid + '/messages'], turns: ['/api/sessions/' + sid + '/turns'],
      sessions: ['/api/sessions?limit=50'], history: ['/api/history?limit=50'],
      search: ['/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'alpha review', scopes: ['chats'], limit: 30 }) }],
    };
    const out = {};
    for (const [name, [path, options]] of Object.entries(reads)) {
      const response = await fetch('http://127.0.0.1:' + port + path, options);
      const body = await response.text();
      out[name] = { status: response.status, present: [id, 'alpha review', 'Completed review for alice'].some(v => body.includes(v)) };
    }
    return out;
  }, task);
}

function hidden(results) {
  for (const key of ['task', 'messages', 'turns']) expect(results[key]).toEqual({ status: 404, present: false });
  expect(results.run).toEqual({ status: 403, present: false });
  for (const key of ['sessions', 'history', 'search']) expect(results[key]).toEqual({ status: 200, present: false });
}

test('two enrolled owners reopen tasks, constrained VM surfaces and revoked history', async () => {
  test.skip(process.env.OPENAGENT_DESKTOP_PROJECT_TASKS_E2E !== '1', 'requires an operator-prepared private Lima base');
  test.setTimeout(360_000);
  const root = await mkdtemp(join(tmpdir(), 'openagent-project-tasks-'));
  const renderer = PACKAGED_APP ? undefined : await new StaticRendererServer({ webRoot: process.env.OPENAGENT_TEST_RENDERER || resolve(DESKTOP, '../universal/dist') }).start();
  const apps = [];
  let harness;
  try {
    const state = join(root, 'server');
    harness = await startServerHarness(state, ['--project-tasks']);
    const [first, second] = harness.ready.members;
    const alice = await enroll(first, root, renderer, apps);
    const task = await finishTask(alice, 'alpha', 'alice', harness.ready.commit);
    const own = await projections(alice, task);
    for (const k of ['task', 'run', 'messages', 'turns']) expect(own[k]).toEqual({ status: 200, present: true });
    await button(alice, 'Suspend computer').click();
    await expect(button(alice, 'Reconnect computer')).toBeVisible();
    const bravo = await enroll(second, root, renderer, apps);
    const other = await finishTask(bravo, 'bravo', 'bravo', harness.ready.commit);
    expect(other).not.toBe(task);
    await bravo.goto(new URL(bravo.url()).origin + '/projects/' + task);
    await expect(bravo.getByRole('alert')).toContainText('404');
    hidden(await projections(bravo, task));
    await writeFile(join(state, 'revoke-first'), '');
    await alice.goto(new URL(alice.url()).origin + '/projects/' + task);
    await expect(alice.getByRole('alert')).toContainText('404');
    hidden(await projections(alice, task));
    await bravo.goto(new URL(bravo.url()).origin + '/projects/' + other);
    await expect(text(bravo, 'Completed review for bravo')).toBeVisible();
  } finally {
    for (const app of apps.reverse()) await app.close();
    await stopServerHarness(harness);
    await renderer?.close();
    await rm(root, { recursive: true, force: true });
  }
});
