import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { build } = await import(process.env.OPENAGENT_TEST_ESBUILD || '../../desktop/node_modules/esbuild/lib/main.js');
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../../universal/components/graph/forceSim.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const { buildSim, tick } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

// Frozen pre-indexing implementation: the reference deliberately checks ALL
// pairs and shares no candidate-selection code with the production grid.
function quadraticTick(nodes, edges, alpha) {
  const N = nodes.length;
  if (!N) return;
  const repulse = 2000 * alpha;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      let d2 = dx * dx + dy * dy;
      if (d2 > 280 * 280) continue;
      if (d2 < 100) d2 = 100;
      const f = repulse / d2;
      const fx = dx * f;
      const fy = dy * f;
      if (!nodes[i].pinned) { nodes[i].vx -= fx; nodes[i].vy -= fy; }
      if (!nodes[j].pinned) { nodes[j].vx += fx; nodes[j].vy += fy; }
    }
  }
  const spring = 0.06 * alpha;
  for (const edge of edges) {
    const s = nodes[edge.source], t = nodes[edge.target];
    const dx = t.x - s.x, dy = t.y - s.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - 80) * spring;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (!s.pinned) { s.vx += fx; s.vy += fy; }
    if (!t.pinned) { t.vx -= fx; t.vy -= fy; }
  }
  const gravity = (0.01 + N * 0.00005) * alpha;
  for (const n of nodes) {
    if (n.pinned) continue;
    n.vx -= n.x * gravity;
    n.vy -= n.y * gravity;
  }
  for (const n of nodes) {
    if (n.pinned) continue;
    n.vx *= 0.88;
    n.vy *= 0.88;
    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (speed > 22) {
      const k = 22 / speed;
      n.vx *= k;
      n.vy *= k;
    }
    n.x += n.vx;
    n.y += n.vy;
  }
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

function node(x, y, i, pinned = false) {
  return { id: `n${i}`, label: `Node ${i}`, tags: [], x, y, vx: (i % 7) - 3, vy: (i % 5) - 2, radius: 3, degree: 0, pinned };
}

function assertEquivalent(initial, edges = [], steps = 168) {
  const actual = structuredClone(initial);
  const expected = structuredClone(initial);
  let alpha = 1;
  for (let step = 0; step < steps; step++) {
    tick(actual, edges, alpha);
    quadraticTick(expected, edges, alpha);
    assert.deepEqual(actual, expected, `exact layout and velocity at tick ${step}`);
    for (let i = 0; i < initial.length; i++) {
      if (initial[i].pinned) assert.deepEqual(actual[i], initial[i], 'pinned nodes retain position and velocity');
      for (const key of ['x', 'y', 'vx', 'vy']) assert.ok(Number.isFinite(actual[i][key]));
    }
    alpha *= 0.985;
  }
  return actual;
}

test('spatial repulsion matches quadratic at cutoff, distance floor and negative cell boundaries', () => {
  const points = [
    [0, 0], [280, 0], [280 + 1e-10, 0], [280 - 1e-10, 0],
    [-280, 0], [-280 - 1e-10, 0], [-280 + 1e-10, 0],
    [0, 280], [0, -280], [168, 224], [-168, -224],
    [10, 0], [10 - 1e-10, 0], [10 + 1e-10, 0],
    [0, 0], [-0.000001, -0.000001], [560, -560],
  ];
  assertEquivalent(points.map(([x, y], i) => node(x, y, i)));
});

test('spatial repulsion keeps single and double pins immobile, including linked and overlapping nodes', () => {
  const nodes = [node(-280, -280, 0, true), node(0, -280, 1), node(0, 0, 2, true), node(0, 0, 3, true), node(279, -1, 4)];
  assertEquivalent(nodes, [{ source: 0, target: 1 }, { source: 1, target: 2 }, { source: 2, target: 3 }, { source: 3, target: 4 }]);
});

test('spatial repulsion preserves dense-cluster pair accumulation order', () => {
  const rng = random(0xd3e5e);
  const nodes = Array.from({ length: 150 }, (_, i) => node((rng() - 0.5) * 20, (rng() - 0.5) * 20, i, i % 23 === 0));
  const edges = nodes.slice(1).map((_, i) => ({ source: i, target: i + 1 }));
  assertEquivalent(nodes, edges);
});

test('spatial repulsion matches seeded sparse and mixed graphs while nodes cross cells', () => {
  for (const seed of [1, 42, 0x6f70656e]) {
    const rng = random(seed);
    const nodes = Array.from({ length: 200 }, (_, i) => node((rng() - 0.5) * 5000, (rng() - 0.5) * 5000, i, i % 19 === 0));
    const edges = nodes.slice(1).map((_, i) => ({ source: i, target: Math.floor(rng() * nodes.length) }));
    assertEquivalent(nodes, edges);
  }
});

test('spatial repulsion handles empty, isolated and large finite cell coordinates', () => {
  assertEquivalent([]);
  assertEquivalent([node(-0.001, -0.001, 0)]);
  assertEquivalent([node(1e20, -1e20, 0, true), node(1e20, -1e20, 1, true), node(0, 0, 2)]);
});

test('numeric grid matches quadratic across boundaries, negative cells, pins and dense/sparse neighborhoods above its threshold', () => {
  const boundary = [[0, 0], [280, 0], [280 + 1e-10, 0], [280 - 1e-10, 0],
    [-280, 0], [-280 - 1e-10, 0], [-280 + 1e-10, 0], [168, 224],
    [10, 0], [10 - 1e-10, 0], [10 + 1e-10, 0], [0, 0]];
  const nodes = boundary.map(([x, y], i) => node(x, y, i, i % 3 === 0));
  const rng = random(0x6f70656e);
  while (nodes.length < 1100) {
    const i = nodes.length;
    const span = i < 150 ? 20 : 5000;
    nodes.push(node((rng() - 0.5) * span, (rng() - 0.5) * span, i, i % 19 === 0));
  }
  // Numerically adjacent cell keys can collapse at this magnitude; ensure
  // each neighbor contributes only once and lookup loops always terminate.
  nodes.push(node(1e20, -1e20, nodes.length, true));
  nodes.push(node(1e20, -1e20, nodes.length, true));
  const edges = nodes.slice(1, 1100).map((_, i) => ({ source: i, target: i + 1 }));
  assertEquivalent(nodes, edges);
});

test('quadratic/grid dispatch preserves exact results on both sides of the small-graph threshold', () => {
  for (const count of [1024, 1025]) {
    const rng = random(42);
    const nodes = Array.from({ length: count }, (_, i) => node((rng() - 0.5) * 1000, (rng() - 0.5) * 1000, i, i % 29 === 0));
    assertEquivalent(nodes, [], 1);
  }
});

test('seeded buildSim cold layout remains deterministic and exactly equivalent over 168 ticks', t => {
  const graph = {
    nodes: Array.from({ length: 1025 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}`, tags: [] })),
    edges: Array.from({ length: 1025 }, (_, i) => ({ source: `n${i}`, target: `n${(i + 1) % 1025}` })),
  };
  const seededBuild = () => {
    const mock = t.mock.method(Math, 'random', random(0x6f70656e));
    try { return buildSim(graph); } finally { mock.mock.restore(); }
  };
  const initial = seededBuild();
  const repeated = seededBuild();
  assert.deepEqual(initial, repeated);
  const first = assertEquivalent(initial.nodes, initial.edges);
  const second = assertEquivalent(repeated.nodes, repeated.edges);
  assert.deepEqual(first, second);
});

function interactionFixture(count, seed = 42) {
  const rng = random(seed);
  return Array.from({ length: count }, (_, i) => {
    const span = i < 80 ? 200 : 5000;
    return node((rng() - 0.5) * span, (rng() - 0.5) * span, i, i % 53 === 0);
  });
}

function assertInteractionTick(actual, expected, edges, alpha, label) {
  const held = actual.filter(n => n.pinned).map(n => ({ id: n.id, x: n.x, y: n.y, vx: n.vx, vy: n.vy }));
  tick(actual, edges, alpha);
  quadraticTick(expected, edges, alpha);
  assert.deepEqual(actual, expected, `${label}: exact layout and velocity`);
  assert.deepEqual(actual.filter(n => n.pinned).map(n => ({ id: n.id, x: n.x, y: n.y, vx: n.vx, vy: n.vy })), held,
    `${label}: currently pinned nodes preserve externally supplied position/velocity`);
  for (const n of actual) for (const key of ['x', 'y', 'vx', 'vy']) {
    assert.ok(Number.isFinite(n[key]), `${label}: finite ${n.id}.${key}`);
  }
}

test('large-graph ticks observe drag, pin/unpin and external velocity changes between frames', () => {
  const actual = interactionFixture(1100), expected = structuredClone(actual);
  const edges = actual.slice(1).map((_, i) => ({ source: i, target: i + 1 }));
  const edits = [
    () => {},
    nodes => Object.assign(nodes[5], { pinned: true, x: -560.25, y: 280, vx: 17.25, vy: -23.5 }),
    nodes => {
      Object.assign(nodes[5], { x: 280 + 1e-10, y: -280 - 1e-10 });
      Object.assign(nodes[6], { vx: 20000, vy: -10000 });
    },
    nodes => { nodes[5].pinned = false; },
    nodes => {
      Object.assign(nodes[0], { pinned: true, x: -0, y: 0, vx: -0, vy: 0 });
      Object.assign(nodes[1099], { pinned: true, x: 1500, y: -1500, vx: -7.5, vy: 12 });
    },
    nodes => Object.assign(nodes[5], { x: -0, y: 0, vx: -0, vy: 0 }),
    nodes => {
      nodes[0].pinned = false;
      nodes[1099].pinned = false;
      Object.assign(nodes[6], { vx: -100, vy: 35 });
    },
    nodes => Object.assign(nodes[107], { x: -280.000001, y: 560.000001, vx: 0.125, vy: -0.25 }),
  ];
  edits.forEach((edit, step) => {
    edit(actual); edit(expected);
    assertInteractionTick(actual, expected, edges, 0.985 ** step, `drag frame ${step}`);
  });
});

test('large-graph ticks refresh replaced nodes and replacement arrays at the same length', () => {
  let actual = interactionFixture(1100), expected = structuredClone(actual);
  const edges = [{ source: 0, target: 1 }, { source: 10, target: 1099 }];
  assertInteractionTick(actual, expected, edges, 1, 'initial array');
  const replacement = { ...node(-281, 561, 10, true), vx: 37, vy: -19, label: 'Replacement node' };
  actual[10] = structuredClone(replacement);
  expected[10] = structuredClone(replacement);
  assertInteractionTick(actual, expected, edges, 0.985, 'replaced node, same array');
  const fresh = interactionFixture(1100, 12345);
  actual.splice(0, actual.length, ...structuredClone(fresh));
  expected.splice(0, expected.length, ...structuredClone(fresh));
  assertInteractionTick(actual, expected, edges, 0.97, 'replaced all nodes, same array');
  actual = [...actual]; expected = [...expected];
  assertInteractionTick(actual, expected, edges, 0.95, 'replacement array, same nodes');
  actual.reverse(); expected.reverse();
  assertInteractionTick(actual, expected, edges, 0.92, 'reordered nodes');
  actual = structuredClone(actual); expected = structuredClone(expected);
  actual[17].vx += 71; expected[17].vx += 71;
  assertInteractionTick(actual, expected, edges, 0.9, 'replacement array and nodes');
});

test('resizing the same array across the 1024/1025 dispatch boundary refreshes reusable buffers', () => {
  const original = interactionFixture(1100, 717);
  const actual = structuredClone(original), expected = structuredClone(original);
  const actualIdentity = actual;
  const sizes = [1100, 1025, 1024, 600, 1025, 1100, 1024, 1100];
  sizes.forEach((size, step) => {
    for (const nodes of [actual, expected]) {
      if (nodes.length > size) nodes.length = size;
      else if (nodes.length < size) nodes.push(...structuredClone(original.slice(nodes.length, size)));
    }
    assert.strictEqual(actual, actualIdentity);
    assert.equal(actual.length, size);
    assertInteractionTick(actual, expected, [{ source: 0, target: size - 1 }, { source: 1, target: 2 }], 0.985 ** step, `resize frame ${step}, N=${size}`);
  });
});

test('alternating two large arrays isolates cached buffers and interactive state', () => {
  const first = interactionFixture(1100, 1), second = interactionFixture(1100, 987);
  const expectedFirst = structuredClone(first), expectedSecond = structuredClone(second);
  const edges = [{ source: 0, target: 1099 }, { source: 12, target: 13 }];
  for (let frame = 0; frame < 6; frame++) {
    for (const nodes of [first, expectedFirst]) {
      Object.assign(nodes[12], { pinned: frame % 2 === 0, x: -560 + frame * 10, vy: 11 - frame });
    }
    for (const nodes of [second, expectedSecond]) {
      Object.assign(nodes[12], { pinned: frame % 2 !== 0, y: 840 - frame * 20, vx: frame - 15 });
    }
    const secondBefore = structuredClone(second);
    assertInteractionTick(first, expectedFirst, edges, 0.985 ** frame, `first graph frame ${frame}`);
    assert.deepEqual(second, secondBefore, 'ticking first graph does not mutate second graph');
    const firstBefore = structuredClone(first);
    assertInteractionTick(second, expectedSecond, edges, 0.98 ** frame, `second graph frame ${frame}`);
    assert.deepEqual(first, firstBefore, 'ticking second graph does not mutate first graph');
  }
});
