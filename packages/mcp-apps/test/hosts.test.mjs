import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

function load(value, runtime) {
  return spawnSync(process.execPath, ['--input-type=module','-e',
    `const {externalHosts,runtimeHost}=await import(${JSON.stringify(new URL('./hosts.mjs',import.meta.url).href)});console.log(JSON.stringify([externalHosts,runtimeHost()]));`],
    {encoding:'utf8',env:{...process.env,OPENAGENT_TEST_HOSTS:JSON.stringify(value),OPENAGENT_TEST_RUNTIME_HOST:JSON.stringify(runtime)}});
}
test('acceptance targets are explicit neutral host configuration', () => {
  const host={name:'sample-host',root:'/owned/example',universalRoot:'/owned/example/ui',bridge:'exampleBridge'};
  const runtime={identityModule:'sample_host.identity',actorHeader:'X-Sample-Actor',actorTokenPrefix:'sample_actor_'};
  const result=load([host],runtime);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),[[host],runtime]);
});
test('invalid or incomplete acceptance targets fail instead of silently disappearing', () => {
  assert.notEqual(load([{name:'standalone',root:'/owned'}],null).status,0);
  assert.notEqual(load([{name:'example',root:'relative'}],null).status,0);
  assert.notEqual(load([], {identityModule:'sample.identity'}).status,0);
});
