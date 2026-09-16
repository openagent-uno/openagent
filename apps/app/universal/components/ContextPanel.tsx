/**
 * ContextPanel — an always-visible, realtime context-window gauge, mounted
 * top-right of the chat screen (and inside run screens). It renders the same
 * Claude-Code ``/context`` composition the CLI and chat channels show: a
 * stacked overview bar of section shares (system prompt / tools+MCP /
 * messages / summary / free) against the model's context window, followed by
 * a per-section breakdown — each category gets its own labelled progress bar
 * with its token count and percentage on their own line — plus the cumulative
 * session cost.
 *
 * Floating, the card shows the percentage and the stacked bar, and opens the
 * breakdown on tap: it is an overlay, and an always-open 264x760 card sits on
 * top of whatever the transcript is showing (measured on a generated image, it
 * covered a third of the picture). Inline it stays fully open — nothing is
 * underneath it there. The header show/hide toggle
 * (``useUI.contextPanelVisible``) dismisses it entirely.
 *
 * Data source is ``ChatSession.contextUsage`` (a ``SessionContext``), fed by
 * the ``context_report`` push frame each turn and by the
 * ``GET /api/sessions/{id}/context`` fetch on activation/reconcile (see
 * stores/chat.ts). Because every session kind — chat, sub-agent, scheduled
 * firing, workflow AI node — surfaces on the same session-bound screen, one
 * mount of this panel serves all of them.
 */

import { memo, useState } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import type { SessionContext } from '../../common/types';
import { colors, radius, font, glassSurface } from '../theme';
import { useLayout } from '../hooks/useLayout';
import { useUI } from '../stores/ui';

/** Stable per-section colors (keys mirror the server's section ``key``).
 *  ``free`` uses a muted rail so the filled portion reads as "used". */
const SECTION_COLOR: Record<string, string> = {
  system: colors.primary,
  tools: '#A78BFF',
  messages: colors.success,
  summary: colors.warning,
  free: colors.mutedSoft,
};

function sectionColor(key: string): string {
  return SECTION_COLOR[key] ?? colors.textMuted;
}

/** Compact token count: 1234 → 1.2k, 1_200_000 → 1.2M. */
function fmtTokens(n: number | undefined): string {
  const v = Math.max(0, Math.round(n ?? 0));
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtCost(v: number | null | undefined): string {
  const n = v ?? 0;
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** The stacked share bar — one flex segment per section, widths ∝ pct. */
function StackedBar({ ctx, height = 9 }: { ctx: SessionContext; height?: number }) {
  const window = ctx.context_window || 0;
  return (
    <View style={[styles.bar, { height, borderRadius: height }]}>
      {ctx.sections.map((s) => {
        const share = window > 0 ? Math.max(0, s.tokens) / window : 0;
        if (share <= 0) return null;
        return (
          <View
            key={s.key}
            style={{ flexGrow: share, flexBasis: 0, backgroundColor: sectionColor(s.key) }}
          />
        );
      })}
    </View>
  );
}

export interface ContextPanelProps {
  context?: SessionContext;
  /** Presentation: 'floating' pins it top-right over the chat transcript;
   *  'inline' drops it into a run/detail header as an ordinary block. */
  variant?: 'floating' | 'inline';
  /** Extra top offset for the floating variant (e.g. the header inset). */
  topInset?: number;
  /** The legacy floating panel is governed by the persisted visibility
   *  preference. A containing surface such as the session-details drawer owns
   *  its own visibility and can opt out of that second gate. */
  respectVisibilityPreference?: boolean;
}

const ContextPanel = memo(function ContextPanel({
  context, variant = 'floating', topInset = 0,
  respectVisibilityPreference = true,
}: ContextPanelProps) {
  const { isPhone } = useLayout();
  const visible = useUI((s) => s.contextPanelVisible);
  // Every hook runs before any early return below — React counts them per
  // render, so a hook placed after "if (!visible) return null" would change
  // the count the moment the user hid the panel.
  const [expanded, setExpanded] = useState(false);

  // Hidden by the user's toggle (chat header menu / run screen) → render
  // nothing regardless of data.
  if (respectVisibilityPreference && !visible) return null;
  // No data yet (brand-new session before its first turn) → render nothing so
  // the panel never shows an empty frame.
  if (!context || !context.context_window || !context.sections?.length) return null;

  const usedPct = context.used_pct ?? 0;
  const model = context.model_label || context.model || 'model';
  const estimated = context.window_source === 'fallback';

  const summaryRow = (
    <View style={styles.summaryRow}>
      <Feather name="pie-chart" size={15} color={colors.primary} />
      <Text style={styles.pctText}>{usedPct.toFixed(usedPct < 10 ? 1 : 0)}%</Text>
      <Text style={styles.usedText} numberOfLines={1}>
        {fmtTokens(context.used_tokens)}
        <Text style={styles.mutedText}> / {fmtTokens(context.context_window)}</Text>
      </Text>
    </View>
  );

  // The breakdown: one block per section — label on its own line, a
  // per-category progress bar (filled to that section's share of the window),
  // then its token count and percentage wrapped onto their own line below.
  // Floating, it waits for a tap (see the module docstring).
  const detail = (
    <View style={styles.detail}>
      <View style={styles.modelRow}>
        <Text style={styles.modelText} numberOfLines={1}>{model}</Text>
        {estimated ? <Text style={styles.estBadge}>est.</Text> : null}
      </View>
      {context.sections.map((s) => {
        const pct = Math.max(0, Math.min(100, s.pct ?? 0));
        const tint = sectionColor(s.key);
        return (
          <View key={s.key} style={styles.legendRow}>
            <View style={styles.legendHead}>
              <View style={[styles.dot, { backgroundColor: tint }]} />
              <Text style={styles.legendLabel} numberOfLines={1}>{s.label}</Text>
            </View>
            <View style={styles.legendBar}>
              <View style={[styles.legendFill, { width: `${pct}%`, backgroundColor: tint }]} />
            </View>
            <View style={styles.legendNums}>
              <Text style={styles.legendTokens}>{fmtTokens(s.tokens)} tokens</Text>
              <Text style={styles.legendPct}>{pct.toFixed(1)}%</Text>
            </View>
          </View>
        );
      })}
      {(context.cost_usd != null && context.cost_usd > 0) || (context.measured_input_tokens ?? 0) > 0 ? (
        <View style={styles.footer}>
          {context.cost_usd != null && context.cost_usd > 0 ? (
            <Text style={styles.footText}>
              <Feather name="dollar-sign" size={10} color={colors.textMuted} />{' '}
              {fmtCost(context.cost_usd)} session
            </Text>
          ) : null}
          {(context.measured_input_tokens ?? 0) > 0 ? (
            <Text style={styles.footText}>{fmtTokens(context.measured_input_tokens)} last turn</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const card = (
    <View
      style={[
        styles.card,
        variant === 'floating' && styles.floatingCard,
        variant === 'inline' && styles.inlineCard,
        Platform.OS === 'web' ? ({ backdropFilter: glassSurface.webFilter, WebkitBackdropFilter: glassSurface.webFilter } as any) : null,
      ]}
      // @ts-ignore — web entrance animation
      {...(Platform.OS === 'web' ? { className: 'oa-msg-in' } : {})}
    >
      {variant === 'floating' ? (
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Collapse context details' : 'Expand context details'}
          style={styles.summaryPress}
        >
          <View style={styles.summaryPressInner}>{summaryRow}</View>
          <Feather
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={colors.textMuted}
          />
        </Pressable>
      ) : summaryRow}
      <StackedBar ctx={context} />
      {variant === 'inline' || expanded ? detail : null}
    </View>
  );

  if (variant === 'inline') return card;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.floatWrap, { top: topInset + 8, right: isPhone ? 8 : 14 }]}
    >
      {card}
    </View>
  );
});

export default ContextPanel;

const styles = StyleSheet.create({
  summaryPress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  summaryPressInner: {
    flex: 1,
  },
  floatWrap: {
    position: 'absolute',
    zIndex: 6,
    alignItems: 'flex-end',
  },
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 13,
    paddingHorizontal: 15,
    gap: 11,
  },
  floatingCard: {
    width: 264,
    maxWidth: '92%',
    // Soft drop so it lifts off the transcript.
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 20,
    elevation: 5,
  },
  inlineCard: {
    alignSelf: 'stretch',
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pctText: {
    color: colors.primary,
    fontSize: 17,
    fontWeight: '700',
    fontFamily: font.mono,
  },
  usedText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13,
    fontFamily: font.mono,
    textAlign: 'right',
  },
  mutedText: { color: colors.textMuted },
  bar: {
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: colors.mutedSoft,
  },
  detail: {
    gap: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  modelText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11.5,
    fontFamily: font.mono,
    textTransform: 'none',
  },
  estBadge: {
    color: colors.warning,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  // One section = a vertical block: label line, its own progress bar, then the
  // numbers wrapped onto their own line beneath.
  legendRow: { gap: 6 },
  legendHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  legendLabel: { flex: 1, color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  legendBar: {
    height: 6,
    borderRadius: 6,
    backgroundColor: colors.mutedSoft,
    overflow: 'hidden',
  },
  legendFill: { height: '100%', borderRadius: 6 },
  legendNums: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  legendTokens: {
    color: colors.text,
    fontSize: 12,
    fontFamily: font.mono,
  },
  legendPct: {
    color: colors.textMuted,
    fontSize: 12,
    fontFamily: font.mono,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
    paddingTop: 9,
    marginTop: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  footText: { color: colors.textMuted, fontSize: 11.5, fontFamily: font.mono },
});
