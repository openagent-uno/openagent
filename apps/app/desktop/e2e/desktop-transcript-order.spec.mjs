import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { DeterministicGateway } from './fixtures.mjs';

// Run after the web export with the project's Playwright Chromium installed.
// OPENAGENT_E2E_WEB_ROOT points to an isolated baseline or candidate export.
const sessionId = 'e2e-session';
const dated = '2026-08-01T12:00:00.000Z';
const intro = 'First I will inspect the sample.';
const aside = 'The first lookup is complete.';
const conclusion = 'The sample is ready.';
const checkpoints = new Map([
  [95, 'A checkpoint in the long list of tool calls.'],
  [145, 'A result farther along in the same turn.'],
]);
const fullAnswer = [intro, aside, conclusion].join('\n\n');
const textPart = text => ({ kind: 'text', text });
const segment = text => ({ text, parts: [textPart(text)] });

// Same cardinality as a reported long conversation, synthesized from scratch.
// The long turn crosses more than two pages without its final assistant row.
const messages = [];
for (const [index, toolCount] of [2, 5, 190, 4, 0, 9, 4, 6, 8].entries()) {
  const runId = `fixture-run-${index}`;
  const add = (role, id, text, extra = {}) => messages.push({
    id, text, role, run_id: runId, session_id: sessionId, ordinal: messages.length + 1,
    status: 'complete', author: { kind: role === 'user' ? 'user' : 'agent' },
    created_at: dated, completeness: 'complete', ...extra,
  });
  add('user', `prompt-${index}`, `Synthetic prompt ${index}`);
  for (let call = 0; call < toolCount; call++) {
    const id = `fixture-tool-${index}-${call}`;
    const text = index === 8 ? [intro, aside][call] : index === 2 ? checkpoints.get(call) : undefined;
    add('tool', id, '', {
      tool_invocation_id: id,
      tool_summary: { id, tool_call_id: id, tool_name: 'inspect_sample', status: 'success' },
      ...(text && { transcript_segment: segment(text) }),
    });
  }
  const text = index === 8 ? fullAnswer : index === 2
    ? [...checkpoints.values(), 'Long turn complete.'].join('\n\n') : `Synthetic answer ${index}`;
  const end = index === 8 ? conclusion : index === 2 ? 'Long turn complete.' : undefined;
  add('assistant', `answer-${index}`, text, {
    parts: [textPart(text)],
    ...(end && { transcript_segment: segment(end) }),
  });
}

class TranscriptGateway extends DeterministicGateway {
  messagePages = [];
  failBefore = false;
  failLatest = false;
  transcriptRows = messages;
  pausedRequest;
  resume = Promise.withResolvers();

  async handleHttp(request, response) {
    const { pathname, searchParams } = new URL(request.url, 'http://fixture');
    const json = (value, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (pathname === '/api/capabilities') {
      if (this.pausedRequest === 'discovery') await this.resume.promise;
      return json({
        api_revision: 1, features: { history: { version: 2, kinds: ['chat'], snapshot_pagination: true, max_page_size: 100 } },
        storage: { history_ready: true, history_pending: 0, search_ready: false },
      });
    }
    if (pathname === '/api/history') return json({
      items: [{ id: sessionId, resource_id: sessionId, kind: 'chat', title: 'Synthetic transcript',
        live: false, occurred_at: dated, updated_at: dated }],
      next_cursor: null, has_more: false, revision: '1',
      snapshot: { snapshot_id: 'fixture', revision: '1', expires_at: '2030-01-01T00:00:00Z' },
    });
    if (pathname === '/api/collaboration') return this.sharedDelivery ? json({ version: 1 })
      : json({ error: 'Legacy live transport fixture' }, 404);
    if (pathname !== `/api/sessions/${sessionId}/messages`) return super.handleHttp(request, response);
    const around = searchParams.get('around');
    if (!around && this.pausedRequest === 'latest page') await this.resume.promise;
    const interleaved = searchParams.get('timeline') === 'interleaved';
    const anchor = this.transcriptRows.findIndex(row => row.id === around);
    const lower = Math.max(0, anchor < 0 ? this.transcriptRows.length - Number(searchParams.get('limit') || 60)
      : anchor - Number(searchParams.get('before')));
    const upper = anchor < 0 ? this.transcriptRows.length
      : Math.min(this.transcriptRows.length, anchor + 1 + Number(searchParams.get('after')));
    const rows = this.transcriptRows.slice(lower, upper);
    const failed = around ? this.failBefore && searchParams.get('after') === '0' : this.failLatest;
    this.messagePages.push({ around, interleaved, rows, failed });
    if (failed) {
      if (around) this.failBefore = false;
      else this.failLatest = false;
      return json({ error: 'synthetic interrupted history page' }, 503);
    }
    return json({
      session_id: sessionId, revision: '1', messages: interleaved ? rows
        : rows.map(({ transcript_segment, ...row }) => row),
      anchor_found: around ? anchor >= 0 : null, anchor_message_id: around,
      before_cursor: lower > 0 ? String(lower) : null,
      after_cursor: upper < this.transcriptRows.length ? String(upper) : null,
      has_more_before: lower > 0, has_more_after: upper < this.transcriptRows.length,
    });
  }
}

test.use({
  headless: true,
  viewport: { width: 1280, height: 900 },
  reducedMotion: 'reduce',
  ...(process.env.OPENAGENT_E2E_CHROMIUM && {
    launchOptions: { executablePath: process.env.OPENAGENT_E2E_CHROMIUM },
  }),
});

async function openTranscript(page, { anchor, live = false, pausedRequest, sharedDelivery = false } = {}) {
  const webRoot = process.env.OPENAGENT_E2E_WEB_ROOT
    || fileURLToPath(new URL('../../universal/dist', import.meta.url));
  const gateway = await new TranscriptGateway({ webRoot, accountId: 'transcript-fixture',
    networkId: 'transcript-network', deviceId: 'fixture-device', agentNodeId: 'fixture-agent' }).start();
  if (live) gateway.transcriptRows = messages.filter(row => row.run_id !== 'fixture-run-8');
  gateway.sharedDelivery = sharedDelivery;
  if (sharedDelivery) await page.routeWebSocket('**/ws/collaboration', socket => {
    socket.send(JSON.stringify({ type: 'auth_ok', shared: true }));
    socket.onMessage(() => {});
  });
  gateway.pausedRequest = pausedRequest;
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === gateway.baseUrl) return route.continue();
    return route.abort();
  });
  await page.addInitScript(({ port, accountId, platform }) => {
    const id = sessionStorage.getItem('fixture-account') ?? accountId;
    const account = { id, name: 'Transcript Fixture', network: 'transcript-network',
      handle: 'e2e-user', agentHandle: 'fixture-agent', isLocal: true, createdAt: 1 };
    localStorage.setItem('openagent:accounts', JSON.stringify([account]));
    localStorage.setItem('openagent:activeConnection', JSON.stringify({ accountId: id, sidecarPort: port }));
    // Only the preload boundary is simulated. Browser storage and the
    // application's real fetch, websocket, transcript and pagination run.
    window.desktop = {
      isDesktop: true, platform, clientInstanceId: 'fixture-instance', isMaximized: async () => false,
      getItem: async key => localStorage.getItem(key),
      setItem: async (key, value) => localStorage.setItem(key, value),
      removeItem: async key => localStorage.removeItem(key),
      startLoopback: async () => ({ port }), getLoopbackPort: async () => port,
    };
    // Keep the copy assertion inside the temporary browser profile.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async text => { window.fixtureCopiedText = text; } },
    });
  }, { port: Number(new URL(gateway.baseUrl).port), accountId: gateway.accountId, platform: process.platform });
  const url = new URL(`/chat?session=${sessionId}`, gateway.baseUrl);
  if (anchor) url.searchParams.set('message', anchor);
  await page.goto(url.toString());
  return { gateway, errors };
}

async function expectOrder(...locators) {
  for (const locator of locators) {
    await expect(locator).toHaveCount(1);
    await expect(locator).toBeVisible();
  }
  const handles = await Promise.all(locators.map(locator => locator.elementHandle()));
  try {
    for (let index = 1; index < handles.length; index++) {
      const inOrder = await handles[index - 1].evaluate((a, b) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), handles[index]);
      expect(inOrder, `${locators[index - 1]} should precede ${locators[index]}`).toBe(true);
    }
  } finally {
    await Promise.all(handles.map(handle => handle.dispose()));
  }
}

const latestTurnOrder = page => [
  page.getByText(intro, { exact: true }), page.getByTestId('tool-invocation-fixture-tool-8-0'),
  page.getByText(aside, { exact: true }), page.getByTestId('tool-invocation-fixture-tool-8-1'),
  page.getByText(conclusion, { exact: true }),
];
const countAuthentications = gateway => gateway.chatFrames.filter(frame => frame.type === 'auth').length;
async function reconnect(gateway) {
  const previous = countAuthentications(gateway);
  for (const socket of gateway.chatServer.clients) socket.terminate();
  await expect.poll(() => countAuthentications(gateway)).toBeGreaterThan(previous);
}

test('retries one rejected shared input with its uploaded file after returning and reconnecting', async ({ page }) => {
  const { gateway } = await openTranscript(page, { sharedDelivery: true });
  const filename = 'retry-original.txt';
  const prompt = 'Return the exact sample';
  const row = page.getByTestId('oa-user-message').filter({ hasText: prompt });
  const retry = row.getByRole('button', { name: 'Retry send' });
  const posts = [];
  let uploads = 0;
  const release = Promise.withResolvers();
  const artifact = { artifact_id: 'art_retry_sample', filename, type: 'file', size_bytes: 5 };
  try {
    await page.evaluate(filename => {
      window.desktop.pickFiles = async () => [{ path: '/fixture/' + filename, filename, kind: 'file', size: 5, maxBytes: 1024 }];
      window.desktop.readFile = async () => new TextEncoder().encode('hello');
    }, filename);
    await page.route('**/api/upload*', route => { uploads++; return route.fulfill({ json: artifact }); });
    await page.route('**/api/collaboration/turns', async route => {
      const body = route.request().postDataJSON();
      posts.push(body);
      if (posts.length === 1) return route.fulfill({ status: 404, json: { error: 'Turn unavailable' } });
      await release.promise;
      gateway.transcriptRows = [...messages, { id: 'received-retry', run_id: body.request_id, session_id: sessionId,
        ordinal: messages.length + 1, role: 'user', text: body.message, attachments: body.attachments,
        author: { kind: 'user' }, status: 'complete', created_at: new Date().toISOString() }];
      return route.fulfill({ json: { session_id: sessionId, request_id: body.request_id, response: 'Received' } });
    });
    await expect(page.getByText(conclusion, { exact: true })).toBeVisible();
    await page.getByLabel('Attach files', { exact: true }).click();
    await page.locator('textarea').last().fill(prompt);
    await page.getByLabel('Send message', { exact: true }).click();
    await expect(row.getByText('Not sent', { exact: true })).toBeVisible();
    await expect(retry).toBeVisible();
    await expect(row.getByLabel('Download ' + filename)).toBeVisible();
    await page.getByRole('button', { name: 'New session', exact: true }).first().click();
    await expect(row).toHaveCount(0);
    await page.getByText('Synthetic transcript', { exact: true }).first().click();
    await expect(retry).toBeVisible();
    await page.evaluate(() => sessionStorage.setItem('fixture-account', 'different-test-account'));
    await page.reload();
    await expect(page.getByText(conclusion, { exact: true })).toBeVisible();
    await expect(row).toHaveCount(0);
    await page.evaluate(() => sessionStorage.removeItem('fixture-account'));
    await page.reload();
    await expect(retry).toBeVisible();
    await retry.evaluate(button => { button.click(); button.click(); });
    await expect(row.getByText('Sending…', { exact: true })).toBeVisible();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[1].attachments[0].artifact_id).toBe(artifact.artifact_id);
    release.resolve();
    await expect.poll(() => gateway.messagePages.some(page => page.rows.some(row => row.id === 'received-retry'))).toBe(true);
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Sending…')).toHaveCount(0);
    await expect(row.getByLabel('Download ' + filename)).toBeVisible();
    await page.reload();
    await expect(row).toHaveCount(1);
    await expect(retry).toHaveCount(0);
    expect([posts.length, uploads]).toEqual([2, 1]);
  } finally { release.resolve(); await gateway.close(); }
});

test('checks uncertain delivery by exact receipt and forgets dismissed input on reload', async ({ page }) => {
  const { gateway } = await openTranscript(page, { sharedDelivery: true });
  const prompt = 'Check my existing receipt';
  const row = page.getByTestId('oa-user-message').filter({ hasText: prompt });
  const posts = [], reads = [];
  let matching = false;
  try {
    await page.route('**/api/collaboration/turns', route => {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ status: 504, json: { error: 'Response lost' } });
    });
    await page.route('**/api/runtime/runs/*', route => {
      const requestId = new URL(route.request().url()).pathname.split('/').at(-1);
      reads.push([route.request().method(), requestId]);
      return route.fulfill({ json: { run_id: requestId, session_id: matching ? sessionId : 'other-chat',
        status: 'success', output: 'Received' } });
    });
    await expect(page.getByText(conclusion, { exact: true })).toBeVisible();
    await page.locator('textarea').last().fill(prompt);
    await page.getByLabel('Send message', { exact: true }).click();
    await expect(row.getByText('Delivery unconfirmed', { exact: true })).toBeVisible();
    await expect(row.getByLabel('Retry send')).toHaveCount(0);
    const id = posts[0].request_id;
    expect(reads).toEqual([['GET', id]]);
    await page.reload();
    const check = row.getByRole('button', { name: 'Check delivery' });
    await expect(check).toBeVisible();
    await check.click();
    await expect(check).toBeVisible();
    matching = true;
    gateway.transcriptRows = [...messages, { id: 'canonical-uncertain', ordinal: messages.length + 1, session_id: sessionId,
      run_id: id, role: 'user', text: prompt, author: { kind: 'user' }, status: 'complete', created_at: new Date().toISOString() }];
    await check.click();
    await expect(check).toHaveCount(0);
    await expect(row).toHaveCount(1);
    expect(reads).toEqual([['GET', id], ['GET', id], ['GET', id]]);
    expect(posts).toHaveLength(1);

    const second = 'Dismiss this refusal';
    const refused = page.getByTestId('oa-user-message').filter({ hasText: second });
    await page.route('**/api/collaboration/turns', route => route.fulfill({ status: 404, json: { error: 'Refused' } }));
    await page.locator('textarea').last().fill(second);
    await page.getByLabel('Send message', { exact: true }).click();
    await refused.getByLabel('Dismiss delivery notice').click();
    await expect(refused).toHaveCount(0);
    await page.reload();
    await expect(row).toHaveCount(1);
    await expect(refused).toHaveCount(0);
  } finally { await gateway.close(); }
});

test('keeps a failed or pending attachment with its original chat draft', async ({ page }) => {
  const { gateway } = await openTranscript(page);
  const resume = Promise.withResolvers();
  const uploads = [];
  const file = 'draft-sample.txt';
  const activeSession = () => new URL(page.url()).searchParams.get('session');
  const composer = page.locator('textarea').last();
  const send = page.getByLabel('Send message', { exact: true });
  const firstChat = page.getByText('Synthetic transcript', { exact: true }).first();
  const newChat = page.getByRole('button', { name: 'New session', exact: true }).first();
  try {
    await page.evaluate(file => {
      window.desktop.pickFiles = async () => [{ path: '/fixture/' + file, filename: file, kind: 'file', size: 5, maxBytes: 1024 }];
      window.desktop.readFile = async () => new TextEncoder().encode('hello');
    }, file);
    await page.route('**/api/upload*', async route => {
      uploads.push(new URL(route.request().url()).searchParams.get('session_id'));
      if (uploads.length === 1) return route.fulfill({ status: 503, json: { error: 'Paused fixture upload' } });
      await resume.promise;
      return route.fulfill({ json: { artifact_id: 'fixture-artifact', filename: file, kind: 'file', size_bytes: 5 } });
    });
    await expect(page.getByText(conclusion, { exact: true })).toBeVisible();
    await composer.fill('First chat draft');
    await page.getByLabel('Attach files', { exact: true }).click();
    const retry = page.getByLabel('Retry upload', { exact: true });
    await expect(retry).toBeVisible();
    await newChat.click();
    await expect.poll(activeSession).not.toBe(sessionId);
    await composer.fill('Independent note');
    await expect(retry).toHaveCount(0);
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(() => gateway.chatFrames.some(frame => frame.text === 'Independent note' &&
      frame.session_id === activeSession() && !frame.attachments?.length)).toBe(true);

    await firstChat.click();
    await expect.poll(activeSession).toBe(sessionId);
    await expect(composer).toHaveValue('First chat draft');
    await expect(retry).toBeVisible();
    await retry.click();
    await expect.poll(() => uploads.length).toBe(2);
    await newChat.click();
    await expect.poll(activeSession).not.toBe(sessionId);
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/upload' && response.status() === 200);
    resume.resolve();
    await (await delivered).finished();
    await expect(page.getByText(file, { exact: true })).toHaveCount(0);
    await firstChat.click();
    await expect.poll(activeSession).toBe(sessionId);
    await expect(page.getByText(file, { exact: true })).toBeVisible();
    expect(uploads).toEqual([sessionId, sessionId]);
    await newChat.click();
    await expect.poll(activeSession).not.toBe(sessionId);
    await expect(page.getByText(file, { exact: true })).toHaveCount(0);
    await firstChat.click();
    await expect(page.getByText(file, { exact: true })).toBeVisible();
    await page.getByLabel('Remove ' + file, { exact: true }).click();
    await expect(page.getByText(file, { exact: true })).toHaveCount(0);
  } finally {
    resume.resolve();
    await gateway.close();
  }
});

test('completed transcript keeps live text and tools in order after opening and reconnecting', async ({ page }) => {
  const { gateway, errors } = await openTranscript(page);
  const order = latestTurnOrder(page);
  try {
    await expect(order[1]).toBeVisible();
    await expectOrder(...order);
    expect(gateway.messagePages[0].interleaved).toBe(true);
    await page.getByTestId('oa-assistant-message').filter({ hasText: conclusion })
      .getByLabel('Copy message', { exact: true }).click();
    expect(await page.evaluate(() => window.fixtureCopiedText)).toBe(fullAnswer);

    await reconnect(gateway);
    await expectOrder(...order);
    await page.reload();
    await expectOrder(...order);
    expect(errors).toEqual([]);
  } finally {
    await gateway.close();
  }
});

for (const pausedRequest of ['latest page', 'discovery']) {
  test(`a middle result stays in view with delayed ${pausedRequest} and can jump to the latest answer`, async ({ page }) => {
    const anchor = 'fixture-tool-2-95';
    const { gateway, errors } = await openTranscript(page, { anchor, pausedRequest });
    try {
      const result = page.getByTestId(`tool-invocation-${anchor}`);
      const latest = page.getByText(conclusion, { exact: true });
      const jump = page.getByLabel('Jump to bottom', { exact: true });
      await expect(result).toBeInViewport();
      await expect(latest).toHaveCount(0);
      await expect(jump).toBeVisible();
      const tailReceived = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === `/api/sessions/${sessionId}/messages` && !url.searchParams.has('around');
      });
      gateway.resume.resolve();
      await (await tailReceived).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(result).toBeInViewport();
      await expect(latest).toHaveCount(0);
      await jump.click();
      await expect(latest).toBeInViewport();
      await expect(result).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      gateway.resume.resolve();
      await gateway.close();
    }
  });
}

test('Jump to bottom retries a failed latest page from a search result', async ({ page }) => {
  const anchor = 'fixture-tool-2-95';
  const { gateway, errors } = await openTranscript(page, { anchor, pausedRequest: 'latest page' });
  try {
    await expect(page.getByTestId(`tool-invocation-${anchor}`)).toBeInViewport();
    gateway.failLatest = true;
    gateway.resume.resolve();
    await expect.poll(() => gateway.messagePages.some(entry => !entry.around && entry.failed)).toBe(true);
    await page.getByLabel('Jump to bottom', { exact: true }).click();
    await expect(page.getByText(conclusion, { exact: true })).toBeInViewport();
    expect(gateway.messagePages.filter(entry => !entry.around).map(entry => entry.failed)).toEqual([true, false]);
    expect(errors).toEqual([]);
  } finally {
    gateway.resume.resolve();
    await gateway.close();
  }
});

test('intermediate tool-only pages preserve their text and retry a failed fetch', async ({ page }) => {
  const anchor = 'fixture-tool-2-95';
  const { gateway, errors } = await openTranscript(page, { anchor });
  try {
    for (const [index, text] of checkpoints) {
      const target = `fixture-tool-2-${index}`;
      if (target !== anchor) await page.goto(`${gateway.baseUrl}/chat?session=${sessionId}&message=${target}`);
      await expectOrder(page.getByText(text, { exact: true }), page.getByTestId(`tool-invocation-${target}`));
      const anchored = gateway.messagePages.find(entry => entry.around === target);
      expect(anchored.interleaved).toBe(true);
      expect(new Set(anchored.rows.map(row => row.role))).toEqual(new Set(['tool']));
    }

    await page.goto(`${gateway.baseUrl}/chat?session=${sessionId}`);
    await expect(page.getByText(conclusion, { exact: true })).toBeVisible();
    const earlier = page.getByLabel('Load earlier messages', { exact: true });
    gateway.failBefore = true;
    await earlier.click();
    const retry = page.getByLabel('Retry loading earlier messages', { exact: true });
    await expect(retry).toBeVisible();
    const failed = gateway.messagePages.find(entry => entry.failed);
    expect(new Set(failed.rows.map(row => row.role))).toEqual(new Set(['tool']));
    await retry.click();
    await expect.poll(() => gateway.messagePages.filter(entry =>
      entry.around === failed.around && !entry.failed && entry.interleaved).length).toBe(1);
    await expect(retry).toHaveCount(0);
    // Follow stable message anchors to cover the whole transcript. Automatic
    // scroll pagination can load extra pages before the explicit control acts.
    for (const index of [30, 91, 152, 0]) {
      const target = messages[index].id;
      await page.goto(`${gateway.baseUrl}/chat?session=${sessionId}&message=${target}`);
      await expect.poll(() => gateway.messagePages.some(entry => entry.around === target && !entry.failed)).toBe(true);
      await expect(page.locator(`[id="message-anchor-${target}"]`)).toBeVisible();
    }
    await expect(page.getByText('Synthetic prompt 0', { exact: true })).toBeVisible();
    const delivered = gateway.messagePages.filter(page => page.interleaved && !page.failed);
    expect(new Set(delivered.flatMap(page => page.rows.map(row => row.id))).size).toBe(246);
    expect(errors).toEqual([]);
  } finally {
    await gateway.close();
  }
});

test('replays an active turn after disconnect and renders the completed answer once', async ({ page }) => {
  const { gateway, errors } = await openTranscript(page, { live: true });
  const order = latestTurnOrder(page);
  const send = frame => gateway.sendChatFrame({ session_id: sessionId, ...frame });
  const latest = messages.filter(row => row.run_id === 'fixture-run-8');
  const [prompt, ...tools] = latest.slice(0, -1);
  const frames = [{ type: 'text_final', text: prompt.text }];
  for (const tool of tools) {
    if (tool.transcript_segment) frames.push({ type: 'delta', text: tool.transcript_segment.text + '\n\n' });
    frames.push({ type: 'status', text: JSON.stringify({ tool_name: tool.tool_summary.tool_name,
      tool_call_id: tool.id, tool_invocation_id: tool.id, result: 'Completed' }) });
  }
  frames.push({ type: 'delta', text: conclusion });
  try {
    await expect(page.getByText('Synthetic answer 7', { exact: true })).toBeVisible();
    frames.slice(0, 3).forEach(send);
    await expectOrder(...order.slice(0, 2));
    await reconnect(gateway);
    send({ type: 'live_state', active: true, frames });
    await expectOrder(...order);
    send({ type: 'response', text: fullAnswer, parts: [textPart(fullAnswer)] });
    await expect(page.getByTestId('oa-assistant-message').filter({ hasText: conclusion })
      .getByLabel('Copy message', { exact: true })).toBeVisible();
    await expectOrder(...order);

    const previousPages = gateway.messagePages.length;
    gateway.transcriptRows = messages;
    send({ type: 'turn_complete', reason: 'completed' });
    await expect.poll(() => gateway.messagePages.length).toBeGreaterThan(previousPages);
    await expectOrder(...order);
    await expect(page.getByText(prompt.text, { exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await gateway.close();
  }
});
