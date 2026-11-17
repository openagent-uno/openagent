#!/usr/bin/env node
/**
 * Pure layout baseline; does not launch the app or access a server/device.
 *
 * From the repository root:
 *   node apps/app/desktop/scripts/benchmark-graph-layout.mjs > before.json
 *   node apps/app/desktop/scripts/benchmark-graph-layout.mjs --ci
 *   node apps/app/desktop/scripts/benchmark-graph-layout.mjs --runs=5 --output=/tmp/layout.json
 *
 * Default: 200/1,000/5,000 nodes, three independent layouts per size. --ci
 * performs one 200-node layout. Every layout uses exactly 168 cold-start
 * ticks, matching native pre-settling, with fresh seeded initial positions.
 * There is no warm-up; later samples may benefit from JIT compilation.
 * Timings exclude module transpilation, graph generation and validation.
 * This is CPU evidence, not an end-to-end loading or frame-time benchmark.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, arch, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const TICKS = 168;
const COOLING = 0.985;
const SEED = 0x6f70656e;
const sourceUrl = new URL('../../universal/components/graph/forceSim.ts', import.meta.url);

function options(args) {
  let ci = false;
  let runs;
  let output;
  for (const arg of args) {
    if (arg === '--ci') ci = true;
    else if (arg.startsWith('--runs=')) {
      runs = Number(arg.slice('--runs='.length));
      if (!Number.isSafeInteger(runs) || runs < 1 || runs > 99) throw new Error('--runs must be an integer from 1 to 99');
    } else if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
      if (!output) throw new Error('--output needs a file path');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { ci, runs: runs ?? (ci ? 1 : 3), output };
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(count) {
  const rng = random(SEED ^ count);
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `note-${i}`, label: `Note ${i}`, tags: [`group-${i % 8}`] }));
  const edges = [];
  const seen = new Set();
  const add = (source, target) => {
    if (source === target) return;
    const key = source < target ? `${source}:${target}` : `${target}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: nodes[source].id, target: nodes[target].id });
  };
  for (let i = 0; i < count; i += 1) {
    add(i, (i + 1) % count);
    add(i, Math.floor(rng() * count));
    add(i, Math.floor(rng() * count));
  }
  return { nodes, edges };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(samples, key) {
  const values = samples.map(sample => sample[key]);
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

async function main() {
  const config = options(process.argv.slice(2));
  const source = await readFile(sourceUrl, 'utf8');
  // forceSim has type-only imports. Transform the owning source rather than
  // copying simulation code; this keeps the benchmark useful after a fix.
  const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: fileURLToPath(sourceUrl) });
  const { buildSim, tick } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
  const cases = [];
  for (const nodeCount of config.ci ? [200] : [200, 1000, 5000]) {
    const graph = fixture(nodeCount);
    const samples = [];
    let expectedLayoutHash;
    for (let run = 0; run < config.runs; run += 1) {
      // buildSim currently seeds positions through Math.random. Override only
      // this synchronous call and restore even if construction throws.
      const nativeRandom = Math.random;
      Math.random = random(SEED ^ nodeCount ^ 0x12345678);
      let sim;
      const start = performance.now();
      try { sim = buildSim(graph); } finally { Math.random = nativeRandom; }
      const built = performance.now();
      let alpha = 1;
      for (let step = 0; step < TICKS; step += 1) {
        tick(sim.nodes, sim.edges, alpha);
        alpha *= COOLING;
      }
      const finished = performance.now();
      const state = sim.nodes.map(node => {
        for (const key of ['x', 'y', 'vx', 'vy']) {
          if (!Number.isFinite(node[key])) throw new Error(`Non-finite ${key}: ${node.id}`);
        }
        return [node.id, node.x, node.y, node.vx, node.vy, node.pinned];
      });
      const layoutHash = digest(JSON.stringify(state));
      if (expectedLayoutHash && expectedLayoutHash !== layoutHash) throw new Error(`Non-deterministic layout for ${nodeCount} nodes`);
      expectedLayoutHash = layoutHash;
      samples.push({ run: run + 1, build_ms: built - start, ticks_ms: finished - built, total_ms: finished - start });
    }
    cases.push({
      node_count: nodeCount,
      edge_count: graph.edges.length,
      fixture_sha256: digest(JSON.stringify(graph)),
      final_layout_sha256: expectedLayoutHash,
      samples,
      build_ms: summarize(samples, 'build_ms'),
      ticks_ms: summarize(samples, 'ticks_ms'),
      total_ms: summarize(samples, 'total_ms'),
    });
  }
  const result = {
    schema_version: 1,
    benchmark: 'forceSim-native-cold-layout',
    timestamp: new Date().toISOString(),
    source_sha256: digest(source),
    environment: { node: process.version, v8: process.versions.v8, platform: platform(), arch: arch(), os_release: release(), cpu: cpus()[0]?.model ?? 'unknown' },
    parameters: { seed: SEED, ticks: TICKS, cooling: COOLING, runs: config.runs, warmup_runs: 0, ci: config.ci, pinned_nodes: 0 },
    cases,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (config.output) await writeFile(config.output, json);
  process.stdout.write(json);
}

main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
