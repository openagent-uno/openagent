import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

// Run the real screen with a deterministic hook scheduler. Effects commit only
// when requested, so the render between an account switch and hydration is
// observable without a browser, device or a React renderer implementation.
const root = fileURLToPath(new URL('../..', import.meta.url));
const entry = resolve(root, 'universal/app/(tabs)/settings.tsx');
const fixtures = {
  react: `const h = () => globalThis.__settingsLifecycle;
    export const useState = value => h().useState(value);
    export const useRef = value => h().useRef(value);
    export const useEffect = (effect, deps) => h().useEffect(effect, deps);
    export const useCallback = callback => callback;`,
  'react/jsx-runtime': `export const jsx = (type, props) => ({type, props}); export const jsxs = jsx; export const Fragment = 'Fragment';`,
  'react-native': `export const View='View', Text='Text', TextInput='TextInput', TouchableOpacity='TouchableOpacity', ScrollView='ScrollView';
    export const StyleSheet={create:styles=>styles,hairlineWidth:1}; export const Platform={OS:'ios'};`,
  'expo-router': `export const useRouter=()=>({replace(){}});`,
  '../../stores/connection': `export function useConnection(selector) { const value=globalThis.__settingsLifecycle.connection; return selector?selector(value):value; }
    useConnection.getState=()=>globalThis.__settingsLifecycle.connection;`,
  '../../stores/config': `export function useConfig(selector) { const value=globalThis.__settingsLifecycle.config; return selector?selector(value):value; }
    useConfig.getState=()=>globalThis.__settingsLifecycle.config;`,
  '../../stores/voice': `export const VOICE_DEFAULTS={}, VOICE_LANGUAGES=[];
    export const useVoiceConfig=selector=>selector({config:{},setConfig(){},reset(){}});`,
  '../../stores/theme': `export const useTheme=selector=>selector({mode:'system',setMode(){}});`,
  '../../services/api': `export const currentAgentScope=()=>globalThis.__settingsLifecycle.scope;
    export const triggerUpdate=async()=>{},triggerRestart=async()=>{};`,
  '../../services/agent-thumbnail': `export const pickAgentThumbnail=()=>globalThis.__settingsLifecycle.pickThumbnail();`,
  '../../components/AgentAvatar': `export const AgentAvatar='AgentAvatar';`,
  '../../components/ConfirmDialog': `export const useConfirm=()=>async()=>false;`,
  '../../components/screenHeader': `export const useHeaderInset=()=>0;`,
  '../../theme': `export const colors={},font={},radius={};`,
};
const bundle = await build({
  absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
  platform: 'node', format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'screen-lifecycle-boundaries', setup(api) {
    api.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return { path: args.path };
      if (args.path.endsWith('/common/settings-draft-policy')) return { path: resolve(args.resolveDir, args.path + '.ts') };
      return { path: args.path, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path]
      ?? `export default ${JSON.stringify(args.path.split('/').at(-1))};` }));
  } }],
});
const { default: SettingsScreen } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

function setup(t) {
  const slots = [];
  let cursor = 0, effects = [];
  const harness = {
    scope: 1,
    needsRender: false,
    connection: { activeAccountId: 'a', config: {}, accounts: [{id:'a'}, {id:'b'}] },
    config: { config: { name:'Agent A', system_prompt:'Prompt A', channels:{telegram:{token:'Fixture A'}} },
      sourceScope:1, channelPresentation:{}, thumbnail:'Thumbnail A', loadConfig:async()=>{},
      updateSection:async()=>true, updateIdentity:async()=>null },
    pickThumbnail: async () => null,
    useState(initial) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], value => {
        const next = typeof value === 'function' ? value(slots[slot]) : value;
        if(!Object.is(next,slots[slot]))harness.needsRender=true;
        slots[slot]=next;
      }];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useEffect(effect, deps) {
      const slot = cursor++;
      const previous = slots[slot];
      if (!previous || !deps || deps.some((value,index)=>!Object.is(value,previous.deps?.[index]))) {
        effects.push(() => { previous?.cleanup?.(); slots[slot]={deps,cleanup:effect()}; });
      }
    },
    render() { cursor=0;effects=[];harness.needsRender=false;return SettingsScreen(); },
    commit() { const pending=effects;effects=[];for(const effect of pending)effect(); },
    switchAccount({ resetConfig=true }={}) {
      harness.scope=2;
      harness.connection={...harness.connection,activeAccountId:'b',config:{}};
      if(resetConfig)harness.config={...harness.config,config:null,sourceScope:null,thumbnail:undefined};
    },
    resolveAccountB() {
      harness.config={...harness.config,sourceScope:2,config:{name:'Agent B',system_prompt:'Prompt B',channels:{telegram:{token:'Fixture B'}}},thumbnail:'Thumbnail B'};
    },
  };
  globalThis.__settingsLifecycle=harness;
  t.after(()=>{for(const slot of slots)slot?.cleanup?.();delete globalThis.__settingsLifecycle;});
  harness.render();harness.commit();
  return harness;
}
function nodes(tree, predicate) {
  if(!tree||typeof tree!=='object')return [];
  if(Array.isArray(tree))return tree.flatMap(child=>nodes(child,predicate));
  return [...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];
}
const inputs=tree=>nodes(tree,node=>node.type==='TextInput');
const shows= (tree,value)=>nodes(tree,node=>node.props?.value===value||node.props?.name===value).length>0;

test('the first account-B render cannot show account-A fields before effects run',t=>{
  const h=setup(t);
  let tree=h.render();
  assert.ok(shows(tree,'Agent A'));
  inputs(tree)[0].props.onChangeText('Unsaved A');
  tree=h.render();assert.ok(shows(tree,'Unsaved A'));
  h.switchAccount();
  tree=h.render();
  t.diagnostic(JSON.stringify({phase:'before-B-effects',oldDraftVisible:shows(tree,'Unsaved A')}));
  assert.equal(shows(tree,'Unsaved A'),false);
  assert.equal(shows(tree,'Prompt A'),false);
  assert.equal(shows(tree,'Thumbnail A'),false);
  h.commit();tree=h.render();
  assert.equal(shows(tree,'Agent A'),false);
  h.resolveAccountB();h.render();h.commit();tree=h.render();
  assert.ok(shows(tree,'Agent B'));
  assert.ok(shows(tree,'Prompt B'));
});

test('a stale config source cannot seed the new account baseline while its GET is pending',t=>{
  const h=setup(t);
  h.switchAccount({resetConfig:false});
  let tree=h.render();h.commit();tree=h.render();
  assert.equal(shows(tree,'Agent A'),false);
  assert.equal(shows(tree,'Prompt A'),false);
  assert.equal(shows(tree,'Thumbnail A'),false);
  h.resolveAccountB();h.render();h.commit();tree=h.render();
  assert.ok(shows(tree,'Agent B'));
});

test('same-scope refresh keeps local identity typing and refreshes untouched fields',t=>{
  const h=setup(t);
  let tree=h.render();
  inputs(tree)[0].props.onChangeText('Local name');
  h.render();
  h.config={...h.config,config:{...h.config.config,name:'Remote name',system_prompt:'Remote prompt'}};
  h.render();h.commit();tree=h.render();
  assert.ok(shows(tree,'Local name'));
  assert.ok(shows(tree,'Remote prompt'));
});

test('channel token inputs never show the previous account during selection or loading',t=>{
  const h=setup(t);
  let tree=h.render();
  nodes(tree,node=>node.type==='SectionTabs')[0].props.onChange('channels');
  tree=h.render();assert.ok(shows(tree,'Fixture A'));
  h.switchAccount({resetConfig:false});
  tree=h.render();assert.equal(shows(tree,'Fixture A'),false);
  h.commit();tree=h.render();assert.equal(shows(tree,'Fixture A'),false);
  h.resolveAccountB();h.render();h.commit();tree=h.render();
  assert.ok(shows(tree,'Fixture B'));
  assert.equal(shows(tree,'Fixture A'),false);
});

test('pending account-B settings hide previous load errors and expose a scoped retry on failure',t=>{
  const h=setup(t);
  h.config={...h.config,error:'Previous account load error'};
  h.switchAccount({resetConfig:false});
  let tree=h.render();
  assert.equal(nodes(tree,node=>node.props?.children==='Previous account load error').length,0);
  h.commit();
  h.config={...h.config,sourceScope:2,config:null,error:'Current account load error'};
  tree=h.render();
  assert.equal(nodes(tree,node=>node.props?.children==='Current account load error').length,1);
  assert.equal(nodes(tree,node=>node.props?.label==='Retry loading settings').length,1);
});

test('identical field values in two accounts still schedule the hydration completion render',t=>{
  const h=setup(t);
  h.render();
  const sameValues={...h.config.config};
  h.switchAccount({resetConfig:false});
  h.config={...h.config,sourceScope:2,config:sameValues};
  let tree=h.render();
  assert.equal(inputs(tree).length,0);
  h.commit();
  assert.equal(h.needsRender,true);
  tree=h.render();
  assert.ok(inputs(tree).length>0);
});
