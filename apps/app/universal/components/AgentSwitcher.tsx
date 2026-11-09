/** The saved logins live in the rail; dialogs are only for adding or signing in. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useConnection, type RememberedCredentialFailure } from '../stores/connection';
import { useConfirm } from './ConfirmDialog';
import AgentAccountPanel from './AgentAccountPanel';
import { AgentAvatar } from './AgentAvatar';
import DragRegion from './DragRegion';
import WindowControls from './WindowControls';
import { accountAgentPresentation } from '../../common/account-target-recovery';
import type { SavedAccount } from '../../common/types';
import { colors, radius } from '../theme';

export const AGENT_RAIL_WIDTH = 70;
const nameOf = (account: SavedAccount) => {
  const presentation = accountAgentPresentation(account);
  return account.agentDisplayName || presentation.alias || presentation.primary;
};

export default function AgentSwitcher({ onSelect }: { onSelect: () => void }) {
  const { height } = useWindowDimensions();
  const accounts = useConnection((s) => s.accounts);
  const activeId = useConnection((s) => s.activeAccountId);
  const connected = useConnection((s) => s.isConnected && !s.isReconnecting);
  const failure = useConnection((s) => s.rememberedFailure);
  const [adding, setAdding] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const dismissedFailure = useRef<RememberedCredentialFailure | null>(null);
  const confirm = useConfirm();
  const confirming = useRef(false);
  const plus = useRef<View>(null);
  const desktop = Platform.OS === 'web' && typeof window !== 'undefined' ? (window as any).desktop : null;

  useEffect(() => {
    if (!failure || failure.accountId !== activeId || adding || dismissedFailure.current === failure) return;
    // A cold selection can fail before a desktop double click completes.
    // Let the second click reach its rail item before opening sign-in.
    const timer = setTimeout(() => {
      if (useConnection.getState().rememberedFailure === failure
        && dismissedFailure.current !== failure && !confirming.current) setLogin(failure.accountId);
    }, Platform.OS === 'web' ? 500 : 0);
    return () => clearTimeout(timer);
  }, [failure, activeId, adding]);

  const closeLogin = useCallback(() => {
    dismissedFailure.current = useConnection.getState().rememberedFailure;
    setAdding(false);
    setLogin(null);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || (!adding && !login) || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeLogin();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [adding, login, closeLogin]);

  useEffect(() => desktop?.onMenuAction?.((action: string, target?: { id?: string }) => {
    if (action === 'menu:switchAgent') {
      (plus.current as unknown as HTMLElement | null)?.focus?.();
    } else if (action === 'menu:openAgent' && target?.id) {
      const id = target.id;
      onSelect();
      void useConnection.getState().selectAccount(id);
    }
  }), [desktop, onSelect]);

  const remove = async (account: SavedAccount) => {
    if (confirming.current) return;
    dismissedFailure.current = useConnection.getState().rememberedFailure;
    confirming.current = true;
    const accepted = await confirm({
      title: 'Remove saved login',
      message: `Remove “${nameOf(account)}” from this app? You can sign in again with an invite. The agent and its conversations stay on the server.`,
      confirmLabel: 'Remove',
      confirmVariant: 'danger',
    });
    confirming.current = false;
    if (!accepted) return;
    if (useConnection.getState().activeAccountId === account.id) onSelect();
    await useConnection.getState().removeAccount(account.id);
  };

  const press = (account: SavedAccount) => {
    if (account.id === activeId && connected) return;
    setLogin(null);
    if (account.id !== activeId) onSelect();
    void useConnection.getState().selectAccount(account.id);
  };

  return (
    <View style={styles.rail} testID="agent-rail">
      {desktop?.platform === 'darwin' && (
        <View style={styles.macControls}><DragRegion /><WindowControls /></View>
      )}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
        {accounts.map((account) => {
          const selected = activeId === account.id;
          const name = nameOf(account);
          return (
            <Pressable
              key={account.id}
              ref={(node) => {
                const element = Platform.OS === 'web' ? node as unknown as HTMLElement | null : null;
                if (!element) return;
                element.title = name;
                // Pressable does not consistently forward native dblclick on
                // web; bind it to the real button instead of counting presses.
                element.ondblclick = (event) => {
                  event.preventDefault();
                  void remove(account);
                };
                element.oncontextmenu = element.ondblclick;
              }}
              testID={`agent-rail-account-${account.id}`}
              accessibilityRole="button"
              accessibilityLabel={name}
              accessibilityState={{ selected }}
              accessibilityHint="Select agent. Hold to remove its saved login."
              onPress={() => press(account)}
              onLongPress={() => void remove(account)}
              accessibilityActions={[{ name: 'remove', label: 'Remove saved login' }]}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === 'remove') void remove(account);
              }}
              {...(Platform.OS === 'web' ? ({
                'aria-pressed': selected,
                onKeyDown: (event: KeyboardEvent) => {
                  if (event.key === 'Delete') { event.preventDefault(); void remove(account); }
                },
              } as any) : {})}
              style={({ pressed, hovered }: any) => [styles.item, (pressed || hovered) && styles.hover]}
            >
              {selected && <View testID="selected-agent-marker" style={styles.marker} />}
              <AgentAvatar name={name} thumbnail={account.agentThumbnail} selected={selected} />
            </Pressable>
          );
        })}
        <View style={styles.rule} />
        <Pressable
          ref={plus}
          accessibilityRole="button"
          accessibilityLabel="Add an agent"
          onPress={() => { closeLogin(); setAdding(true); }}
          style={({ pressed, hovered }: any) => [styles.add, (pressed || hovered) && styles.hover]}
        >
          <Feather name="plus" size={21} color={colors.accent} />
        </Pressable>
      </ScrollView>
      <Modal visible={adding || !!login} transparent animationType="fade"
        onRequestClose={closeLogin}>
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close login"
            onPress={closeLogin} />
          <ScrollView style={[styles.sheet, { maxHeight: height - 36 }]}
            keyboardShouldPersistTaps="handled">
            <AgentAccountPanel key={adding ? 'add' : login} mode="connect" addOnly={adding}
              reconnectAccountId={login}
              onComplete={closeLogin} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: AGENT_RAIL_WIDTH, backgroundColor: colors.sidebar, borderRightWidth: 1,
    borderRightColor: colors.borderLight,
  },
  macControls: { height: 34 },
  list: { alignItems: 'center', paddingTop: 12, paddingBottom: 16, gap: 7 },
  item: { width: '100%', paddingVertical: 4, alignItems: 'center', gap: 4 },
  hover: { backgroundColor: colors.surface },
  marker: { position: 'absolute', left: 0, top: 8, height: 31, width: 3,
    borderTopRightRadius: 3, borderBottomRightRadius: 3, backgroundColor: colors.accent },
  rule: { height: 1, width: 24, backgroundColor: colors.borderStrong, marginVertical: 3 },
  add: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong },
  backdrop: { flex: 1, backgroundColor: 'rgba(2, 4, 10, 0.60)', alignItems: 'center',
    justifyContent: 'center', padding: 18 },
  sheet: { width: '100%', maxWidth: 440, flexGrow: 0 },
});
