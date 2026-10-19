// Render the unchanged App22 AttachmentBlock, not a substitute UI or source regex.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

function load(platform) {
  const h = (type, props, ...children) => typeof type === 'function'
    ? type({ ...props, children: children.length ? children : props?.children })
    : { type, props: { ...props, children: children.length ? children : props?.children } };
  const react = { createElement: h, useEffect: () => {}, useState: (value) => [value, () => {}] };
  function Image(props) { return h('Image', props); }
  Image.getSize = () => {};
  const native = Object.fromEntries(['View', 'Text', 'TouchableOpacity', 'Modal', 'Pressable', 'ActivityIndicator', 'ScrollView'].map((name) => [name, name]));
  Object.assign(native, { Image, Platform: { OS: platform }, StyleSheet: { create: (x) => x, absoluteFillObject: {} }, useWindowDimensions: () => ({ width: 1024, height: 768 }) });
  const modules = {
    react, 'react/jsx-runtime': { jsx: (t, p) => h(t, p), jsxs: (t, p) => h(t, p) },
    'react-native': native, '@expo/vector-icons/Feather': () => null,
    '../../common/attachments': { attachmentKey: (a) => a.artifact_id },
    '../services/api': { attachmentUrl: (a) => `/api/artifacts/${a.artifact_id}/content`, downloadAttachment: async () => {} },
    '../theme': { colors: {}, font: {}, radius: {} }, './Markdown': { CodeBlock: () => null },
  };
  const source = fs.readFileSync(path.join(__dirname, '../Attachments.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => { assert.ok(name in modules, `Unmocked import ${name}`); return modules[name]; } });
  return module.exports.default;
}
function nodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
const refs = [
  { type: 'file', filename: 'picture.png', mime_type: 'image/png', artifact_id: 'img' },
  { type: 'file', filename: 'clip.mp4', mime_type: 'video/mp4', artifact_id: 'video' },
  { type: 'file', filename: 'voice.wav', mime_type: 'audio/wav', artifact_id: 'audio' },
  { type: 'file', filename: 'report.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', artifact_id: 'sheet' },
];

test('App22 user/assistant shared block renders inline image/video/audio and file card before Expand', () => {
  const tree = nodes(load('web')({ attachments: refs }));
  assert.ok(tree.some((n) => n.type === 'Image' && n.props.source.uri === '/api/artifacts/img/content'));
  for (const [type, id] of [['video', 'video'], ['audio', 'audio']]) {
    const player = tree.find((n) => n.type === type);
    assert.equal(player.props.src, `/api/artifacts/${id}/content`);
    assert.equal(player.props.controls, true);
    assert.equal(player.props.preload, 'metadata');
  }
  assert.ok(tree.some((n) => n.props?.accessibilityLabel === 'Preview report.xlsx'));
  assert.ok(tree.some((n) => n.props?.accessibilityLabel === 'Download report.xlsx'));
  assert.equal(tree.some((n) => n.type === 'Modal'), false, 'inline media must not require opening preview');
});

test('App22 native fallback retains inline image and visible video/audio file cards', () => {
  const tree = nodes(load('ios')({ attachments: refs }));
  assert.ok(tree.some((n) => n.type === 'Image'));
  assert.equal(tree.some((n) => n.type === 'video' || n.type === 'audio'), false);
  for (const filename of ['clip.mp4', 'voice.wav', 'report.xlsx']) assert.ok(tree.some((n) => n.props?.accessibilityLabel === `Preview ${filename}`));
});
