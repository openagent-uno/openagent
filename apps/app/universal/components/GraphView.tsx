/**
 * High-performance Canvas 2D force-directed graph view.
 *
 * - Pure <canvas> rendering — no DOM nodes per node, no SVG overhead
 * - Simple velocity-Verlet force simulation (repulsion + link springs + centering)
 * - Drag nodes, pan canvas, zoom with scroll wheel
 * - Click node → callback to parent (select note)
 * - Hover → shows label tooltip
 * - Runs at 60fps with 200+ nodes on modest hardware
 *
 * Web only (Canvas 2D); iOS/Android resolve ``GraphView.native.tsx``.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import type { GraphData } from '../../common/types';
import { colors, font, getRawColors } from '../theme';
import { buildSim, degreeColor, tick, type SimEdge, type SimNode } from './graph/forceSim';

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
});
