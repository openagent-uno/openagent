/**
 * Terminal route — /terminal/{id}.
 *
 * One PTY shell on the agent's host, rendered full-screen. On desktop
 * this is its own OS window (opened via ``openDetached``); on web /
 * native it's a pushed full-screen route. The xterm.js surface (web) or
 * line-mode fallback (native) is picked by ``TerminalView``'s platform
 * dispatcher. ``cwd`` / ``shell`` ride in as query params so a detached
 * window — which has no access to the launcher's store — still knows
 * what to spawn.
 */

import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, radius } from '../../../theme';
import { HeaderMenuAndBack, HeaderRight, useHeaderInset } from '../../../components/screenHeader';
import TerminalView, { type TerminalStatus } from '../../../components/terminal/TerminalView';
import { useConnection } from '../../../stores/connection';
import { setBaseUrl } from '../../../services/api';
import { closeDetached } from '../../../services/windows';

const STATUS_META: Record<TerminalStatus, { label: string; color: string }> = {
  connecting: { label: 'connecting', color: colors.warning },
  open: { label: 'live', color: colors.success },
  exited: { label: 'exited', color: colors.textMuted },
  error: { label: 'error', color: colors.error },
};

export default function TerminalScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const { id, cwd, shell } = useLocalSearchParams<{
    id: string;
    cwd?: string;
    shell?: string;
  }>();
  const connConfig = useConnection((s) => s.config);
  const isConnected = useConnection((s) => s.isConnected);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [, setDetail] = useState<string | undefined>();

  useEffect(() => {
    if (connConfig?.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
  }, [connConfig]);

  const meta = STATUS_META[status];
  const shellName = shell ? shell.split('/').pop() : undefined;

  // Title + live status badge in the nav header. The terminal stack has no
  // ``index`` to pop to, so the back button closes the window / returns to
  // where it was opened from (System) via closeDetached.
  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Terminal',
      headerLeft: () => <HeaderMenuAndBack onPress={() => closeDetached(router)} />,
      headerRight: () => (
        <HeaderRight>
          <View style={styles.badge}>
            <View style={[styles.dot, { backgroundColor: meta.color }]} />
            <Text style={styles.badgeText}>{meta.label}</Text>
          </View>
        </HeaderRight>
      ),
    });
    // Only re-run when the status / shell changes; ``router`` is referenced
    // inside but kept out of deps (useRouter returns a fresh ref each render,
    // which would loop setOptions).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, shellName, status]);

  return (
    <View style={[styles.root, { paddingTop: headerInset }]}>
      {!id ? (
        <View style={styles.center}>
          <Text style={styles.err}>Missing terminal id.</Text>
        </View>
      ) : !isConnected && !connConfig ? (
        <View style={styles.center}>
          <Text style={styles.hint}>Connect to an agent to open a terminal.</Text>
        </View>
      ) : (
        <TerminalView
          terminalId={id}
          cwd={cwd}
          shell={shell}
          onStatusChange={(s, d) => {
            setStatus(s);
            setDetail(d);
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050810' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  err: { color: colors.error, fontSize: 13, fontFamily: font.mono },
  hint: { color: colors.textMuted, fontSize: 13 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.inputBg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  badgeText: {
    fontSize: 10,
    color: colors.textSecondary,
    fontFamily: font.mono,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
});
