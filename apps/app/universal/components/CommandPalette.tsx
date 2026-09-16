/**
 * CommandPalette — Cmd/Ctrl+P quick switcher (web/desktop only).
 *
 * Modal overlay with a search field over a flat list of entries (chat
 * sessions today; could carry actions later). Fuzzy ranking is the
 * minimal "all query chars appear in order" filter plus a prefix bias
 * so typing the first few characters of a title floats it to the top.
 *
 * Open state is owned by the parent (chat.tsx) so the global Cmd+P
 * keydown handler can toggle without prop-drilling.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, font, radius, glassSurface } from '../theme';

export interface PaletteEntry {
  id: string;
  /** Headline shown bold. */
  title: string;
  /** Optional muted secondary line (e.g. preview). */
  subtitle?: string;
  /** Optional left-side glyph (Feather name). */
  icon?: string;
  /** Pinned items are floated to the top when the query is empty. */
  pinned?: boolean;
  onSelect: () => void;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  entries: PaletteEntry[];
  placeholder?: string;
}

function rank(entry: PaletteEntry, q: string): number | null {
  if (!q) return entry.pinned ? -1 : 0;
  const hay = (entry.title + ' ' + (entry.subtitle ?? '')).toLowerCase();
  const query = q.toLowerCase();
  if (hay.includes(query)) {
    // Bonus for prefix match on title — feels like ChatGPT's switcher.
    return entry.title.toLowerCase().startsWith(query) ? -10 : -5;
  }
  // Subsequence fallback: all chars appear in order.
  let hi = 0;
  for (let i = 0; i < query.length; i += 1) {
    const j = hay.indexOf(query[i], hi);
    if (j < 0) return null;
    hi = j + 1;
  }
  return hi;
}

function CommandPaletteBase({ visible, onClose, entries, placeholder = 'Switch session…' }: Props) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset on each open.
  useEffect(() => {
    if (visible) {
      setQ('');
      setActive(0);
      // Defer so the focus lands after the element is in the DOM.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible]);

  const filtered = useMemo(() => {
    const scored: { e: PaletteEntry; s: number }[] = [];
    for (const e of entries) {
      const s = rank(e, q);
      if (s === null) continue;
      scored.push({ e, s });
    }
    return scored.sort((a, b) => a.s - b.s).map((x) => x.e).slice(0, 40);
  }, [entries, q]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);

  // Keyboard navigation inside the palette. We listen on window so the
  // events arrive before the input's default behavior swallows Enter.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = filtered[active];
        if (target) {
          target.onSelect();
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible, filtered, active, onClose]);

  if (!visible || Platform.OS !== 'web') return null;

  return (
    <View style={styles.scrim} pointerEvents="auto">
      <TouchableOpacity
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close palette"
        activeOpacity={1}
        {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
      />
      <View
        style={styles.panel}
        // @ts-ignore — web fade-in
        {...(Platform.OS === 'web' ? { className: 'oa-fade-in' } : {})}
      >
        <View style={styles.inputRow}>
          <Feather name="search" size={14} color={colors.textMuted} />
          {/* @ts-ignore — native HTML input for full keyboard control. */}
          <input
            ref={inputRef as any}
            value={q}
            onChange={(e: any) => setQ(e.target.value)}
            placeholder={placeholder}
            style={{
              flex: 1, border: 'none', outline: 'none',
              background: 'transparent', color: colors.text,
              fontFamily: font.sans, fontSize: 14, padding: '8px 0',
            } as any}
          />
          <Text style={styles.kbd}>ESC</Text>
        </View>
        <View style={styles.results}>
          {filtered.length === 0 ? (
            <Text style={styles.empty}>No matches.</Text>
          ) : (
            filtered.map((e, i) => (
              <TouchableOpacity
                key={e.id}
                style={[styles.row, i === active && styles.rowActive]}
                onPress={() => { e.onSelect(); onClose(); }}
                {...(Platform.OS === 'web' ? { onMouseEnter: () => setActive(i) } as any : {})}
              >
                {e.pinned && (
                  <Feather name="bookmark" size={10} color={colors.primary} />
                )}
                {!e.pinned && e.icon && (
                  <Feather name={e.icon as any} size={10} color={colors.textMuted} />
                )}
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{e.title}</Text>
                  {e.subtitle && (
                    <Text style={styles.rowSubtitle} numberOfLines={1}>{e.subtitle}</Text>
                  )}
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>
      </View>
    </View>
  );
}

export default memo(CommandPaletteBase);

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', paddingTop: 80,
    zIndex: 9999,
  },
  panel: {
    width: '92%', maxWidth: 540,
    // Shared frosted-glass recipe — matches the nav header exactly.
    backgroundColor: glassSurface.backgroundColor,
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1, shadowRadius: 24,
    overflow: 'hidden',
    // Frost the panel background only (the scrim just dims the scene).
    ...(Platform.OS === 'web'
      ? ({ backdropFilter: glassSurface.webFilter, WebkitBackdropFilter: glassSurface.webFilter } as any)
      : {}),
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  kbd: {
    fontSize: 9, color: colors.textMuted, fontFamily: font.mono,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.xs,
    paddingHorizontal: 4, paddingVertical: 1,
  },
  results: { maxHeight: 360, paddingVertical: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    marginHorizontal: 4, borderRadius: radius.sm,
  },
  rowActive: {
    backgroundColor: colors.hover,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 13, color: colors.text, fontWeight: '500' },
  rowSubtitle: {
    fontSize: 11, color: colors.textMuted, marginTop: 1,
  },
  empty: {
    fontSize: 12, color: colors.textMuted, padding: 16, textAlign: 'center',
  },
});
