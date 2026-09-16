import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, font, glassSurface, radius } from '../theme';
import { useChat } from '../stores/chat';
import { useSearch } from '../stores/search';
import Button from './Button';

export interface RenameSessionTarget {
  id: string;
  title?: string | null;
}

type RenameSessionFn = (target: RenameSessionTarget) => void;

const RenameSessionContext = createContext<RenameSessionFn | null>(null);

/** One rename surface for every conversation affordance.
 *
 * Keeping the mutation here means the sidebar, chat menu, and details drawer
 * cannot drift into three subtly different save/error behaviours. The chat
 * store owns the durable PATCH and rollback; after it commits we patch the
 * normalized history cache that actually renders the v2 sidebar.
 */
export function RenameSessionProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<RenameSessionTarget | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const open = useCallback<RenameSessionFn>((next) => {
    setTarget(next);
    setDraft(next.title?.trim() || 'New Chat');
    setError(null);
  }, []);

  const close = useCallback(() => {
    if (saving) return;
    setTarget(null);
    setError(null);
  }, [saving]);

  const submit = useCallback(async () => {
    if (!target || saving) return;
    const title = draft.trim().slice(0, 200);
    if (!title) {
      setError('Enter a conversation name.');
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await useChat.getState().renameSession(target.id, title);
      useSearch.getState().renameSessionTitle(target.id, title);
      setTarget(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not rename this conversation.');
    } finally {
      setSaving(false);
    }
  }, [draft, saving, target]);

  useEffect(() => {
    if (!target || Platform.OS !== 'web' || typeof window === 'undefined') return;
    // React Native Web's Modal portal mounts after the triggering menu unmounts;
    // autoFocus alone can lose that race and leave keyboard input on the old
    // menu trigger. Focus again on the next frame so typing is deterministic.
    const focusFrame = window.requestAnimationFrame(() => inputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      event.preventDefault();
      setTarget(null);
      setError(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [saving, target]);

  return (
    <RenameSessionContext.Provider value={open}>
      {children}
      <Modal
        animationType="fade"
        transparent
        visible={!!target}
        onRequestClose={close}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
          />
          <View
            style={styles.dialog}
            {...(Platform.OS === 'web' ? { className: 'oa-slide-up' } as any : {})}
          >
            <Text style={styles.title}>Rename conversation</Text>
            <Text style={styles.message}>Choose a name that will identify this conversation in history and search.</Text>
            <TextInput
              ref={inputRef}
              autoFocus
              selectTextOnFocus
              value={draft}
              onChangeText={(value) => {
                setDraft(value);
                if (error) setError(null);
              }}
              onSubmitEditing={() => void submit()}
              editable={!saving}
              maxLength={200}
              returnKeyType="done"
              style={[styles.input, error && styles.inputError]}
              placeholder="Conversation name"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Conversation name"
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.actions}>
              <Button variant="secondary" label="Cancel" onPress={close} disabled={saving} />
              <Button variant="primary" label={saving ? 'Saving…' : 'Save'} onPress={() => void submit()} disabled={saving} />
            </View>
          </View>
        </View>
      </Modal>
    </RenameSessionContext.Provider>
  );
}

export function useRenameSession(): RenameSessionFn {
  const rename = useContext(RenameSessionContext);
  if (!rename) throw new Error('useRenameSession must be used within RenameSessionProvider');
  return rename;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: 'rgba(2, 4, 10, 0.45)',
  },
  dialog: {
    width: 420,
    maxWidth: '100%',
    padding: 20,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: glassSurface.backgroundColor,
    ...(Platform.OS === 'web'
      ? { backdropFilter: glassSurface.webFilter, WebkitBackdropFilter: glassSurface.webFilter }
      : {}),
    shadowColor: 'rgba(0,0,0,0.18)',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 1,
    shadowRadius: 48,
  },
  title: {
    color: colors.text,
    fontFamily: font.display,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
    marginBottom: 6,
  },
  message: {
    color: colors.textSecondary,
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 14,
  },
  input: {
    minHeight: 42,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: font.sans,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
    outlineStyle: 'none',
  } as any,
  inputError: { borderColor: colors.error },
  error: {
    color: colors.error,
    fontFamily: font.sans,
    fontSize: 12,
    marginTop: 7,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 18,
  },
});
