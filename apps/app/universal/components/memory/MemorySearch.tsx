/**
 * Shared Memory search chrome.
 *
 * The graph dashboard and file viewer both open search below the frosted
 * header. Keeping the bar and results here prevents the two Memory surfaces
 * from drifting visually as the vault grows.
 */

import { useEffect, useRef } from 'react';
import Feather from '@expo/vector-icons/Feather';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { VaultNote } from '../../../common/types';
import { useLayout } from '../../hooks/useLayout';
import { colors, font, glassSurface, radius } from '../../theme';

interface MemorySearchBarProps {
  visible: boolean;
  query: string;
  onChangeQuery: (q: string) => void;
  placeholder: string;
  onClose: () => void;
  countLabel?: string;
  errorLabel?: string;
  onPrev?: () => void;
  onNext?: () => void;
  prevNextDisabled?: boolean;
  regexMode?: boolean;
  onToggleRegex?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function MemorySearchBar({
  visible,
  query,
  onChangeQuery,
  placeholder,
  onClose,
  countLabel,
  errorLabel,
  onPrev,
  onNext,
  prevNextDisabled = false,
  regexMode = false,
  onToggleRegex,
  style,
}: MemorySearchBarProps) {
  const { isPhone } = useLayout();
  const slideAnim = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const inputRef = useRef<TextInput>(null);
  const showStepper = !!onPrev && !!onNext;

  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: visible ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
    if (visible) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible, slideAnim]);

  if (!visible) return null;

  const translateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-48, 0],
  });

  return (
    <Animated.View
      style={[
        styles.searchBar,
        isPhone ? styles.searchBarPhone : styles.searchBarWide,
        { transform: [{ translateY }], opacity: slideAnim },
        style,
      ]}
    >
      <Feather name="search" size={14} color={colors.textMuted} style={styles.leadingIcon} />
      <TextInput
        ref={inputRef}
        value={query}
        onChangeText={onChangeQuery}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        style={[
          styles.searchInput,
          Platform.OS === 'web' ? ({ outline: 'none', border: 'none' } as any) : null,
        ]}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="search"
      />
      {(errorLabel || countLabel) ? (
        <View style={styles.matchInfo}>
          <Text style={[styles.matchText, errorLabel && styles.matchError]} numberOfLines={1}>
            {errorLabel || countLabel}
          </Text>
        </View>
      ) : null}
      {showStepper ? (
        <>
          <Pressable
            onPress={onPrev}
            disabled={prevNextDisabled}
            hitSlop={6}
            style={({ pressed }) => [
              styles.iconBtn,
              pressed && { backgroundColor: colors.hover },
            ]}
            accessibilityLabel="Previous match"
          >
            <Feather
              name="chevron-up"
              size={14}
              color={prevNextDisabled ? colors.textMuted : colors.text}
            />
          </Pressable>
          <Pressable
            onPress={onNext}
            disabled={prevNextDisabled}
            hitSlop={6}
            style={({ pressed }) => [
              styles.iconBtn,
              pressed && { backgroundColor: colors.hover },
            ]}
            accessibilityLabel="Next match"
          >
            <Feather
              name="chevron-down"
              size={14}
              color={prevNextDisabled ? colors.textMuted : colors.text}
            />
          </Pressable>
        </>
      ) : null}
      {onToggleRegex ? (
        <Pressable
          onPress={onToggleRegex}
          hitSlop={6}
          style={({ pressed }) => [
            styles.regexBtn,
            regexMode && styles.regexBtnActive,
            pressed && { backgroundColor: colors.hover },
          ]}
          accessibilityLabel="Toggle regex"
        >
          <Text style={[styles.regexLabel, regexMode && styles.regexLabelActive]}>.*</Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={onClose}
        hitSlop={6}
        style={({ pressed }) => [
          styles.iconBtn,
          styles.closeBtn,
          pressed && { backgroundColor: colors.hover },
        ]}
        accessibilityLabel="Close search"
      >
        <Feather name="x" size={14} color={colors.textMuted} />
      </Pressable>
    </Animated.View>
  );
}

interface MemorySearchResultsProps {
  query: string;
  results: VaultNote[];
  onSelect: (path: string) => void;
  onClear: () => void;
  style?: StyleProp<ViewStyle>;
}

export function MemorySearchResults({
  query,
  results,
  onSelect,
  onClear,
  style,
}: MemorySearchResultsProps) {
  const { isPhone } = useLayout();

  useEffect(() => {
    if (Platform.OS !== 'web' || !query.trim()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClear();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [query, onClear]);

  if (!query.trim()) return null;

  const maxVisible = 15;
  const visible = results.slice(0, maxVisible);
  const hidden = results.length - visible.length;

  return (
    <View
      style={[
        styles.resultsPanel,
        isPhone ? styles.resultsPanelPhone : styles.resultsPanelWide,
        style,
      ]}
    >
      <View style={styles.resultsHeader}>
        <Text style={styles.resultsCount}>
          {results.length} result{results.length === 1 ? '' : 's'}
        </Text>
      </View>
      <ScrollView
        style={styles.resultsList}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {visible.length === 0 ? (
          <Text style={styles.emptyResult}>No matching notes</Text>
        ) : (
          visible.map((note) => (
            <Pressable
              key={note.path}
              onPress={() => {
                onSelect(note.path);
                onClear();
              }}
              style={({ pressed }) => [
                styles.resultRow,
                pressed && styles.resultRowPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Open ${note.title || note.path}`}
              // @ts-ignore web hover
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
            >
              <View style={styles.resultIcon}>
                <Feather name="file-text" size={13} color={colors.textSecondary} />
              </View>
              <View style={styles.resultMain}>
                <Text style={styles.resultTitle} numberOfLines={1}>
                  {note.title || note.path.split('/').pop()?.replace('.md', '') || note.path}
                </Text>
                <Text style={styles.resultPath} numberOfLines={1}>{note.path}</Text>
                {note.tags && note.tags.length > 0 ? (
                  <View style={styles.tagRow}>
                    {note.tags.slice(0, 3).map((tag) => (
                      <View key={tag} style={styles.tagChip}>
                        <Text style={styles.tagText} numberOfLines={1}>{tag}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
              <Feather name="chevron-right" size={15} color={colors.textMuted} />
            </Pressable>
          ))
        )}
        {hidden > 0 ? (
          <Text style={styles.moreText}>+{hidden} more - refine your search</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const SEARCH_MAX_WIDTH = 560;

const styles = StyleSheet.create({
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
    paddingVertical: 3,
    borderRadius: radius.md,
    backgroundColor: glassSurface.backgroundColor,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.42,
    shadowRadius: 12,
    elevation: 6,
    ...(Platform.OS === 'web'
      ? ({
          backdropFilter: glassSurface.webFilter,
          WebkitBackdropFilter: glassSurface.webFilter,
        } as any)
      : {}),
  },
  searchBarWide: {
    width: '100%',
    maxWidth: SEARCH_MAX_WIDTH,
    alignSelf: 'center',
    marginTop: 2,
    marginBottom: 2,
  },
  searchBarPhone: {
    alignSelf: 'stretch',
    marginHorizontal: 10,
    marginTop: 2,
    marginBottom: 2,
  },
  leadingIcon: { marginLeft: 8 },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: 28,
    paddingHorizontal: 8,
    fontSize: 13,
    fontFamily: font.sans,
    color: colors.text,
    backgroundColor: 'transparent',
  },
  matchInfo: {
    paddingHorizontal: 6,
    minWidth: 48,
    alignItems: 'center',
  },
  matchText: {
    fontSize: 11,
    fontFamily: font.mono,
    color: colors.textMuted,
  },
  matchError: {
    color: colors.error,
    fontWeight: '600',
  },
  iconBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
  },
  closeBtn: { marginRight: 2 },
  regexBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  regexBtnActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  regexLabel: {
    fontSize: 11,
    fontFamily: font.mono,
    fontWeight: '700',
    color: colors.textMuted,
  },
  regexLabelActive: { color: colors.primary },

  resultsPanel: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 8,
    maxHeight: 360,
    overflow: 'hidden',
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.54,
    shadowRadius: 16,
    elevation: 8,
    ...(Platform.OS === 'web'
      ? ({
          backdropFilter: glassSurface.webFilter,
          WebkitBackdropFilter: glassSurface.webFilter,
        } as any)
      : {}),
  },
  resultsPanelWide: {
    width: '100%',
    maxWidth: SEARCH_MAX_WIDTH,
    alignSelf: 'center',
  },
  resultsPanelPhone: {
    alignSelf: 'stretch',
    marginHorizontal: 10,
  },
  resultsHeader: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  resultsCount: {
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: font.mono,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  resultsList: { maxHeight: 320 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  resultRowPressed: { backgroundColor: colors.hover },
  resultIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mutedSoft,
  },
  resultMain: { flex: 1, minWidth: 0 },
  resultTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    fontFamily: font.sans,
  },
  resultPath: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontFamily: font.mono,
    marginTop: 2,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 5,
  },
  tagChip: {
    maxWidth: 120,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.xs,
    backgroundColor: colors.mutedSoft,
  },
  tagText: {
    fontSize: 9.5,
    color: colors.textSecondary,
    fontFamily: font.mono,
  },
  emptyResult: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
    padding: 14,
    textAlign: 'center',
  },
  moreText: {
    color: colors.textMuted,
    fontSize: 11,
    padding: 12,
    textAlign: 'center',
    fontFamily: font.mono,
  },
});
