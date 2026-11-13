/**
 * Force-directed layout shared by the web canvas graph and the native SVG
 * graph: node/edge model, degree colouring and one simulation step.
 * Pure — no rendering or platform APIs.
 */
import type { GraphData } from '../../../common/types';
import type { getRawColors } from '../../theme';

// ── Simulation types ──

export interface SimNode {
  id: string;
  label: string;
  tags: string[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Number of edges touching this node — drives both size and color so
   *  hubs pop in brand red while leaves fade into warm gray. */
  degree: number;
  pinned: boolean;
}

export interface SimEdge {
  source: number; // index into nodes
  target: number;
}

/** Palette must be passed in (not imported) because Canvas 2D can't
 *  resolve the `var(--oa-*)` references on the web `colors` proxy — we
 *  need actual hex values from `getRawColors()`.
 *
 *  Degree-based coloring: highly-connected hubs get brand red, mid-degree
 *  nodes step down through the warm palette, and isolated leaves render
 *  in muted gray. The previous tag-hash scheme inverted this visually
 *  (hubs happened to hash onto neutrals), so degree-ranking is the
 *  intent-matching approach. */
export function degreeColor(
  degree: number,
  maxDegree: number,
  palette: ReturnType<typeof getRawColors>,
): string {
  if (maxDegree === 0 || degree === 0) return palette.graphNodeMuted;
  const t = degree / maxDegree; // 0..1 — higher = more connected
  if (t >= 0.66) return palette.primary;      // hubs
  if (t >= 0.33) return palette.primaryMuted; // mid
  return palette.primaryEnd;                   // lightly-connected leaves
}

// ── Force simulation (runs in requestAnimationFrame) ──

export function buildSim(data: GraphData): { nodes: SimNode[]; edges: SimEdge[]; maxDegree: number } {
  const idxMap = new Map<string, number>();
  // Compute degree up front in a single pass — the old code re-scanned
  // data.edges once per node in an O(N*E) loop.
  const degreeById = new Map<string, number>();
  for (const e of data.edges) {
    degreeById.set(e.source, (degreeById.get(e.source) || 0) + 1);
    degreeById.set(e.target, (degreeById.get(e.target) || 0) + 1);
  }
  let maxDegree = 0;
  const nodes: SimNode[] = data.nodes.map((n, i) => {
    idxMap.set(n.id, i);
    const angle = (i / data.nodes.length) * Math.PI * 2;
    const r = 120 + Math.random() * 80;
    const degree = degreeById.get(n.id) || 0;
    if (degree > maxDegree) maxDegree = degree;
    return {
      id: n.id,
      label: n.label,
      tags: n.tags || [],
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      radius: 3 + Math.min(degree * 0.75, 6),
      degree,
      pinned: false,
    };
  });
  const edges: SimEdge[] = [];
  for (const e of data.edges) {
    const si = idxMap.get(e.source);
    const ti = idxMap.get(e.target);
    if (si !== undefined && ti !== undefined) edges.push({ source: si, target: ti });
  }
  return { nodes, edges, maxDegree };
}

export function tick(nodes: SimNode[], edges: SimEdge[], alpha: number) {
  const N = nodes.length;
  if (N === 0) return;

  // Repulsion. Two safeguards keep the layout numerically stable on big
  // graphs — the shipped version had neither, so a ~600-node graph
  // diverged outright (positions ran off past 1e20) and never composed,
  // leaving only scattered, disconnected-looking dots:
  //   1. range cutoff — a node repels only nearby nodes, so the
  //      cumulative O(N²) outward push can't overpower gravity;
  //   2. minimum-distance floor — a close encounter can't inject a huge
  //      1/d² impulse that the damping is unable to dissipate.
  const repulse = 2000 * alpha;
  const repelRange2 = 280 * 280;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      let d2 = dx * dx + dy * dy;
      if (d2 > repelRange2) continue;
      if (d2 < 100) d2 = 100;
      const f = repulse / d2;
      const fx = dx * f;
      const fy = dy * f;
      if (!nodes[i].pinned) { nodes[i].vx -= fx; nodes[i].vy -= fy; }
      if (!nodes[j].pinned) { nodes[j].vx += fx; nodes[j].vy += fy; }
    }
  }

  // Link spring
  const spring = 0.06 * alpha;
  const idealLen = 80;
  for (const e of edges) {
    const s = nodes[e.source], t = nodes[e.target];
    const dx = t.x - s.x, dy = t.y - s.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - idealLen) * spring;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (!s.pinned) { s.vx += fx; s.vy += fy; }
    if (!t.pinned) { t.vx -= fx; t.vy -= fy; }
  }

  // Center gravity — scaled by node count so large graphs stay bounded;
  // a 600-node graph needs a far firmer pull to the centre than a
  // 50-node one, or it drifts apart faster than the springs can gather it.
  const gravity = (0.01 + N * 0.00005) * alpha;
  for (const n of nodes) {
    if (n.pinned) continue;
    n.vx -= n.x * gravity;
    n.vy -= n.y * gravity;
  }

  // Velocity damping, speed clamp, then position update. The clamp is
  // the hard backstop against divergence: even a pathological force
  // pile-up can't move a node more than maxSpeed px in one frame, so the
  // layout always settles instead of exploding off-screen.
  const damping = 0.88;
  const maxSpeed = 22;
  for (const n of nodes) {
    if (n.pinned) continue;
    n.vx *= damping;
    n.vy *= damping;
    const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (sp > maxSpeed) {
      const k = maxSpeed / sp;
      n.vx *= k;
      n.vy *= k;
    }
    n.x += n.vx;
    n.y += n.vy;
  }
}
