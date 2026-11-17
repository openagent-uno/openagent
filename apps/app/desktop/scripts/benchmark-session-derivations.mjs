#!/usr/bin/env node
/**
 * CPU-only baseline of the actual source-derived memo callbacks. No app,
 * network, React renderer or device. This cannot establish end-to-end speed.
 *
 * From repository root:
 * node apps/app/desktop/scripts/benchmark-session-derivations.mjs --output=/tmp/sessions-before.json
 * node apps/app/desktop/scripts/benchmark-session-derivations.mjs --ci
 *
 * Extracts the owning components' current useMemo statements with TypeScript
 * AST, retaining their dependency expressions. A tiny memo runtime models
 * Object.is dependency checks, then runs fresh runners over identical frames.
 * Compilation, fixture generation and validation are outside the timing.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';

const root = new URL('../../', import.meta.url);
const files = {
  rail: new URL('universal/components/transcript/TurnRail.tsx', root),
  messages: new URL('universal/components/MessageList.tsx', root),
  turns: new URL('universal/stores/sessionTurns.ts', root),
  placement: new URL('common/shared-transcript.ts', root),
  rail_merge: new URL('common/turn-rail.ts', root),
  cached_placement: new URL('common/shared-tool-placement.ts', root),
};
const source = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, 'utf8')])));
const hash = value => createHash('sha256').update(value).digest('hex');
let ci = false, profileSlots = false, output;
for (const arg of process.argv.slice(2)) {
  if (arg === '--ci') ci = true;
  else if (arg === '--profile-slots') profileSlots = true;
  else if (arg.startsWith('--output=')) output = arg.slice(9);
  else throw new Error(`Unknown argument: ${arg}`);
}
const frames = ci ? 12 : 120;
const runs = ci ? 1 : 3;
const parse = (text, name) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const railFile = parse(source.rail, 'TurnRail.tsx');
const messageFile = parse(source.messages, 'MessageList.tsx');

function namedFunction(file, name) {
  const found = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!found?.body) throw new Error(`Cannot find function ${name}; update the source extractor`);
  return found;
}

function bindingHas(name, key) {
  return ts.isIdentifier(name) ? name.text === key : name.elements.some(element => ts.isBindingElement(element) && bindingHas(element.name, key));
}

function statement(file, statements, key, memo = false) {
  const found = statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => bindingHas(declaration.name, key)));
  if (!found) throw new Error(`Cannot find declaration ${key}; update the source extractor`);
  if (memo && !found.declarationList.declarations.some(declaration => ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(file) === 'useMemo')) {
    throw new Error(`${key} is no longer useMemo; update the source extractor`);
  }
  return found.getText(file);
}

const railBody = namedFunction(railFile, 'TurnRail').body.statements;
const messageBody = namedFunction(messageFile, 'MessageListBase').body.statements;
const railSetups = ['indexedTurns', 'mergeTurns'].filter(key => railBody.some(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => bindingHas(declaration.name, key))));
const railMemoKeys = ['recent', ...railSetups, 'turns', 'layout', 'activeIndex', 'markers'];
const messageSetups = ['placeTools'].filter(key => messageBody.some(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => bindingHas(declaration.name, key))));
const messageMemoKeys = [...messageSetups, 'messages', 'canonical', 'singleUserRuns', 'assistantActions'];
const sharedImport = JSON.stringify(fileURLToPath(files.placement));
const compiled = await build({
  stdin: {
    sourcefile: 'session-derivations-benchmark.ts', loader: 'ts', resolveDir: fileURLToPath(root),
    contents: `
import { placeSharedTools } from ${sharedImport};
import { createTurnRailMerge } from ${JSON.stringify(fileURLToPath(files.rail_merge))};
import { createSharedToolPlacement } from ${JSON.stringify(fileURLToPath(files.cached_placement))};
${statement(railFile, railFile.statements, 'SPACING')}
${statement(railFile, railFile.statements, 'MIN_SPACING')}
${namedFunction(railFile, 'fromIndex').getText(railFile)}
${statement(railFile, railFile.statements, 'isHumanPrompt')}
${railFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'fromMessage')?.getText(railFile) ?? ''}
function memoRuntime() {
  const slots = []; let cursor = 0; let computed = []; let hits = []; const compute_ms = [];
  return {
    begin() { cursor = 0; },
    stats() { return { computed, hits, compute_ms: ${profileSlots} ? compute_ms : undefined }; },
    useMemo(factory, deps) {
      const i = cursor++; const slot = slots[i];
      if (slot && deps.length === slot.deps.length && deps.every((value, j) => Object.is(value, slot.deps[j]))) {
        hits[i] = (hits[i] || 0) + 1; return slot.value;
      }
      computed[i] = (computed[i] || 0) + 1;
      const start = ${profileSlots} ? performance.now() : 0;
      const value = factory();
      if (${profileSlots}) compute_ms[i] = (compute_ms[i] || 0) + performance.now() - start;
      slots[i] = { value, deps }; return value;
    }
  };
}
export function railRunner() {
  const runtime = memoRuntime(); const { useMemo } = runtime;
  return { stats: runtime.stats, run(index, messages, height, currentUserHandle, activeId, sessionId = 'fixture-session') {
    runtime.begin();
    ${['indexed', 'lastOrdinal', 'unsupported'].map(key => statement(railFile, railBody, key)).join('\n')}
    ${['recent', ...railSetups, 'turns'].map(key => statement(railFile, railBody, key, true)).join('\n')}
    ${statement(railFile, railBody, 'count')}
    ${['layout', 'activeIndex', 'markers'].map(key => statement(railFile, railBody, key, true)).join('\n')}
    return { turns, markers, activeIndex, newestCanonical };
  }};
}
export function messageRunner() {
  const runtime = memoRuntime(); const { useMemo } = runtime;
  return { stats: runtime.stats, run(transcript, appSessionId = 'fixture-session', accountId = 'fixture-account') {
    runtime.begin();
    ${messageMemoKeys.map(key => statement(messageFile, messageBody, key, true)).join('\n')}
    return { messages, canonical, singleUserRuns, assistantActions, turnForks };
  }};
}
`,
  }, bundle: true, write: false, platform: 'node', format: 'esm',
});
const { railRunner, messageRunner } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function transcript(count) {
  const result = [];
  for (let i = 0; i < count - 1; i++) {
    const role = ['user', 'assistant', 'tool'][i % 3];
    result.push({
      id: `message-${i}`, role, ordinal: i, providerRunId: `run-${Math.floor(i / 3)}`,
      text: role === 'tool' ? '' : `${role} text ${i}. `.repeat(role === 'assistant' ? 20 : 3),
      author: { kind: role === 'user' ? 'user' : 'agent', handle: role === 'user' ? (i % 2 ? 'alice' : 'bob') : 'agent' },
      timestamp: 1700000000000 + i * 1000,
      ...(role === 'tool' ? { toolPosition: { messageId: `message-${i - 1}`, afterText: 80, order: 0 }, toolInfo: { tool_name: 'read', tool_call_id: `call-${i}` } } : {}),
    });
  }
  result.push({ id: 'live-assistant', role: 'assistant', text: 'Live output', streaming: true, timestamp: 1700001000000 });
  return result;
}

function streamFrames(initial) {
  return Array.from({ length: frames }, (_, i) => [...initial.slice(0, -1), { ...initial.at(-1), text: initial.at(-1).text + 'x'.repeat(i) }]);
}

function turnIndex(count) {
  return {
    status: 'ready',
    turns: Array.from({ length: count }, (_, i) => ({
      message_id: `turn-${i}`, ordinal: i * 3, own: i % 3 !== 0,
      author: { handle: i % 3 ? 'alice' : 'bob', display: i % 3 ? 'Alice' : 'Bob' },
      preview: `Prompt ${i}`, created_at: new Date(1700000000000 + i * 1000).toISOString(),
    })),
  };
}

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(values.length / 2);
  return values.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const cases = [];
for (const count of ci ? [1000] : [1000, 20000]) {
  const index = turnIndex(count), input = streamFrames(transcript(60)), samples = [];
  let signature;
  for (let run = 0; run < runs; run++) {
    const runner = railRunner(), times = [];
    let result;
    for (const messages of input) {
      const start = performance.now();
      result = runner.run(index, messages, 800, 'alice', `turn-${count - 1}`);
      times.push(performance.now() - start);
    }
    if (result.turns.length !== count || result.activeIndex !== count - 1 || result.markers.length > 161) throw new Error('Rail fixture lost navigation coverage');
    const current = hash(JSON.stringify(result));
    if (signature && current !== signature) throw new Error('Non-deterministic rail result');
    signature = current;
    samples.push({ run: run + 1, cold_ms: times[0], stream_total_ms: times.slice(1).reduce((a, b) => a + b, 0), stream_p50_ms: percentile(times.slice(1), 0.5), stream_p95_ms: percentile(times.slice(1), 0.95), memo: runner.stats() });
  }
  cases.push({ kind: 'turn-rail', indexed_turns: count, transcript_rows: 60, frames, memo_slots: railMemoKeys, samples, stream_total_median_ms: median(samples.map(sample => sample.stream_total_ms)), final_result_sha256: signature });
}
for (const count of ci ? [60] : [60, 600, 6000]) {
  const input = streamFrames(transcript(count)), samples = [];
  let signature;
  for (let run = 0; run < runs; run++) {
    const runner = messageRunner(), times = [];
    let result;
    for (const messages of input) {
      const start = performance.now();
      result = runner.run(messages);
      times.push(performance.now() - start);
    }
    if (result.canonical.size !== count || !result.messages.some(message => message.id === 'live-assistant')) throw new Error('Transcript fixture lost rows');
    const current = hash(JSON.stringify({ messages: result.messages, canonical: [...result.canonical.keys()], singleUserRuns: [...result.singleUserRuns], assistantActions: [...result.assistantActions.keys()], turnForks: [...result.turnForks.keys()] }));
    if (signature && current !== signature) throw new Error('Non-deterministic transcript result');
    signature = current;
    samples.push({ run: run + 1, cold_ms: times[0], stream_total_ms: times.slice(1).reduce((a, b) => a + b, 0), stream_p50_ms: percentile(times.slice(1), 0.5), stream_p95_ms: percentile(times.slice(1), 0.95), memo: runner.stats() });
  }
  cases.push({ kind: 'message-derivations', transcript_rows: count, frames, memo_slots: messageMemoKeys.map(key => key === 'assistantActions' ? 'assistantActions+turnForks' : key), samples, stream_total_median_ms: median(samples.map(sample => sample.stream_total_ms)), final_result_sha256: signature });
}
const report = {
  schema_version: 1, benchmark: 'session-source-memo-derivations', timestamp: new Date().toISOString(),
  environment: { node: process.version, v8: process.versions.v8, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  source_sha256: Object.fromEntries(Object.entries(source).map(([key, text]) => [key, hash(text)])),
  parameters: { ci, runs, frames, height: 800, warmup_runs: 0, profile_slots: profileSlots, useMemo_model: 'Object.is-dependency-check; extracted source callbacks; no React renderer' },
  cases,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, json);
process.stdout.write(json);
