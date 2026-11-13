/**
 * TurnRail — a column of dots beside the transcript, one per human turn.
 *
 * Dots of the signed-in account use the primary colour, other participants'
 * use the text colour. Hovering (or pressing and dragging on touch) previews
 * the prompt in a small popover; releasing/clicking jumps to it, loading the
 * surrounding page first when it is not in memory.
 *
 * The index comes from the compact turn endpoint, so the rail covers the
 * whole session without loading it. Rendering cost is bounded: when there
 * are more turns than fit at a legible spacing the rail draws one marker per
 * pixel bucket, while hover and press resolve to the exact turn under the
 * pointer.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import type { ChatMessage } from '../../../common/types';
import type { SessionTurn } from '../../../common/unified-history';
import { useSessionTurns } from '../../stores/sessionTurns';
import { colors, font, radius } from '../../theme';
import { useTranscriptObserved, type TranscriptController } from './TranscriptController';

/** Spacing between dots when every turn fits. */
const SPACING = 14;
/** Minimum spacing before markers are bucketed. */
const MIN_SPACING = 5;
/** Characters of a prompt shown in the popover. */
const PREVIEW_CHARS = 160;
const RAIL_WIDTH = 22;
const POPOVER_WIDTH = 264;
const WEB_POINTER = { cursor: 'pointer' } as object;

interface RailTurn {
  id: string;
  ordinal?: number;
  own: boolean;
  author?: string;
  preview: string;
  timestamp?: number;
}

function fromIndex(turn: SessionTurn): RailTurn {
  const parsed = turn.created_at ? Date.parse(turn.created_at) : NaN;
  return {
    id: turn.message_id,
    ordinal: turn.ordinal,
    own: turn.own,
    author: turn.author.display || turn.author.handle || undefined,
    preview: turn.preview,
    timestamp: Number.isFinite(parsed) ? parsed : undefined,
  };
}

const isHumanPrompt = (message: ChatMessage) => message.role === 'user' && message.author?.kind !== 'agent';

function fromMessage(message: ChatMessage, currentUserHandle?: string): RailTurn {
  const handle = message.author?.handle;
  return {
    id: message.id,
    ordinal: message.ordinal,
    own: !handle || !currentUserHandle || handle === currentUserHandle,
    author: message.author?.display || handle,
    preview: message.text.replace(/\s+/g, ' ').trim(),
    timestamp: message.timestamp || undefined,
  };
}

function clip(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : text;
}

interface Props {
  sessionId: string;
  messages: readonly ChatMessage[];
  controller: TranscriptController;
  currentUserHandle?: string;
}

function TurnRail({ sessionId, messages, controller, currentUserHandle }: Props) {
  const index = useSessionTurns((state) => state.bySession[sessionId]);
  const ensure = useSessionTurns((state) => state.ensure);
  const refresh = useSessionTurns((state) => state.refresh);
  const activeId = useTranscriptObserved(controller, 'activeTurnId');

  useEffect(() => { ensure(sessionId); }, [ensure, sessionId]);

  const indexed = index?.turns;
  const lastOrdinal = indexed?.at(-1)?.ordinal ?? -1;
  const unsupported = index?.status === 'unsupported';

  // Prompts newer than the index: live/optimistic rows (no ordinal yet) and
  // canonical rows the index has not fetched. Scans back from the tail only.
  const { recent, newestCanonical } = useMemo(() => {
    const found: ChatMessage[] = [];
    let newest = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.ordinal != null && message.ordinal <= lastOrdinal && !unsupported) break;
      if (!isHumanPrompt(message)) continue;
      found.push(message);
      if (message.ordinal != null) newest = Math.max(newest, message.ordinal);
    }
    return { recent: found.reverse(), newestCanonical: newest };
  }, [messages, lastOrdinal, unsupported]);

  useEffect(() => {
    if (newestCanonical > lastOrdinal && index?.status !== 'loading') refresh(sessionId);
  }, [newestCanonical, lastOrdinal, index?.status, refresh, sessionId]);

  const turns = useMemo<RailTurn[]>(() => {
    const base = unsupported ? [] : (indexed ?? []).map(fromIndex);
    const known = new Set(base.map((turn) => turn.id));
    for (const message of recent) {
      if (!known.has(message.id)) base.push(fromMessage(message, currentUserHandle));
    }
    return base;
  }, [indexed, recent, unsupported, currentUserHandle]);

  const [height, setHeight] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const pressing = useRef(false);

  const count = turns.length;
  const layout = useMemo(() => {
    if (!height || count < 2) return null;
    const natural = (count - 1) * SPACING;
    if (natural <= height) {
      const offset = (height - natural) / 2;
      return { offset, span: natural, markers: count, compressed: false };
    }
    const markers = Math.max(2, Math.min(count, Math.floor(height / MIN_SPACING) + 1));
    return { offset: 0, span: height, markers, compressed: markers < count };
  }, [height, count]);

  const indexAt = (y: number): number | null => {
    if (!layout) return null;
    const ratio = layout.span ? (y - layout.offset) / layout.span : 0;
    return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
  };
  const yOf = (turnIndex: number): number => (
    layout ? layout.offset + (count > 1 ? (turnIndex / (count - 1)) * layout.span : 0) : 0
  );

  const activeIndex = useMemo(() => (activeId ? turns.findIndex((turn) => turn.id === activeId) : -1), [turns, activeId]);

  const markers = useMemo(() => {
    if (!layout) return [];
    const out: { key: string; y: number; own: boolean; from: number; to: number }[] = [];
    if (!layout.compressed) {
      turns.forEach((turn, i) => out.push({ key: turn.id, y: layout.offset + i * (layout.span / Math.max(1, count - 1)), own: turn.own, from: i, to: i }));
      return out;
    }
    for (let bucket = 0; bucket < layout.markers; bucket += 1) {
      const from = Math.floor((bucket * count) / layout.markers);
      const to = Math.max(from, Math.floor(((bucket + 1) * count) / layout.markers) - 1);
      // A bucket takes the colour of most of the turns it stands for.
      let owned = 0;
      for (let i = from; i <= to; i += 1) if (turns[i].own) owned += 1;
      const own = owned * 2 >= to - from + 1;
      out.push({ key: `b${bucket}`, y: (bucket / (layout.markers - 1)) * layout.span, own, from, to });
    }
    return out;
  }, [layout, turns, count]);

  if (count < 2) return null;

  const hovered = hover != null ? turns[hover] : null;
  const jump = (turnIndex: number | null) => {
    const turn = turnIndex != null ? turns[turnIndex] : null;
    if (turn) controller.jumpTo(turn.id);
  };
  const locate = (event: GestureResponderEvent) => indexAt(event.nativeEvent.locationY);

  const webHover = Platform.OS === 'web' ? {
    onMouseMove: (event: { nativeEvent: { offsetY: number } }) => {
      if (!pressing.current) setHover(indexAt(event.nativeEvent.offsetY));
    },
    onMouseLeave: () => { if (!pressing.current) setHover(null); },
  } : {};

  const popoverTop = hovered && layout
    ? Math.max(-8, Math.min(height - 72, yOf(hover!) - 28))
    : 0;

  return (
    <View
      style={styles.rail}
      onLayout={(event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height)}
      pointerEvents="box-none"
    >
      <View
        style={[styles.hitArea, Platform.OS === 'web' && WEB_POINTER]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Conversation turns, ${count} prompts`}
        accessibilityValue={activeIndex >= 0 ? { min: 1, max: count, now: activeIndex + 1 } : undefined}
        onAccessibilityAction={(event) => {
          const current = activeIndex >= 0 ? activeIndex : count - 1;
          if (event.nativeEvent.actionName === 'increment') jump(Math.min(count - 1, current + 1));
          if (event.nativeEvent.actionName === 'decrement') jump(Math.max(0, current - 1));
        }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(event) => { pressing.current = true; setHover(locate(event)); }}
        onResponderMove={(event) => setHover(locate(event))}
        onResponderRelease={(event) => {
          pressing.current = false;
          const target = locate(event);
          jump(target);
          if (Platform.OS !== 'web') setHover(null);
        }}
        onResponderTerminate={() => { pressing.current = false; setHover(null); }}
        testID="oa-turn-rail"
        // @ts-ignore — RN-web forwards mouse events to the DOM node
        {...webHover}
      >
        {markers.map((marker) => {
          const active = activeIndex >= marker.from && activeIndex <= marker.to;
          const isHovered = hover != null && hover >= marker.from && hover <= marker.to;
          const size = isHovered ? 8 : active ? 7 : layout?.compressed ? 4 : 5;
          return (
            <View
              key={marker.key}
              pointerEvents="none"
              style={[
                styles.dot,
                {
                  top: marker.y - size / 2,
                  width: size, height: size, borderRadius: size / 2,
                  marginLeft: -size / 2,
                  backgroundColor: marker.own ? colors.primary : colors.text,
                  opacity: isHovered || active ? 1 : 0.42,
                },
              ]}
            />
          );
        })}
      </View>
      {hovered ? (
        <View pointerEvents="none" style={[styles.popover, { top: popoverTop }]} testID="oa-turn-rail-preview">
          <View style={styles.popoverHead}>
            <View style={[styles.popoverDot, { backgroundColor: hovered.own ? colors.primary : colors.text }]} />
            <Text style={styles.popoverAuthor} numberOfLines={1}>
              {hovered.own ? 'You' : hovered.author || 'Participant'}
            </Text>
            {hovered.timestamp ? (
              <Text style={styles.popoverTime} numberOfLines={1}>
                {new Date(hovered.timestamp).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </Text>
            ) : null}
            <Text style={styles.popoverCount}>{`${hover! + 1}/${count}`}</Text>
          </View>
          <Text style={styles.popoverText} numberOfLines={4}>
            {hovered.preview ? clip(hovered.preview) : 'Attachment'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default memo(TurnRail);

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    left: 4,
    top: 12,
    bottom: 12,
    width: RAIL_WIDTH,
    zIndex: 5,
  },
  hitArea: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: RAIL_WIDTH,
  },
  dot: {
    position: 'absolute',
    left: RAIL_WIDTH / 2,
  },
  popover: {
    position: 'absolute',
    left: RAIL_WIDTH + 6,
    width: POPOVER_WIDTH,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    backgroundColor: colors.panelBgSolid,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: colors.shadowColorStrong,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    gap: 4,
  },
  popoverHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  popoverDot: { width: 6, height: 6, borderRadius: 3 },
  popoverAuthor: {
    flexShrink: 1, color: colors.text, fontSize: 11, fontWeight: '600', fontFamily: font.sans,
  },
  popoverTime: { color: colors.textMuted, fontSize: 10, fontFamily: font.sans },
  popoverCount: {
    marginLeft: 'auto', color: colors.textMuted, fontSize: 10, fontFamily: font.mono,
  },
  popoverText: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, fontFamily: font.sans },
});
