import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  stdin: { contents: `export { useTasks } from './universal/stores/tasks';`, resolveDir: root },
  nodePaths: [root + '/universal/node_modules', root + '/desktop/node_modules'],
  plugins: [{ name: 'api-fixture', setup(api) {
    api.onResolve({ filter: /^\.\.\/services\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    api.onLoad({ filter: /^api$/, namespace: 'fixture' }, () => ({ contents: `
      export class ApiError extends Error {}
      export const currentAgentScope = () => 1;
      export const getScheduledTaskList = async () => ({ tasks: globalThis.__serverTasks.map((t) => ({ ...t })) });
      export const updateScheduledTask = async (id, input) => globalThis.__update(id, input);
      export const createScheduledTask = async () => ({});
      export const deleteScheduledTask = async () => {};
      export const runScheduledTask = async () => ({});
      export const stopScheduledTask = async () => ({});
    ` }));
  } }],
});
const { useTasks } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('toggling a task shows the state the server stored, not the stale update response', async () => {
  globalThis.__serverTasks = [{ id: 't1', name: 'Daily', enabled: true }];
  // The server stores the change but answers with the previous row.
  globalThis.__update = async (id, input) => {
    const before = { ...globalThis.__serverTasks[0] };
    globalThis.__serverTasks[0].enabled = input.enabled;
    return before;
  };
  await useTasks.getState().loadTasks();
  assert.equal(useTasks.getState().tasks[0].enabled, true);
  await useTasks.getState().toggleTask('t1', false);
  assert.equal(useTasks.getState().tasks[0].enabled, false);
});

test('a refused enable leaves the switch off', async () => {
  globalThis.__serverTasks = [{ id: 't1', name: 'Daily', enabled: false }];
  globalThis.__update = async () => { throw new Error('Automation revision is not authorized'); };
  await useTasks.getState().loadTasks();
  await useTasks.getState().toggleTask('t1', true);
  assert.equal(useTasks.getState().tasks[0].enabled, false);
});
