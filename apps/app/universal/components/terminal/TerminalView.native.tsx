/**
 * Native (iOS / Android) terminal — a line-mode fallback.
 *
 * React Native has no DOM, so xterm.js can't run here. Instead we render
 * the PTY output as scrolling monospace text (ANSI escapes stripped for
 * legibility) and capture input through a ``TextInput`` plus a row of
 * quick keys (Tab, Esc, Ctrl-C, arrows). It's deliberately simpler than
 * the desktop xterm surface — enough to run commands and read output on
 * the go — and it shares all gateway plumbing via ``useTerminalSession``.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, font } from '../../theme';
import { useTerminalSession } from './useTerminalSession';
import type { TerminalViewProps } from './types';

const _decoder: TextDecoder | null =
  typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

function decode(bytes: Uint8Array): string {
  if (_decoder) return _decoder.decode(bytes);
  // Minimal fallback — Latin-1-ish; good enough for ASCII-heavy output.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// Strip ANSI CSI / OSC control sequences and carriage returns so the
// plain-text view stays readable without a real terminal emulator.
// ESC e BEL sono esattamente cio' che questa regex deve riconoscere: sono le
// sequenze ANSI che il terminale emette.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
function clean(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '');
}

const MAX_CHARS = 40000; // bound the buffer so long sessions don't grow unbounded

export default function TerminalViewNative({
  terminalId,
  cwd,
  shell,
  onStatusChange,
}: TerminalViewProps) {
  const session = useTerminalSession(terminalId, { cwd, shell, onStatusChange });
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const [buffer, setBuffer] = useState('');
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  // Estimate a column count from screen width and an ~8px monospace cell.
  const cols = useMemo(() => {
    const w = Dimensions.get('window').width;
    return Math.max(20, Math.min(200, Math.floor((w - 24) / 8)));
  }, []);

  useEffect(() => {
    sessionRef.current.onOutput((bytes) => {
      const chunk = clean(decode(bytes));
      if (!chunk) return;
      setBuffer((prev) => {
        const next = prev + chunk;
        return next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next;
      });
    });
    sessionRef.current.open(cols, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 30);
    return () => clearTimeout(t);
  }, [buffer]);

  const send = (data: string) => session.input(data);
  const submitLine = () => {
    session.input(draft + '\n');
    setDraft('');
  };

  const exited = session.status === 'exited' || session.status === 'error';

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        style={styles.output}
        contentContainerStyle={styles.outputContent}
      >
        <Text selectable style={styles.outputText}>
          {buffer || (session.status === 'connecting' ? 'Connecting…' : '')}
        </Text>
      </ScrollView>

      {/* Quick keys — the control chars a soft keyboard can't send. */}
      <View style={styles.keyRow}>
        <KeyBtn label="Tab" onPress={() => send('\t')} />
        <KeyBtn label="Esc" onPress={() => send('\x1b')} />
        <KeyBtn label="^C" onPress={() => session.signal('INT')} />
        <KeyBtn label="↑" onPress={() => send('\x1b[A')} />
        <KeyBtn label="↓" onPress={() => send('\x1b[B')} />
        <KeyBtn label="←" onPress={() => send('\x1b[D')} />
        <KeyBtn label="→" onPress={() => send('\x1b[C')} />
      </View>

      <View style={styles.inputRow}>
        <Text style={styles.prompt}>$</Text>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submitLine}
          placeholder={exited ? 'session ended' : 'type a command…'}
          placeholderTextColor={colors.textMuted}
          editable={!exited}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          blurOnSubmit={false}
          returnKeyType="send"
        />
      </View>
    </View>
  );
}

function KeyBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.key} onPress={onPress} hitSlop={6}>
      <Text style={styles.keyText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050810' },
  output: { flex: 1 },
  outputContent: { padding: 10 },
  outputText: {
    color: colors.text,
    fontFamily: font.mono,
    fontSize: 12,
    lineHeight: 17,
  },
  keyRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  key: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.inputBg,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyText: { color: colors.text, fontFamily: font.mono, fontSize: 13 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 8,
  },
  prompt: { color: colors.accent, fontFamily: font.mono, fontSize: 14 },
  input: {
    flex: 1,
    color: colors.text,
    fontFamily: font.mono,
    fontSize: 14,
    paddingVertical: 4,
  },
});
