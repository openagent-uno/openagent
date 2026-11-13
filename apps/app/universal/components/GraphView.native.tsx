/**
 * Native (iOS/Android) force-directed graph — the touch counterpart of the
 * web canvas ``GraphView``.
 *
 * Same simulation (``graph/forceSim``), colours and camera model, drawn
 * with react-native-svg. Touch mirrors the mouse:
 *   - drag a node to move it (it stays pinned while held);
 *   - drag empty space to pan;
 *   - pinch with two fingers to zoom around the fingers (the wheel on web);
 *   - tap a node to open it; a drag never opens.
 * The node under the finger shows its label, like hover on the web.
 * Frames are only rendered while the layout is still settling or the user
 * is interacting, and never while the screen is out of focus.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type GestureResponderEvent, type NativeTouchEvent } from 'react-native';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { useIsFocused } from '@react-navigation/native';
import type { GraphData } from '../../common/types';
import { colors, getRawColors } from '../theme';
import { buildSim, degreeColor, tick, type SimEdge, type SimNode } from './graph/forceSim';

interface Props {
  data: GraphData;
  onSelectNode?: (id: string) => void;
  highlightNodeIds?: Set<string>;
  width?: number;
  height?: number;
}

/** Fingers jitter more than a mouse: a tap may travel this far. */
const TAP_SLOP_PX = 8;
/** Extra hit radius so small nodes are reachable with a fingertip. */
const TOUCH_HIT_PAD = 14;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
/** Used only until the first fit-to-view (see ``fittedRef``). */
const INITIAL_ZOOM = 0.55;
const LABEL_ZOOM = 0.7;
/** Labels are SVG text elements: cap how many render at once. */
const MAX_LABELS = 120;
/** Re-render at most this often (ms) while the layout moves. */
const FRAME_INTERVAL_MS = 33;
/** Layout is pre-settled synchronously down to this temperature... */
const PRESETTLE_ALPHA = 0.08;
/** Cooling used while pre-settling (keeps the blocking pass short). */
const PRESETTLE_COOLING = 0.985;
/** ...then cools faster than the web loop (~3 s instead of ~20 s). */
const COOLING = 0.98;

type Drag =
  | { type: 'node'; nodeIdx: number; startX: number; startY: number; moved: boolean }
  | { type: 'pan'; startX: number; startY: number; camStartX: number; camStartY: number; moved: boolean }
  | { type: 'pinch'; startDist: number; startZoom: number; worldX: number; worldY: number }
  | { type: null };

/** Full circle as a path segment, so many nodes share one <Path>. */
function circlePath(cx: number, cy: number, r: number): string {
  const x = cx.toFixed(1), y = cy.toFixed(1), rr = r.toFixed(2), d = (r * 2).toFixed(2);
  return `M${(cx - r).toFixed(1)} ${y}a${rr} ${rr} 0 1 0 ${d} 0a${rr} ${rr} 0 1 0 -${d} 0`;
}

export default function GraphView({ data, onSelectNode, highlightNodeIds, width, height }: Props) {
  const focused = useIsFocused();
  const [size, setSize] = useState({ w: width || 360, h: height || 600 });
  const simRef = useRef<{ nodes: SimNode[]; edges: SimEdge[]; maxDegree: number }>({ nodes: [], edges: [], maxDegree: 0 });
  const alphaRef = useRef(1);
  const camRef = useRef({ x: 0, y: 0, zoom: INITIAL_ZOOM });
  const dragRef = useRef<Drag>({ type: null });
  const activeRef = useRef(-1);
  const dirtyRef = useRef(true);
  const [, setFrame] = useState(0);

  useEffect(() => {
    const sim = buildSim(data);
    // Settle most of the layout before the first paint: re-rendering SVG
    // per frame is far costlier than a tick, so animate only the tail.
    let alpha = 1;
    while (alpha > PRESETTLE_ALPHA) {
      tick(sim.nodes, sim.edges, alpha);
      alpha *= PRESETTLE_COOLING;
    }
    simRef.current = sim;
    alphaRef.current = alpha;
    dirtyRef.current = true;
  }, [data]);

  useEffect(() => { dirtyRef.current = true; }, [highlightNodeIds]);

  // Simulation + render loop. Re-render only when something changed, so a
  // settled graph costs nothing.
  useEffect(() => {
    if (!focused) return;
    let raf = 0;
    let running = true;
    let lastPaint = 0;
    const loop = (now: number) => {
      if (!running) return;
      const { nodes, edges } = simRef.current;
      if (alphaRef.current > 0.001) {
        tick(nodes, edges, alphaRef.current);
        alphaRef.current *= COOLING;
        dirtyRef.current = true;
      }
      if (dirtyRef.current && now - lastPaint >= FRAME_INTERVAL_MS) {
        dirtyRef.current = false;
        lastPaint = now;
        setFrame((f) => (f + 1) % 1_000_000);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); };
  }, [focused]);

  const sizeRef = useRef(size);
  sizeRef.current = size;

  // Frame the whole layout once per data set, as soon as the real size is
  // known (phones are too narrow for the web's fixed zoom of 1).
  const fittedRef = useRef<GraphData | null>(null);
  const [measured, setMeasured] = useState(false);
  useEffect(() => {
    if (!measured || fittedRef.current === data) return;
    const { nodes } = simRef.current;
    if (nodes.length === 0) return;
    fittedRef.current = data;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const { w, h } = sizeRef.current;
    const pad = 48;
    const zoom = Math.min(
      (w - pad) / Math.max(1, maxX - minX),
      (h - pad * 2) / Math.max(1, maxY - minY),
    );
    camRef.current = {
      x: -(minX + maxX) / 2,
      y: -(minY + maxY) / 2,
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)),
    };
    dirtyRef.current = true;
  }, [data, measured, size]);

  // Children ignore touches (pointerEvents="none"), so every touch targets
  // this container and locationX/Y are container-relative.
  const toLocal = useCallback((t: NativeTouchEvent) => ({ x: t.locationX, y: t.locationY }), []);

  const screen2world = useCallback((sx: number, sy: number) => {
    const cam = camRef.current;
    const { w, h } = sizeRef.current;
    return { x: (sx - w / 2) / cam.zoom - cam.x, y: (sy - h / 2) / cam.zoom - cam.y };
  }, []);

  const hitTest = useCallback((wx: number, wy: number): number => {
    const { nodes } = simRef.current;
    const pad = TOUCH_HIT_PAD / camRef.current.zoom;
    let best = -1;
    let bestD = Infinity;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = wx - n.x, dy = wy - n.y;
      const d2 = dx * dx + dy * dy;
      const r = n.radius + pad;
      if (d2 < r * r && d2 < bestD) { best = i; bestD = d2; }
    }
    return best;
  }, []);

  const startPinch = useCallback((touches: NativeTouchEvent[]) => {
    const a = toLocal(touches[0]!), b = toLocal(touches[1]!);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const world = screen2world(mid.x, mid.y);
    const prev = dragRef.current;
    if (prev.type === 'node') simRef.current.nodes[prev.nodeIdx]!.pinned = false;
    activeRef.current = -1;
    dragRef.current = {
      type: 'pinch',
      startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      startZoom: camRef.current.zoom,
      worldX: world.x,
      worldY: world.y,
    };
  }, [screen2world, toLocal]);

  const beginSingle = useCallback((t: NativeTouchEvent) => {
    const p = toLocal(t);
    const w = screen2world(p.x, p.y);
    const idx = hitTest(w.x, w.y);
    const cam = camRef.current;
    if (idx >= 0) {
      dragRef.current = { type: 'node', nodeIdx: idx, startX: p.x, startY: p.y, moved: false };
      simRef.current.nodes[idx]!.pinned = true;
      alphaRef.current = Math.max(alphaRef.current, 0.3);
      activeRef.current = idx;
    } else {
      dragRef.current = { type: 'pan', startX: p.x, startY: p.y, camStartX: cam.x, camStartY: cam.y, moved: false };
      activeRef.current = -1;
    }
    dirtyRef.current = true;
  }, [hitTest, screen2world, toLocal]);

  const endGesture = useCallback((select: boolean) => {
    const drag = dragRef.current;
    if (drag.type === 'node') {
      const n = simRef.current.nodes[drag.nodeIdx]!;
      n.pinned = false;
      if (select && !drag.moved && onSelectNode) onSelectNode(n.id);
    }
    dragRef.current = { type: null };
    activeRef.current = -1;
    dirtyRef.current = true;
  }, [onSelectNode]);

  const onSelectRef = useRef(endGesture);
  onSelectRef.current = endGesture;

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // Keep the gesture: a parent scroll/drawer must not steal a node drag.
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e: GestureResponderEvent) => {
      const touches = e.nativeEvent.touches;
      if (touches.length >= 2) startPinch(touches);
      else beginSingle(e.nativeEvent);
    },
    onPanResponderMove: (e: GestureResponderEvent) => {
      const touches = e.nativeEvent.touches;
      const cam = camRef.current;
      if (touches.length >= 2) {
        if (dragRef.current.type !== 'pinch') startPinch(touches);
        const drag = dragRef.current;
        if (drag.type !== 'pinch') return;
        const a = toLocal(touches[0]!), b = toLocal(touches[1]!);
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, drag.startZoom * (dist / drag.startDist)));
        // Keep the world point that started under the fingers under them
        // (this also pans with a two-finger drag).
        const { w, h } = sizeRef.current;
        cam.x = (mid.x - w / 2) / cam.zoom - drag.worldX;
        cam.y = (mid.y - h / 2) / cam.zoom - drag.worldY;
        dirtyRef.current = true;
        return;
      }
      const drag = dragRef.current;
      if (drag.type === 'pinch') {
        // One finger lifted mid-pinch: continue as a pan from here.
        beginSingle(e.nativeEvent);
        return;
      }
      if (drag.type === null) return;
      const p = toLocal(e.nativeEvent);
      if (!drag.moved) {
        const dx = p.x - drag.startX, dy = p.y - drag.startY;
        if (dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX) drag.moved = true;
      }
      if (!drag.moved) return;
      if (drag.type === 'node') {
        const wpt = screen2world(p.x, p.y);
        const n = simRef.current.nodes[drag.nodeIdx]!;
        n.x = wpt.x;
        n.y = wpt.y;
        alphaRef.current = Math.max(alphaRef.current, 0.1);
      } else {
        cam.x = drag.camStartX + (p.x - drag.startX) / cam.zoom;
        cam.y = drag.camStartY + (p.y - drag.startY) / cam.zoom;
      }
      dirtyRef.current = true;
    },
    onPanResponderRelease: () => onSelectRef.current(true),
    onPanResponderTerminate: () => onSelectRef.current(false),
  }), [beginSingle, screen2world, startPinch, toLocal]);

  // ── Render ──
  // Screen-space coordinates keep strokes crisp at any zoom. Nodes are
  // batched into one <Path> per colour/state: hundreds of <Circle> elements
  // re-reconciled every frame are too slow for the JS thread on a phone.
  const { nodes, edges, maxDegree } = simRef.current;
  const cam = camRef.current;
  const { w: W, h: H } = size;
  const palette = getRawColors();
  const sx = (x: number) => (x + cam.x) * cam.zoom + W / 2;
  const sy = (y: number) => (y + cam.y) * cam.zoom + H / 2;
  const hl = highlightNodeIds && highlightNodeIds.size > 0 ? highlightNodeIds : undefined;
  const active = activeRef.current;
  const nodeScale = Math.max(cam.zoom, 0.35);

  let edgePath = '';
  for (const e of edges) {
    const s = nodes[e.source]!, t = nodes[e.target]!;
    if (hl && !hl.has(s.id) && !hl.has(t.id)) continue;
    edgePath += `M${sx(s.x).toFixed(1)} ${sy(s.y).toFixed(1)}L${sx(t.x).toFixed(1)} ${sy(t.y).toFixed(1)}`;
  }

  const groups = new Map<string, { color: string; dimmed: boolean; d: string }>();
  let glowPath = '';
  const labels: { key: string; x: number; y: number; text: string; dimmed: boolean }[] = [];
  const showAllLabels = cam.zoom > LABEL_ZOOM;
  for (let i = 0; i < nodes.length; i++) {
    if (i === active) continue;
    const n = nodes[i]!;
    const cx = sx(n.x), cy = sy(n.y);
    if (cx < -20 || cy < -20 || cx > W + 20 || cy > H + 20) continue;
    const r = n.radius * nodeScale;
    const color = degreeColor(n.degree, maxDegree, palette);
    const dimmed = !!hl && !hl.has(n.id);
    const key = `${color}|${dimmed ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) { g = { color, dimmed, d: '' }; groups.set(key, g); }
    g.d += circlePath(cx, cy, r);
    if (hl && !dimmed) glowPath += circlePath(cx, cy, r + 2.5);
    if (showAllLabels && labels.length < MAX_LABELS) {
      labels.push({ key: n.id, x: cx, y: cy + r + 13, text: n.label, dimmed });
    }
  }
  const activeNode = active >= 0 ? nodes[active] : undefined;

  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel="Memory graph"
      accessibilityHint="Drag nodes or the canvas, pinch to zoom, tap a node to open it"

      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        setSize({ w, h });
        setMeasured(true);
        dirtyRef.current = true;
      }}
      {...responder.panHandlers}
    >
      {/* react-native-svg hit-tests its own shapes even with
          pointerEvents="none", which would make touch locations relative to
          the shape under the finger. A plain View wrapper reliably passes
          every touch to the container responder. */}
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={W} height={H}>
          {edgePath ? (
            <Path d={edgePath} stroke={palette.graphEdge} strokeWidth={1} opacity={hl ? 0.25 : 1} fill="none" />
          ) : null}
          {[...groups.values()].map((g) => (
            <Path
              key={`${g.color}-${g.dimmed}`}
              d={g.d}
              fill={g.color}
              fillOpacity={g.dimmed ? 0.2 : 0.72}
              stroke={g.dimmed ? palette.graphNodeMuted : palette.graphEdge}
              strokeOpacity={g.dimmed ? 0.33 : 1}
              strokeWidth={g.dimmed ? 0.5 : 1}
            />
          ))}
          {glowPath ? (
            <Path d={glowPath} fill="none" stroke={palette.primary} strokeOpacity={0.53} strokeWidth={2.5} />
          ) : null}
          {labels.map((l) => (
            <SvgText
              key={l.key}
              x={l.x}
              y={l.y}
              fontSize={11}
              textAnchor="middle"
              fill={palette.graphLabel}
              fillOpacity={l.dimmed ? 0.27 : 1}
            >
              {l.text}
            </SvgText>
          ))}
          {activeNode ? (
            <>
              <Circle
                cx={sx(activeNode.x)}
                cy={sy(activeNode.y)}
                r={activeNode.radius * nodeScale + 2}
                fill={degreeColor(activeNode.degree, maxDegree, palette)}
                stroke={palette.graphRing}
                strokeWidth={2}
              />
              <SvgText
                x={sx(activeNode.x)}
                y={sy(activeNode.y) + activeNode.radius * nodeScale + 15}
                fontSize={12}
                textAnchor="middle"
                fill={palette.graphLabel}
              >
                {activeNode.label}
              </SvgText>
            </>
          ) : null}
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.graphBg },
});
