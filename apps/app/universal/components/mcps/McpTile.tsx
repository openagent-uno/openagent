/**
 * McpTile — grid card for an installed MCP.
 *
 * Two rows of meta: the mono-cased name up top (the thing users actually
 * type into their agent), transport + source badges below. Toggling the
 * switch flips ``enabled`` in the DB; the pool hot-reloads on the next
 * message. Remove is only offered for ``kind === 'custom'`` — builtins
 * can be disabled but not deleted (the row is their control surface).
 */

import { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { MCPEntry } from '../../../common/types';
import { colors, font, radius } from '../../theme';
import ThemedSwitch from '../ThemedSwitch';

interface Props {
  entry: MCPEntry;
  onToggle: () => void;
  onRemove?: () => void;
  onPress?: () => void;
  style?: object;
}

function prettyRuntime(entry: MCPEntry): { label: string; icon: keyof typeof Feather.glyphMap } {
  if (entry.url) return { label: 'remote', icon: 'cloud' };
  if (entry.command && entry.command.length > 0) {
    const bin = (entry.command[0] || '').split('/').pop() || '';
    if (bin === 'npx') return { label: 'npx', icon: 'box' };
    if (bin === 'uvx') return { label: 'uvx', icon: 'box' };
    if (bin === 'docker') return { label: 'docker', icon: 'server' };
    if (bin === 'dnx') return { label: 'dnx', icon: 'box' };
    return { label: 'stdio', icon: 'terminal' };
  }
  return { label: 'in-proc', icon: 'cpu' };
}

function sourceLabel(entry: MCPEntry): { label: string; tone: 'builtin' | 'custom' | 'marketplace' } | null {
  if (entry.kind === 'builtin' || entry.kind === 'default') return { label: 'default', tone: 'builtin' };
  const src = (entry.source || '').toString();
  if (src.startsWith('marketplace:')) return { label: 'marketplace', tone: 'marketplace' };
  return { label: 'custom', tone: 'custom' };
}

export default function McpTile({ entry, onToggle, onRemove, onPress, style }: Props) {
  const runtime = useMemo(() => prettyRuntime(entry), [entry]);
  const src = useMemo(() => sourceLabel(entry), [entry]);
  const envCount = entry.env ? Object.keys(entry.env).length : 0;
  const subtitle = useMemo(() => {
    if (entry.url) return entry.url;
    if (entry.command && entry.command.length) return entry.command.slice(0, 3).join(' ');
    if (entry.builtin_name) return `builtin · ${entry.builtin_name}`;
    return '—';
  }, [entry]);

  // The whole tile is a pressable surface that opens the edit screen;
  // switches and remove buttons nested inside intercept their own taps
  // (RN's gesture system picks the deepest responder). The edit affordance
  // lives on the tile body — see ``styles.editHint`` in the footer.
  return (
    <TouchableOpacity
      activeOpacity={onPress ? 0.9 : 1}
      onPress={onPress}
      disabled={!onPress}
      style={[styles.tile, !entry.enabled && styles.tileDisabled, style]}
      accessibilityRole="button"
      accessibilityLabel={`Open connector ${entry.name}`}
      // @ts-ignore web-only class for subtle lift
      {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
    >
      {/* Status rail on the left edge — thin, colored when enabled. */}
      <View style={[styles.rail, entry.enabled ? styles.railOn : styles.railOff]} />

      <View style={styles.body}>
        <View style={styles.headRow}>
          <Text style={styles.name} numberOfLines={1}>{entry.name}</Text>
          <ThemedSwitch value={entry.enabled} onValueChange={onToggle} />
        </View>

        <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text>

        <View style={styles.badgesRow}>
          <View style={styles.badge}>
            <Feather name={runtime.icon} size={10} color={colors.textSecondary} />
            <Text style={styles.badgeText}>{runtime.label}</Text>
          </View>
          {src && (
            <View style={[styles.badge, src.tone === 'marketplace' && styles.badgeMarketplace]}>
              <Text style={[styles.badgeText, src.tone === 'marketplace' && styles.badgeTextMarketplace]}>
                {src.label}
              </Text>
            </View>
          )}
          {envCount > 0 && (
            <View style={styles.badge}>
              <Feather name="key" size={9} color={colors.textMuted} />
              <Text style={styles.badgeText}>{envCount}</Text>
            </View>
          )}
        </View>

        <View style={styles.footRow}>
          {onRemove ? (
            <TouchableOpacity onPress={onRemove} style={styles.remove} hitSlop={8} accessibilityRole="button">
              <Feather name="trash-2" size={12} color={colors.textMuted} />
              <Text style={styles.removeText}>Remove</Text>
            </TouchableOpacity>
          ) : <View />}
          {onPress && (
            <View style={styles.editHint}>
              <Text style={styles.editHintText}>Edit</Text>
              <Feather name="chevron-right" size={12} color={colors.textMuted} />
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tile: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    minHeight: 126,
  },
  tileDisabled: { opacity: 0.72 },
  rail: { width: 3 },
  railOn: { backgroundColor: colors.primary },
  railOff: { backgroundColor: colors.borderStrong },
  body: { flex: 1, padding: 14, gap: 8 },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  name: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    fontFamily: font.mono,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 11.5,
    color: colors.textSecondary,
    fontFamily: font.mono,
    lineHeight: 16,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 2,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.sidebar,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  badgeText: {
    fontSize: 9.5,
    color: colors.textSecondary,
    fontFamily: font.mono,
    textTransform: 'lowercase',
    letterSpacing: 0.3,
  },
  badgeMarketplace: {
    backgroundColor: colors.primarySoft,
    borderColor: 'transparent',
  },
  badgeTextMarketplace: {
    color: colors.primary,
    fontWeight: '600',
  },
  footRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  remove: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
  },
  removeText: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontWeight: '500',
  },
  editHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 3,
  },
  editHintText: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});
