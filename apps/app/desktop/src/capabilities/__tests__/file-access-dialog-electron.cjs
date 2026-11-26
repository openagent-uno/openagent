const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { app, BaseWindow, dialog } = require('electron');
const { offerFileAccess } = require('../../../dist/capabilities/file-access.js');
const { createFileAccessPicker } = require('../../../dist/capabilities/file-access-dialog.js');

const profile = mkdtempSync(join(tmpdir(), 'openagent-picker-retry-'));
const path = join(profile, 'fixture.txt');
writeFileSync(path, 'Picker retry fixture');
app.setPath('userData', profile);
app.setActivationPolicy('prohibited');
app.on('window-all-closed', () => {});
process.once('exit', () => rmSync(profile, { recursive: true, force: true }));

async function verify() {
  const owners = new Map(['first', 'second'].map(account => [
    account, new BaseWindow({ show: false, frame: false, x: -4000, y: 100, width: 400, height: 120 }),
  ]));
  const picker = createFileAccessPicker(accountId => ({
    window: owners.get(accountId), agentHandle: accountId, current: () => true,
  }));
  const sheets = [Promise.withResolvers(), Promise.withResolvers()];
  const firstNativeEnded = Promise.withResolvers();
  const lateResult = Promise.withResolvers();
  const showOpenDialog = dialog.showOpenDialog.bind(dialog);
  const panels = [];

  dialog.showMessageBox = async () => ({ response: 0 });
  dialog.showOpenDialog = async (panel, options) => {
    const index = panels.length;
    panels.push(panel);
    assert.equal(panel.getParentWindow(), owners.get(index === 0 ? 'first' : 'second'));
    panel.once('sheet-begin', sheets[index].resolve);
    const result = await showOpenDialog(panel, options);
    if (index !== 0) return result;
    firstNativeEnded.resolve();
    await lateResult.promise;
    return { canceled: false, filePaths: [path] };
  };
  const request = accountId => ({ accountId, path, directory: false });
  const signal = new AbortController().signal;
  try {
    let firstSelection;
    const first = offerFileAccess((request, signal) => (firstSelection = picker(request, signal)),
      request('first'), { tool: 'read_text_file', args: { path } }, signal, () => true, { timeoutMs: 2500 });
    const timedOut = assert.rejects(first, { code: 'file_permission_timeout' });
    await sheets[0].promise;
    await assert.rejects(picker(request('second'), signal), { code: 'file_permission_unavailable' });
    await timedOut;
    assert(panels[0].isDestroyed());
    assert(!owners.get('first').isDestroyed());
    await firstNativeEnded.promise;

    const retry = new AbortController();
    const secondSelection = picker(request('second'), retry.signal);
    await sheets[1].promise;
    assert(!panels[1].isEnabled(), 'The new owner must have its native selection sheet attached');
    lateResult.resolve();
    assert.equal(await firstSelection, null, 'The expired selection must be ignored');
    await assert.rejects(picker(request('first'), signal), { code: 'file_permission_unavailable' });
    assert(!panels[1].isDestroyed(), 'A late completion must not release the new account’s picker');
    retry.abort();
    assert.equal(await secondSelection, null);
    assert(panels[1].isDestroyed());
    assert(!owners.get('second').isDestroyed());
  } finally {
    for (const owner of owners.values()) owner.destroy();
  }
}

const deadline = setTimeout(() => { console.error('Native picker retry timed out'); app.exit(1); }, 15000);
app.whenReady().then(verify).then(() => {
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
