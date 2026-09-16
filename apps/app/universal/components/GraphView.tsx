/**
 * High-performance Canvas 2D force-directed graph view.
 *
 * - Pure <canvas> rendering — no DOM nodes per node, no SVG overhead
 * - Simple velocity-Verlet force simulation (repulsion + link springs + centering)
 * - Drag nodes, pan canvas, zoom with scroll wheel
 * - Click node → callback to parent (select note)
 * - Hover → shows label tooltip
 * - Runs at 60fps with 200+ nodes on modest hardware
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import type { GraphData } from '../../common/types';
import { colors, font, getRawColors } from '../theme';

interface Props {
  data: GraphData;
  onSelectNode?: (id: string) => void;
  /** When set, matching node ids render at full opacity with a glow ring;
   *  non-matching nodes are dimmed to 0.2 alpha. Pass an empty/undefined
   *  set to restore normal rendering. */
  highlightNodeIds?: Set<string>;
  width?: number;
  height?: number;
}

// ── Simulation types ──

interface SimNode {
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

interface SimEdge {
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
function degreeColor(
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

function buildSim(data: GraphData): { nodes: SimNode[]; edges: SimEdge[]; maxDegree: number } {
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

function tick(nodes: SimNode[], edges: SimEdge[], alpha: number) {
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

// ── React component ──

export default function GraphView({ data, onSelectNode, highlightNodeIds, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<{ nodes: SimNode[]; edges: SimEdge[]; maxDegree: number }>({ nodes: [], edges: [], maxDegree: 0 });
  const frameRef = useRef<number>(0);
  const alphaRef = useRef(1);
  // Keep a ref so the rAF closure always reads the latest highlight set
  // (the render useEffect only re-runs on containerSize changes).
  const highlightRef = useRef<Set<string> | undefined>(highlightNodeIds);
  highlightRef.current = highlightNodeIds;

  // Camera state
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  // Interaction state. `moved` tracks whether the pointer travelled far
  // enough between down and up to count as a drag — used below to
  // suppress the node-open action on drag release.
  const dragRef = useRef<{
    type: 'node' | 'pan' | null;
    nodeIdx: number;
    startX: number;
    startY: number;
    camStartX: number;
    camStartY: number;
    moved: boolean;
  }>({ type: null, nodeIdx: -1, startX: 0, startY: 0, camStartX: 0, camStartY: 0, moved: false });
  // Pixel threshold — mouse must travel > this many screen pixels between
  // mousedown and mouseup to be treated as a drag rather than a click.
  // A few pixels of jitter during a normal click is expected.
  const CLICK_THRESHOLD_PX = 4;
  const hoverRef = useRef(-1);

  const [containerSize, setContainerSize] = useState({ w: width || 600, h: height || 400 });

  // Rebuild simulation when data changes
  useEffect(() => {
    simRef.current = buildSim(data);
    alphaRef.current = 1;
  }, [data]);

  // Screen → world coordinates
  const screen2world = useCallback((sx: number, sy: number) => {
    const cam = camRef.current;
    const { w, h } = containerSize;
    return {
      x: (sx - w / 2) / cam.zoom - cam.x,
      y: (sy - h / 2) / cam.zoom - cam.y,
    };
  }, [containerSize]);

  // Find node at position
  const hitTest = useCallback((wx: number, wy: number): number => {
    const { nodes } = simRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = wx - n.x, dy = wy - n.y;
      if (dx * dx + dy * dy < (n.radius + 4) ** 2) return i;
    }
    return -1;
  }, []);

  // ── Canvas render loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || Platform.OS !== 'web') return;

    const ctx = canvas.getContext('2d')!;
    const W = containerSize.w, H = containerSize.h;
    const dpr = window.devicePixelRatio || 1;
    // Size the backing store ONCE per size change. Assigning canvas.width/
    // height reallocates AND clears the bitmap — previously this ran on
    // EVERY frame (~60x/s forever), one of the most expensive canvas ops.
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    let running = true;

    const render = () => {
      if (!running) return;
      // Cheap-out when the graph is off-screen: the drawer keeps the Memory
      // screen mounted (inactive → display:none → offsetParent null) and the
      // tab/window may be hidden. Skip all canvas work but keep the rAF alive
      // so drawing resumes automatically on return — this stops the loop
      // pegging a core in the background after Memory is opened once.
      if ((typeof document !== 'undefined' && document.hidden) || canvas.offsetParent === null) {
        frameRef.current = requestAnimationFrame(render);
        return;
      }
      const { nodes, edges, maxDegree } = simRef.current;
      const cam = camRef.current;
      // Raw hex palette for canvas — resolved each frame so theme toggles
      // take effect without any extra subscription/invalidation.
      const palette = getRawColors();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Simulation tick (cool down over time)
      if (alphaRef.current > 0.001) {
        tick(nodes, edges, alphaRef.current);
        alphaRef.current *= 0.995;
      }

      // Clear
      ctx.fillStyle = palette.graphBg;
      ctx.fillRect(0, 0, W, H);

      // Transform to camera
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(cam.x, cam.y);

      // Edges — when highlighting, only draw edges connected to at least
      // one highlighted node, at reduced opacity; otherwise draw normally.
      const hl = highlightRef.current;
      const hasHl = hl && hl.size > 0;
      ctx.strokeStyle = palette.graphEdge;
      ctx.lineWidth = 1 / cam.zoom;
      ctx.beginPath();
      for (const e of edges) {
        const s = nodes[e.source], t = nodes[e.target];
        if (hasHl && !hl!.has(s.id) && !hl!.has(t.id)) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
      }
      ctx.globalAlpha = hasHl ? 0.25 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Nodes — solid fill on hover, 72% alpha otherwise (softer in-field).
      // Color is driven by connectivity: hubs render in brand red, leaves
      // in muted gray.
      // When ``highlightRef.current`` is set, matching nodes render at full
      // opacity with a glow ring; non-matching nodes dim to 0.2 alpha.
      const hl2 = highlightRef.current;
      const hasHl2 = hl2 && hl2.size > 0;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const isHover = i === hoverRef.current;
        const isHighlighted = !hasHl2 || hl2!.has(n.id);
        const c = degreeColor(n.degree, maxDegree, palette);

        if (hasHl2 && !isHighlighted) {
          // Dimmed non-matching node
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
          ctx.fillStyle = c + '33'; // ~0.2 alpha
          ctx.fill();
          ctx.strokeStyle = palette.graphNodeMuted + '55';
          ctx.lineWidth = 0.5 / cam.zoom;
          ctx.stroke();
        } else {
          // Full-opacity node (highlighted or all nodes normal)
          const radius = n.radius + (isHover ? 2 : 0);
          ctx.beginPath();
          ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = isHover ? c : c + 'B8';
          ctx.fill();
          // Glow ring for highlighted nodes — brighter, slightly larger
          if (hasHl2 && isHighlighted) {
            // Outer glow ring
            ctx.beginPath();
            ctx.arc(n.x, n.y, radius + 2.5, 0, Math.PI * 2);
            ctx.strokeStyle = palette.primary + '88';
            ctx.lineWidth = 2.5 / cam.zoom;
            ctx.stroke();
          }
          // Thin ring
          ctx.strokeStyle = isHover ? palette.graphRing : palette.graphEdge;
          ctx.lineWidth = (isHover ? 2 : 1) / cam.zoom;
          ctx.stroke();
        }
      }

      // Labels (only when zoomed in enough or hovered)
      const labelThreshold = 0.7;
      if (cam.zoom > labelThreshold || hoverRef.current >= 0) {
        const hl3 = highlightRef.current;
        const hasHl3 = hl3 && hl3.size > 0;
        ctx.font = `${11 / cam.zoom}px ${font.sans}`;
        ctx.textAlign = 'center';
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (cam.zoom <= labelThreshold && i !== hoverRef.current) continue;
          const isHighlighted = !hasHl3 || hl3!.has(n.id);
          ctx.fillStyle = hasHl3 && !isHighlighted
            ? palette.graphLabel + '44'
            : palette.graphLabel;
          ctx.fillText(n.label, n.x, n.y + n.radius + 14 / cam.zoom);
        }
      }

      ctx.restore();

      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);
    return () => {
      running = false;
      cancelAnimationFrame(frameRef.current);
    };
  }, [containerSize]);

  // ── Mouse interaction ──
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = screen2world(sx, sy);
    const idx = hitTest(w.x, w.y);
    const cam = camRef.current;

    if (idx >= 0) {
      dragRef.current = { type: 'node', nodeIdx: idx, startX: sx, startY: sy, camStartX: 0, camStartY: 0, moved: false };
      simRef.current.nodes[idx].pinned = true;
      alphaRef.current = Math.max(alphaRef.current, 0.3);
    } else {
      dragRef.current = { type: 'pan', nodeIdx: -1, startX: sx, startY: sy, camStartX: cam.x, camStartY: cam.y, moved: false };
    }
  }, [screen2world, hitTest]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const drag = dragRef.current;
    const cam = camRef.current;

    // Promote to "drag" once the pointer moves beyond the click threshold.
    // Tiny jitter between mousedown and mouseup still counts as a click.
    if (drag.type && !drag.moved) {
      const dx = sx - drag.startX;
      const dy = sy - drag.startY;
      if (dx * dx + dy * dy > CLICK_THRESHOLD_PX * CLICK_THRESHOLD_PX) {
        drag.moved = true;
      }
    }

    if (drag.type === 'node') {
      // Only actually move the node once this is a drag — otherwise the
      // simulation snaps into place the instant we mousedown on a node,
      // which feels twitchy.
      if (drag.moved) {
        const w = screen2world(sx, sy);
        const n = simRef.current.nodes[drag.nodeIdx];
        n.x = w.x;
        n.y = w.y;
        alphaRef.current = Math.max(alphaRef.current, 0.1);
      }
    } else if (drag.type === 'pan') {
      cam.x = drag.camStartX + (sx - drag.startX) / cam.zoom;
      cam.y = drag.camStartY + (sy - drag.startY) / cam.zoom;
    } else {
      // Hover detection
      const w = screen2world(sx, sy);
      hoverRef.current = hitTest(w.x, w.y);
    }
  }, [screen2world, hitTest]);

  const onMouseUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag.type === 'node') {
      const n = simRef.current.nodes[drag.nodeIdx];
      n.pinned = false;
      // Only open the note when the user released on the same node they
      // clicked, without dragging past the click threshold. A drag must
      // not trigger navigation.
      if (!drag.moved && onSelectNode) {
        onSelectNode(n.id);
      }
    }
    dragRef.current = { type: null, nodeIdx: -1, startX: 0, startY: 0, camStartX: 0, camStartY: 0, moved: false };
  }, [onSelectNode]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const cam = camRef.current;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    cam.zoom = Math.max(0.1, Math.min(5, cam.zoom * factor));
  }, []);

  if (Platform.OS !== 'web') {
    return (
      <View style={styles.fallback}>
        {/* On native, use a placeholder — Canvas 2D is web-only */}
      </View>
    );
  }

  return (
    <View
      style={styles.container}
      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        setContainerSize({ w, h });
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', cursor: dragRef.current.type ? 'grabbing' : 'default' }}
        onMouseDown={onMouseDown as any}
        onMouseMove={onMouseMove as any}
        onMouseUp={onMouseUp as any}
        onMouseLeave={onMouseUp as any}
        onWheel={onWheel as any}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.graphBg },
  fallback: { flex: 1, backgroundColor: colors.graphBg },
});
