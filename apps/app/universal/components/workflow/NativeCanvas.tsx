/**
 * NativeCanvas — touch-first workflow canvas.
 *
 * What it does:
 *   - Renders every node as an SVG rect with a header (icon + type),
 *     label, preview line and I/O handles.
 *   - Renders every edge as a bezier SVG path between the right side
 *     of the source node's chosen handle and the left side of the
 *     target node's input handle.
 *   - Pan the canvas with a two-finger drag or a one-finger drag on
 *     empty space. Pinch to zoom.
 *   - Drag individual nodes by long-pressing them first (avoids
 *     fighting canvas pan).
 *   - Tap a node to select it → surfaces the properties modal.
 *   - Tap an output handle, then tap a target input handle to connect
 *     (dragging lines on touch is error-prone).
 *
 * Heavy state (node positions, pan/zoom transforms) lives in
 * ``react-native-reanimated`` shared values so gesture updates stay
 * on the UI thread at 60fps. When a drag ends we mirror the final
 * position back into the React tree via ``onNodesChange`` so Save
 * sees the new graph.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Dimensions,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';
import { colors, font, radius } from '../../theme';
import type {
  WorkflowEdge,
  WorkflowNode,
} from '../../../common/types';
import { NODE_META } from './nodes-native/nodeMeta';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;
const HANDLE_RADIUS = 7;
const GRID_SIZE = 24;

type NodeStatus = 'idle' | 'running' | 'success' | 'failed';

interface Props {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  nodeStatuses?: Record<string, NodeStatus>;
  selectedNodeId: string | null;
  connectFrom: { nodeId: string; handle: string } | null;
  onSelectNode: (id: string | null) => void;
  onNodePositionChanged: (id: string, position: { x: number; y: number }) => void;
  onHandleTap: (nodeId: string, handle: string, kind: 'source' | 'target') => void;
}

export default function NativeCanvas({
  nodes,
  edges,
  nodeStatuses = {},
  selectedNodeId,
  connectFrom,
  onSelectNode,
  onNodePositionChanged,
  onHandleTap,
}: Props) {
  const { width: screenW, height: screenH } = Dimensions.get('window');

  // Canvas-level pan + zoom.
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);
  const scale = useSharedValue(1);
  const scaleStart = useSharedValue(1);

  // Node-position cache — mirrors nodes[].position so drag gestures
  // can update positions at 60fps without re-rendering React. We
  // flush back via onNodePositionChanged when a drag ends.
  const posCache = useRef<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    nodes.forEach((n) => {
      posCache.current[n.id] = { ...n.position };
    });
  }, [nodes]);

  // ── Gestures ────────────────────────────────────────────────────

  const panGesture = Gesture.Pan()
    .minPointers(1)
    .onStart(() => {
      panStartX.value = panX.value;
      panStartY.value = panY.value;
    })
    .onUpdate((e) => {
      panX.value = panStartX.value + e.translationX;
      panY.value = panStartY.value + e.translationY;
    });

  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      scaleStart.value = scale.value;
    })
    .onUpdate((e) => {
      scale.value = Math.max(0.3, Math.min(2.5, scaleStart.value * e.scale));
    });

  const backgroundTap = Gesture.Tap().onEnd(() => {
    runOnJS(onSelectNode)(null);
  });

  const canvasGesture = Gesture.Simultaneous(
    Gesture.Race(panGesture, backgroundTap),
    pinchGesture,
  );

  const canvasStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: panX.value },
      { translateY: panY.value },
      { scale: scale.value },
    ],
  }));

  const resetView = useCallback(() => {
    panX.value = withTiming(0, { duration: 200 });
    panY.value = withTiming(0, { duration: 200 });
    scale.value = withTiming(1, { duration: 200 });
  }, [panX, panY, scale]);

  // ── Edge rendering ──────────────────────────────────────────────

  const edgePaths = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges
      .map((edge) => {
        const src = byId.get(edge.source);
        const tgt = byId.get(edge.target);
        if (!src || !tgt) return null;
        const srcMeta = NODE_META[src.type];
        const tgtMeta = NODE_META[tgt.type];
        const sHandles = srcMeta?.sourceHandles || ['out'];
        const tHandles = tgtMeta?.targetHandles || ['in'];
        const sIdx = sHandles.indexOf(edge.sourceHandle || 'out');
        const tIdx = tHandles.indexOf(edge.targetHandle || 'in');
        const sFrac = ((sIdx >= 0 ? sIdx : 0) + 1) / (sHandles.length + 1);
        const tFrac = ((tIdx >= 0 ? tIdx : 0) + 1) / (tHandles.length + 1);
        const x1 = src.position.x + NODE_WIDTH;
        const y1 = src.position.y + NODE_HEIGHT * sFrac;
        const x2 = tgt.position.x;
        const y2 = tgt.position.y + NODE_HEIGHT * tFrac;
        const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
        const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        return { id: edge.id, d };
      })
      .filter(Boolean) as { id: string; d: string }[];
  }, [nodes, edges]);

  // ── Bounding box for the SVG layer ──────────────────────────────

  const bounds = useMemo(() => {
    if (!nodes.length) {
      return { minX: 0, minY: 0, maxX: screenW, maxY: screenH };
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.position.y + NODE_HEIGHT);
    }
    return { minX, minY, maxX, maxY };
  }, [nodes, screenW, screenH]);

  const canvasW = Math.max(screenW * 2, bounds.maxX - bounds.minX + 500);
  const canvasH = Math.max(screenH * 2, bounds.maxY - bounds.minY + 500);

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.viewport}>
        <GestureDetector gesture={canvasGesture}>
          <Animated.View
            style={[styles.canvas, { width: canvasW, height: canvasH }, canvasStyle]}
          >
            {/* Background dots */}
            <Svg width={canvasW} height={canvasH} style={StyleSheet.absoluteFillObject as any}>
              <Defs>
                <LinearGradient id="edgeGrad" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor={colors.primary} stopOpacity="0.9" />
                  <Stop offset="1" stopColor={colors.primaryEnd} stopOpacity="0.9" />
                </LinearGradient>
              </Defs>
              <G>
                {edgePaths.map((e) => (
                  <Path
                    key={e.id}
                    d={e.d}
                    stroke="url(#edgeGrad)"
                    strokeWidth={2}
                    fill="none"
                  />
                ))}
              </G>
            </Svg>
            {nodes.map((node) => (
              <NativeNode
                key={node.id}
                node={node}
                status={nodeStatuses[node.id] || 'idle'}
                selected={node.id === selectedNodeId}
                connecting={
                  connectFrom !== null && connectFrom.nodeId === node.id
                }
                onSelect={onSelectNode}
                onPositionChanged={onNodePositionChanged}
                onHandleTap={onHandleTap}
              />
            ))}
          </Animated.View>
        </GestureDetector>
      </View>

      {/* Reset button floats bottom-right of the canvas */}
      <View style={styles.resetBar} pointerEvents="box-none">
        <View style={styles.resetBtnWrap}>
          <Text onPress={resetView} style={styles.resetBtn}>
            Reset view
          </Text>
        </View>
      </View>
    </GestureHandlerRootView>
  );
}

// ── Individual node ─────────────────────────────────────────────────

const STATUS_COLOR: Record<NodeStatus, string> = {
  idle: 'transparent',
  running: '#CC8020',
  success: '#15885E',
  failed: '#C94A43',
};

function NativeNode({
  node,
  status,
  selected,
  connecting,
  onSelect,
  onPositionChanged,
  onHandleTap,
}: {
  node: WorkflowNode;
  status: NodeStatus;
  selected: boolean;
  connecting: boolean;
  onSelect: (id: string | null) => void;
  onPositionChanged: (id: string, pos: { x: number; y: number }) => void;
  onHandleTap: (nodeId: string, handle: string, kind: 'source' | 'target') => void;
}) {
  const meta = NODE_META[node.type];
  const x = useSharedValue(node.position.x);
  const y = useSharedValue(node.position.y);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  // Keep shared values in sync when parent replaces the node.
  useEffect(() => {
    x.value = node.position.x;
    y.value = node.position.y;
  }, [node.position.x, node.position.y]);

  const dragGesture = Gesture.Pan()
    .activateAfterLongPress(180)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((e) => {
      x.value = startX.value + e.translationX;
      y.value = startY.value + e.translationY;
    })
    .onEnd(() => {
      // Snap to grid for visual tidiness.
      const snappedX = Math.round(x.value / GRID_SIZE) * GRID_SIZE;
      const snappedY = Math.round(y.value / GRID_SIZE) * GRID_SIZE;
      x.value = snappedX;
      y.value = snappedY;
      runOnJS(onPositionChanged)(node.id, { x: snappedX, y: snappedY });
    });

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(onSelect)(node.id);
  });

  const nodeGesture = Gesture.Race(dragGesture, tapGesture);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));

  if (!meta) return null;
  const sHandles = meta.sourceHandles;
  const tHandles = meta.targetHandles;
  const preview = meta.preview(node.config || {});

  return (
    <GestureDetector gesture={nodeGesture}>
      <Animated.View
        style={[
          styles.nodeCard,
          {
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            borderColor: selected ? colors.primary : colors.border,
            borderWidth: selected ? 2 : 1,
            backgroundColor: colors.surface,
          },
          connecting && styles.nodeCardConnecting,
          animStyle,
        ]}
      >
        <View style={styles.nodeHeader}>
          <Feather name={meta.icon as any} size={12} color={colors.primary} />
          <Text style={styles.nodeTypeLabel}>{node.type}</Text>
          {status !== 'idle' && (
            <View
              style={[
                styles.statusDot,
                { backgroundColor: STATUS_COLOR[status] },
              ]}
            />
          )}
        </View>
        <View style={styles.nodeBody}>
          <Text style={styles.nodeLabel} numberOfLines={1}>
            {node.label || meta.label}
          </Text>
          <Text style={styles.nodePreview} numberOfLines={2}>
            {preview}
          </Text>
        </View>

        {/* Target handles on the left edge */}
        {tHandles.map((h, i) => {
          const top = ((i + 1) / (tHandles.length + 1)) * NODE_HEIGHT;
          return (
            <Text
              key={`t-${h}`}
              onPress={() => onHandleTap(node.id, h, 'target')}
              style={[
                styles.handle,
                styles.targetHandle,
                { top: top - HANDLE_RADIUS, left: -HANDLE_RADIUS },
              ]}
            >
              ●
            </Text>
          );
        })}

        {/* Source handles on the right edge (with handle name label
            so users can see which outlet is which) */}
        {sHandles.map((h, i) => {
          const top = ((i + 1) / (sHandles.length + 1)) * NODE_HEIGHT;
          return (
            <View
              key={`s-${h}`}
              style={[
                styles.sourceWrap,
                { top: top - HANDLE_RADIUS, right: -HANDLE_RADIUS },
              ]}
              pointerEvents="box-none"
            >
              <Text
                onPress={() => onHandleTap(node.id, h, 'source')}
                style={[
                  styles.handle,
                  styles.sourceHandle,
                  connecting && styles.sourceHandleActive,
                ]}
              >
                ●
              </Text>
              {sHandles.length > 1 && (
                <Text style={styles.handleLabel}>{h}</Text>
              )}
            </View>
          );
        })}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  viewport: {
    flex: 1,
    overflow: 'hidden',
  },
  canvas: {
    position: 'absolute',
    backgroundColor: colors.bg,
  },
  resetBar: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  resetBtnWrap: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  resetBtn: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '500',
    fontFamily: font.sans,
  },
  nodeCard: {
    position: 'absolute',
    borderRadius: radius.lg,
    shadowColor: 'rgba(26, 25, 21, 0.1)',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  nodeCardConnecting: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  nodeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    gap: 5,
  },
  nodeTypeLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.primary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    flex: 1,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  nodeBody: { padding: 8 },
  nodeLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.1,
    marginBottom: 2,
  },
  nodePreview: {
    fontSize: 11,
    color: colors.textSecondary,
    fontFamily: font.mono,
    lineHeight: 14,
  },
  handle: {
    width: HANDLE_RADIUS * 2,
    height: HANDLE_RADIUS * 2,
    borderRadius: HANDLE_RADIUS,
    textAlign: 'center',
    lineHeight: HANDLE_RADIUS * 2 - 2,
    fontSize: 8,
    color: 'transparent',
    overflow: 'hidden',
  },
  targetHandle: {
    position: 'absolute',
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.border,
  },
  sourceWrap: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
  },
  sourceHandle: {
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  sourceHandleActive: {
    backgroundColor: colors.primary,
  },
  handleLabel: {
    marginLeft: 2,
    fontSize: 9,
    color: colors.textMuted,
    fontFamily: font.mono,
    backgroundColor: colors.bg,
    paddingHorizontal: 3,
    borderRadius: 3,
  },
});
