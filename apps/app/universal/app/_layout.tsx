import { Stack, useUnstableGlobalHref } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { ThemeProvider, type Theme } from '@react-navigation/native';
import { useConnection, directedAccountId, rememberDirectedAccount } from '../stores/connection';
import { useChat } from '../stores/chat';
import { bindShared, observeShared } from '../stores/collaboration';
import { useNavHistory, trailHref } from '../stores/navHistory';
import { ConfirmProvider } from '../components/ConfirmDialog';
import { RenameSessionProvider } from '../components/RenameSessionDialog';
import Header from '../components/Header';
import { JarvisCanvas } from '../components/jarvis';

/**
 * Records every route change into the explicit nav trail (see
 * stores/navHistory). Renders nothing; lives inside the router so the
 * expo-router hook re-runs it on each navigation. Uses
 * ``useUnstableGlobalHref`` — the REACTIVE full href (path + query) from
 * expo-router's route info — rather than reading ``window.location`` out of
 * band, which lagged the route update and dropped query params (e.g. a run's
 * ``?kind&parentId&name``), corrupting the back target. Cross-platform too:
 * the global href carries the query on native as well.
 */
function NavHistoryRecorder() {
  const href = useUnstableGlobalHref();
  useEffect(() => {
    useNavHistory.getState().record(trailHref(href));
  }, [href]);
  return null;
}

const navDarkTheme: Theme = {
  dark: true,
  colors: {
    primary: '#3FC8FF',
    background: 'transparent',
    card: 'transparent',
    text: '#EEF4FB',
    border: 'rgba(63, 200, 255, 0.20)',
    notification: '#FF6B7A',
  },
  fonts: { regular: { fontFamily: 'System', fontWeight: '400' }, medium: { fontFamily: 'System', fontWeight: '500' }, bold: { fontFamily: 'System', fontWeight: '700' }, heavy: { fontFamily: 'System', fontWeight: '900' } },
};

function desktop(): any {
  if (typeof window === 'undefined') return undefined;
  return (window as any).desktop;
}

export default function RootLayout() {
  const ws = useConnection((s) => s.ws);
  useEffect(() => {
    if (!ws) return;
    let current = true;
    let unbind = () => {};
    let release = () => {};
    void ws.enableShared().then(shared => {
      if (!current || !shared) return;
      unbind = bindShared(shared);
      const update = () => {
        const state = useChat.getState();
        // Take the new lease before dropping the old one: releasing first
        // would briefly leave a session unobserved, and the client discards
        // the snapshot of anything outside the current observation.
        const next = observeShared([state.activeSessionId, ...state.sessions.slice(0, 15).map(s => s.id)].filter((id): id is string => !!id), null);
        release();
        release = next;
      };
      let key = '';
      const unsub = useChat.subscribe(state => {
        const nextKey = state.activeSessionId + ':' + state.sessions.slice(0, 15).map(s => s.id).join(',');
        if (key !== nextKey) { key = nextKey; update(); }
      });
      const oldUnbind = unbind;
      unbind = () => { unsub(); oldUnbind(); };
      update();
    }).catch(error => {
      if (current) useConnection.setState({ error: String(error) });
    });
    return () => { current = false; release(); unbind(); };
  }, [ws]);
  const handleServerMessage = useChat((s) => s.handleServerMessage);
  const loadAccounts = useConnection((s) => s.loadAccounts);
  const resumeConnection = useConnection((s) => s.resumeConnection);
  const connectDirected = useConnection((s) => s.connectDirected);
  const isDesktop = desktop()?.isDesktop === true;
  const isChild = desktop()?.isChild === true;
  // macOS shows native traffic lights in the sidebar's top-left, so it
  // needs no chrome strip; Win/Linux keep the custom controls Header.
  const isMac = desktop()?.platform === 'darwin';

  const fadeAnim = useRef(new Animated.Value(isChild ? 0 : 1)).current;

  useEffect(() => {
    if (!isChild) return;
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 360,
      useNativeDriver: false,
    }).start();
  }, [isChild]);

  useEffect(() => {
    loadAccounts().then(() => {
      // A standalone agent window (``?connect=<id>``) opens its own
      // connection to that account's already-running loopback; a normal
      // window resumes the shared active-connection slot.
      const target = directedAccountId();
      if (target) {
        rememberDirectedAccount(target);
        connectDirected(target);
      } else {
        resumeConnection();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg) => {
      if (
        msg.type === 'status'
        || msg.type === 'delta'
        || msg.type === 'response'
        || msg.type === 'seed'
        || msg.type === 'text_final'
        || msg.type === 'reasoning'
        || msg.type === 'error'
        || msg.type === 'session_compacted'
      ) {
        handleServerMessage(msg);
      }

      if (msg.type === 'live_state' && msg.session_id) {
        useChat.getState().applyLiveState(
          msg.session_id,
          (msg.frames || []) as any,
          msg.active,
        );
      }

      // End of a logical assistant turn → snap the live transcript to the
      // authoritative DB-derived shape so the live view matches a reopen
      // exactly (real authorship, delegation cards, no missing/dup messages).
      // The runs are persisted by the time this frame is emitted.
      // ``finaliseStreaming`` first: clears any stuck streaming:true / isProcessing:true
      // left when a gateway omits the ``response`` frame or a RAF delta flush
      // races past it. This unblocks ``reconcileSession`` so it can fetch the
      // canonical transcript — without it, isProcessing:true would make
      // reconcileSession a no-op and the markdown renderer would stay on the
      // plain-text (literal asterisks) fallback path permanently.
      if (msg.type === 'turn_complete' && msg.session_id) {
        useChat.getState().finaliseStreaming(msg.session_id);
        // A turn that ended badly now SAYS so. Before, a failure that produced
        // no ``error`` frame of its own ended as silently as a success, and
        // the user was left with a transcript that simply stopped.
        if (msg.reason && msg.reason !== 'completed') {
          useChat.getState().noteTurnOutcome(msg.session_id, msg.reason, msg.error);
        }
        useChat.getState().reconcileSession(msg.session_id);
        // Refresh the context panel from the server after a turn settles.
        // The main session also gets a pushed ``context_report`` below; this
        // covers child / run / workflow-AI-node sessions (no push frame) and
        // reconciles cumulative cost.
        useChat.getState().refreshContext(msg.session_id);
      }

      // Live context-window composition pushed each turn → update the panel.
      if (msg.type === 'context_report' && msg.session_id && msg.report) {
        useChat.getState().applyContextReport(msg.session_id, msg.report);
      }

      // The /context command reply carries the same structured breakdown —
      // apply it so typing /context refreshes the panel immediately.
      if (msg.type === 'command_result' && msg.context) {
        useChat.getState().applyContextReport(msg.context.session_id, msg.context);
      }

      // A session was deleted/pruned server-side → drop it from this sidebar
      // in realtime (the events store separately handles 'created' by
      // refetching the list, which surfaces new sub-agent sessions live).
      if (msg.type === 'resource_event' && msg.resource === 'session'
          && msg.action === 'deleted' && msg.id) {
        useChat.getState().dropSessionLocal(msg.id);
      }

      if (isDesktop && !isChild) {
        try {
          desktop()?.wsRelayBroadcast(JSON.stringify(msg));
        } catch { /* ignore */ }
      }
    });

    let relayCleanup: (() => void) | undefined;
    if (isDesktop && !isChild) {
      const d = desktop();
      if (d?.onWsRelayFromChild) {
        relayCleanup = d.onWsRelayFromChild((data: string) => {
          try {
            ws.sendRaw(data);
          } catch { /* ignore */ }
        });
      }
    }

    return () => {
      unsub();
      relayCleanup?.();
    };
  }, [ws, handleServerMessage, isDesktop, isChild]);

  return (
    <ConfirmProvider>
      <RenameSessionProvider>
        <NavHistoryRecorder />
        <JarvisCanvas style={styles.root} showBrackets={false} showEdgeTicks={false} showGrid={false}>
          {/* Window chrome (drag strip + custom traffic-light controls) for
              frameless Win/Linux only. macOS uses native traffic lights in
              the sidebar; plain web / native render no chrome. */}
          {isDesktop && !isMac && <Header />}
          <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
            <ThemeProvider value={navDarkTheme}>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: 'transparent' },
                  cardStyle: { backgroundColor: 'transparent' },
                } as any}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="(tabs)" />
              </Stack>
            </ThemeProvider>
          </Animated.View>
        </JarvisCanvas>
      </RenameSessionProvider>
    </ConfirmProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1 },
});
