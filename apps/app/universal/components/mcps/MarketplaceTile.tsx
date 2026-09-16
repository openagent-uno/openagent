/**
 * MarketplaceTile — grid card for a server returned by the MCP registry.
 *
 * Shows the registry name (mono) and a friendlier title (sans) — many
 * registry entries carry both. If the server is already installed
 * locally the card shows an "Installed" stamp instead of the primary
 * Install button; the match is done upstream by comparing the ``source``
 * column against ``marketplace:registry.modelcontextprotocol.io/{name}@``.
 */

import { View, Text, StyleSheet, Platform } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { MarketplaceCard } from '../../services/api';
import { colors, font, radius } from '../../theme';
import Button from '../Button';

interface Props {
  card: MarketplaceCard;
  installed: boolean;
  onInstall: () => void;
  style?: object;
}

export default function MarketplaceTile({ card, installed, onInstall, style }: Props) {
  const hasDistinctTitle = !!(card.title && card.title !== card.name);

  return (
    <View
      style={[styles.tile, style]}
      // @ts-ignore web hover lift
      {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
    >
      <View style={styles.content}>
        {hasDistinctTitle && (
          <Text style={styles.title} numberOfLines={1}>{card.title}</Text>
        )}
        <Text
          style={[styles.registryName, !hasDistinctTitle && styles.registryNamePrimary]}
          numberOfLines={1}
        >
          {card.name}
        </Text>

        {card.description ? (
          <Text style={styles.description} numberOfLines={3}>{card.description}</Text>
        ) : (
          <Text style={[styles.description, styles.descriptionDim]}>No description provided.</Text>
        )}

        <View style={styles.metaRow}>
          {card.version && (
            <View style={styles.versionChip}>
              <Text style={styles.versionText}>v{card.version}</Text>
            </View>
          )}
          {card.status && card.status !== 'active' && (
            <View style={[styles.versionChip, styles.statusChip]}>
              <Text style={[styles.versionText, styles.statusText]}>{card.status}</Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.footer}>
        {installed ? (
          <View style={styles.installedStamp}>
            <Feather name="check-circle" size={12} color={colors.success} />
            <Text style={styles.installedText}>Installed</Text>
          </View>
        ) : (
          <Button
            variant="primary"
            size="sm"
            label="Install"
            icon="plus"
            iconPosition="right"
            onPress={onInstall}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    minHeight: 170,
    justifyContent: 'space-between',
  },
  content: { padding: 14, gap: 6 },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    fontFamily: font.display,
    letterSpacing: -0.2,
  },
  registryName: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: font.mono,
  },
  registryNamePrimary: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  description: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
    marginTop: 4,
  },
  descriptionDim: { fontStyle: 'italic', color: colors.textMuted },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
  versionChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.sidebar,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  versionText: {
    fontSize: 10,
    color: colors.textSecondary,
    fontFamily: font.mono,
  },
  statusChip: {
    backgroundColor: colors.errorSoft,
    borderColor: 'transparent',
  },
  statusText: { color: colors.error, fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    backgroundColor: colors.sidebar,
  },
  installedStamp: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  installedText: {
    fontSize: 11.5,
    color: colors.success,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});
