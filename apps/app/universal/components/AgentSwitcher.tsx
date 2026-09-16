/** Sidebar trigger + modal shell for the shared account-management panel. */
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useConnection } from '../stores/connection';
import AgentAccountPanel from './AgentAccountPanel';
import { accountAgentPresentation } from '../../common/account-target-recovery';
import { colors, font, radius, spacing, tracking } from '../theme';

type Variant = 'wordmark' | 'compact' | 'icon' | 'menu-row';

export default function AgentSwitcher({ variant }: { variant: Variant }) {
  const { accounts, activeAccountId, isConnected, isReconnecting, agentName } = useConnection();
  const [open, setOpen] = useState(false);
  const active = accounts.find((account) => account.id === activeAccountId);
  const activePresentation = active ? accountAgentPresentation(active) : null;
  // Keep the compact trigger friendly (for example “Friday”). The account
  // panel carries the coordinator-verified routing handle and labels it
  // explicitly, so a saved custom name remains useful without being mistaken
  // for the connection target.
  const activeName = isConnected && agentName
    ? agentName
    : activePresentation
      ? activePresentation.alias ?? activePresentation.primary
      : 'Not connected';
  const initial = activeName.slice(0, 1).toUpperCase();
  const isElectron = typeof window !== 'undefined' && (window as any).desktop?.isDesktop === true;
  const statusColor = isReconnecting
    ? colors.warning
    : isConnected ? colors.success : colors.textMuted;

  return (
    <>
      {variant === 'wordmark' && (
        <Pressable
          onPress={() => setOpen(true)}
          {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } as any : {})}
          style={styles.wordmarkTrigger}
          accessibilityRole="button"
          accessibilityLabel="Switch agent"
        >
          <View style={styles.wordmarkRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={styles.wordmark} numberOfLines={1}>{activeName}</Text>
            <Feather name="chevron-down" size={14} color={colors.textMuted} />
          </View>
          <View style={styles.wordmarkRule} />
        </Pressable>
      )}

      {variant === 'compact' && (
        <Pressable
          onPress={() => setOpen(true)}
          {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
          style={styles.compactTrigger}
          accessibilityRole="button"
          accessibilityLabel="Switch agent"
        >
          <View style={styles.compactAvatar}>
            <Text style={styles.compactAvatarText}>{initial}</Text>
            <View style={[styles.compactDot, { backgroundColor: statusColor }]} />
          </View>
          <Text style={styles.compactName} numberOfLines={1}>{activeName}</Text>
          <Feather name="chevron-up" size={13} color={colors.textMuted} />
        </Pressable>
      )}

      {variant === 'menu-row' && (
        <Pressable
          onPress={() => setOpen(true)}
          {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
          style={styles.menuRowTrigger}
          accessibilityRole="button"
          accessibilityLabel="Switch agent"
        >
          <Feather name="users" size={11} color={colors.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={styles.menuRowTitle} numberOfLines={1}>{activeName}</Text>
            <Text style={styles.menuRowSub}>Switch agent</Text>
          </View>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        </Pressable>
      )}

      {variant === 'icon' && (
        <Pressable
          onPress={() => setOpen(true)}
          style={styles.iconTrigger}
          accessibilityRole="button"
          accessibilityLabel="Switch agent"
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <View style={[styles.statusDot, styles.iconDot, { backgroundColor: statusColor }]} />
        </Pressable>
      )}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpen(false)}
          {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
        >
          <Pressable
            style={styles.modalPanel}
            onPress={(event: any) => event?.stopPropagation?.()}
            {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
          >
            <AgentAccountPanel
              mode={isElectron ? 'open-window' : 'connect'}
              onComplete={() => setOpen(false)}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  wordmarkTrigger: { gap: spacing.sm, paddingHorizontal: spacing.xs },
  wordmarkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  wordmark: {
    flex: 1, fontFamily: font.sans, fontSize: 12.5, fontWeight: '600',
    color: colors.text, letterSpacing: tracking.normal,
  },
  wordmarkRule: { height: 1, backgroundColor: colors.borderLight, width: '70%' },
  compactTrigger: {
    flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    height: 32, paddingHorizontal: spacing.xs, borderRadius: radius.md,
  },
  compactAvatar: {
    width: 26, height: 26, borderRadius: radius.pill, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center',
  },
  compactAvatarText: { fontFamily: font.display, fontSize: 12, color: colors.accent, fontWeight: '600' },
  compactDot: {
    position: 'absolute', right: -1, bottom: -1, width: 8, height: 8,
    borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.sidebar,
  },
  compactName: {
    flex: 1, minWidth: 0, fontFamily: font.sans, fontSize: 12.5,
    fontWeight: '600', color: colors.text,
  },
  iconTrigger: { alignItems: 'center', paddingVertical: spacing.xs },
  avatar: {
    width: 34, height: 34, borderRadius: radius.pill, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontFamily: font.display, fontSize: 14, color: colors.accent, fontWeight: '600' },
  statusDot: { width: 7, height: 7, borderRadius: radius.pill },
  iconDot: { marginTop: -7, alignSelf: 'flex-end', marginRight: 4 },
  menuRowTrigger: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 7, marginHorizontal: 4, borderRadius: radius.sm,
  },
  menuRowTitle: { fontSize: 12, color: colors.text },
  menuRowSub: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  backdrop: {
    flex: 1, backgroundColor: 'rgba(2, 4, 10, 0.55)',
    alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
  },
  modalPanel: { width: '100%', maxWidth: 440 },
});
