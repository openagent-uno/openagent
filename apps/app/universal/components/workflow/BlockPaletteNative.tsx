/**
 * BlockPaletteNative — bottom-sheet variant of the block palette
 * for touch devices. Opens from the bottom edge, shows block types
 * grouped by category. Tap a chip → the editor inserts a node at
 * the center of the current viewport (dragging from the palette is
 * unreliable on touch).
 */

import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, font, radius } from '../../theme';
import type { BlockType } from '../../../common/types';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  NODE_META,
  type NativeNodeMeta,
} from './nodes-native/nodeMeta';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (type: BlockType) => void;
}

export default function BlockPaletteNative({ open, onClose, onPick }: Props) {
  const [filter, setFilter] = useState<NativeNodeMeta['category'] | 'all'>('all');

  const items = useMemo(() => {
    const all = Object.values(NODE_META);
    if (filter === 'all') return all;
    return all.filter((m) => m.category === filter);
  }, [filter]);

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <Text style={styles.title}>Add a block</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Feather name="x" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <FilterChip
            label="All"
            active={filter === 'all'}
            onPress={() => setFilter('all')}
          />
          {CATEGORY_ORDER.map((cat) => (
            <FilterChip
              key={cat}
              label={CATEGORY_LABEL[cat]}
              active={filter === cat}
              onPress={() => setFilter(cat)}
            />
          ))}
        </ScrollView>

        <ScrollView style={styles.list}>
          {items.map((meta) => (
            <TouchableOpacity
              key={meta.type}
              onPress={() => {
                onPick(meta.type);
                onClose();
              }}
              style={styles.row}
            >
              <View style={styles.iconWrap}>
                <Feather
                  name={meta.icon as any}
                  size={14}
                  color={colors.primary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>{meta.label}</Text>
                <Text style={styles.rowType}>{meta.type}</Text>
              </View>
              <Feather name="plus" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.filterChip, active && styles.filterChipActive]}
    >
      <Text style={[styles.filterText, active && styles.filterTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(26, 25, 21, 0.25)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '75%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 20,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginTop: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    paddingBottom: 8,
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    fontFamily: font.display,
    letterSpacing: -0.2,
  },
  closeBtn: { padding: 4 },
  filterRow: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 6,
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: 6,
  },
  filterChipActive: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  filterText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted,
  },
  filterTextActive: { color: colors.primary },
  list: {
    maxHeight: 400,
    paddingHorizontal: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginBottom: 5,
  },
  iconWrap: {
    width: 26,
    height: 26,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  rowType: {
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: font.mono,
    marginTop: 2,
  },
});
