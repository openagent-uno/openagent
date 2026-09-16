/**
 * MessageComposer — shared chat input bar.
 *
 * Same composer is used by the Chat tab (text + file attach + Telegram-
 * style mic record + send) and the Voice tab (text + send only — the
 * always-listening mic loop is the room's input model). Buttons appear
 * only when their handlers are passed, so the same component renders
 * the right surface in both screens without flag plumbing.
 *
 * Web uses a native ``<textarea>`` for autogrowing input + Enter-to-send;
 * native RN falls back to a ``<TextInput multiline>``.
 */

import { useCallback, useEffect, useRef, useState, type Ref, type ReactNode, useMemo } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Platform, Image } from 'react-native';
import type { Attachment } from '../../common/types';
import { colors, font, radius } from '../theme';

export interface SlashCommand {
  name: string;
  description?: string;
  /** When set, fires this and clears the composer instead of inserting text. */
  action?: () => void;
  /** Mirrors the gateway command spec's ``arg_source``. When set to
   *  ``'models'`` the composer opens its built-in model picker on accept
   *  instead of inserting ``/name `` for the user to type an id by hand.
   *  Keeps the picker behaviour generic — any future pickable command
   *  works without new composer code. */
  argSource?: 'models';
}

export interface PendingFile {
  /** Stable id so async upload completion can target the right chip. */
  id: string;
  filename: string;
  /** Canonical result returned by the CAS upload endpoint. */
  attachment?: Attachment;
  /** @deprecated Path-only picker fallback for pre-CAS desktop builds. */
  remotePath?: string;
  kind: 'image' | 'file';
  /** True between picker dismissal and upload settle. */
  uploading?: boolean;
  /** Aborts the in-flight upload. Removed when uploading becomes false. */
  abort?: () => void;
  /**
   * Present when the upload failed. The chip renders in an error state
   * (red border, alert glyph) and ``handleSend`` filters these out so
   * the user has to dismiss them explicitly. Attachment carriers are
   * absent for failed entries.
   */
  error?: string;
  /**
   * Object URL for the local browser File (web/desktop only). Used to
   * render a small thumbnail in the pending chip while the upload is
   * still in flight (and after — saves a round-trip to the server).
   * Caller is responsible for revoking it once the chip is dropped.
   */
  previewUrl?: string;
  /** Closure that re-attempts the upload for a chip whose previous
   *  attempt errored out. Owns its own AbortController; the composer
   *  passes the idx back to chat.tsx which calls this. */
  retry?: () => void;
}

export interface MessageComposerProps {
  input: string;
  onInputChange: (v: string) => void;
  pendingFiles?: PendingFile[];
  onRemoveFile?: (idx: number) => void;
  /** Re-attempt a previously failed upload. Optional — when omitted,
   *  the retry glyph hides. */
  onRetryFile?: (idx: number) => void;
  onPickFile?: () => void;             // omit → no paperclip button
  onSend: () => void;
  disabled?: boolean;                  // disables send (e.g. session.isProcessing)
  /** When true (session is processing), the trailing Send button morphs
   *  into a Stop button that calls ``onStop``. The input itself stays
   *  interactive: the user can type a steer message and press Enter to
   *  send it mid-turn (the server coalesces it into the running turn).
   *  Do NOT also pass ``disabled`` while processing — that would re-block
   *  the Enter-to-steer path. */
  processing?: boolean;
  onStop?: () => void;
  /** Optional recall handlers — wired to Up Arrow on empty composer and
   *  Down Arrow to walk back to the empty (current) draft. */
  onRecallPrev?: () => void;
  onRecallNext?: () => void;
  /** Slash-command entries surfaced as an autocomplete dropdown when
   *  the input matches ``^/`` (case-insensitive). The first entry whose
   *  name starts with the typed query is highlighted; Enter inserts
   *  its template (or fires its action, if any). */
  slashCommands?: SlashCommand[];
  /** LLM rows the composer offers in its model-picker dropdown. Omit
   *  to hide the picker entirely. */
  modelOptions?: {
    id: string; label: string; provider?: string;
    /** Which subscription pays for this row ("Claude", "GPT", "Local").
     *  The menu groups by it and shows the headroom once per family
     *  instead of repeating it on every row. */
    family?: string;
    /** How hard this row thinks, within its family. */
    effort?: 'light' | 'standard' | 'high' | 'max';
    /** Right-aligned note about the account serving this model's provider —
     *  "40% left", "limited · 12m", "quota not reported". Computed by the
     *  screen, so the composer stays unaware of where accounts come from. */
    accountHint?: string;
    /** Tint for `accountHint`; omitted means muted. */
    accountTone?: 'ok' | 'warn' | 'bad';
  }[];
  /** Rendered at the foot of the model menu — the agent switcher, so
   *  "which model" and "whose account" are one gesture. */
  menuFooter?: ReactNode;
  /** Currently-active model id (matches ``modelOptions[i].id``).
   *  ``undefined`` renders the picker as "Auto" — no pin, so the
   *  router leads the turn. */
  activeModelId?: string;
  onSelectModel?: (id: string | undefined) => void;
  recording?: boolean;                 // omit → no mic button
  onStartRecord?: () => void;
  onStopRecord?: () => void;
  // Continuous always-listening toggle. When ``alwaysListening`` is
  // defined the composer renders a second mic-style icon (a
  // headphones glyph) that toggles the persistent VAD loop. While
  // it's on, the manual ``recording`` button hides — the two modes
  // are mutually exclusive (you'd capture every utterance twice
  // otherwise).
  alwaysListening?: boolean;
  onToggleAlwaysListen?: () => void;
  placeholder?: string;
  showHint?: boolean;                  // default true (Enter / Shift+Enter)
  /** Forwarded to the underlying text field so a parent can focus it
   *  programmatically — used by the chat screen's type-to-focus, which
   *  routes a stray printable keystroke into the composer. */
  inputRef?: Ref<any>;
}

const COMPOSER_INPUT_BASE_HEIGHT = 34;

export default function MessageComposer({
  input,
  onInputChange,
  pendingFiles,
  onRemoveFile,
  onRetryFile,
  onPickFile,
  onSend,
  disabled,
  processing,
  onStop,
  onRecallPrev,
  onRecallNext,
  slashCommands,
  modelOptions,
  menuFooter,
  activeModelId,
  onSelectModel,
  recording,
  onStartRecord,
  onStopRecord,
  alwaysListening,
  onToggleAlwaysListen,
  placeholder = 'Message OpenAgent...',
  showHint = true,
  inputRef,
}: MessageComposerProps) {
  // Slash autocomplete state. We surface the menu when the composer
  // begins with ``/`` and the text contains no whitespace yet — once
  // the user starts an argument or hits Enter, the menu yields.
  const slashQuery = (() => {
    if (!slashCommands?.length) return null;
    if (Platform.OS !== 'web') return null;
    if (!input.startsWith('/')) return null;
    if (/\s/.test(input)) return null;
    return input.slice(1).toLowerCase();
  })();
  const slashMatches = slashQuery !== null
    ? slashCommands!.filter((c) => c.name.toLowerCase().startsWith(slashQuery))
    : [];
  const [slashActive, setSlashActive] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const fieldRef = useRef<any>(null);
  const baseFieldHeightRef = useRef<number | null>(null);
  const setFieldRef = useCallback((node: any) => {
    fieldRef.current = node;
    if (!inputRef) return;
    if (typeof inputRef === 'function') {
      inputRef(node);
      return;
    }
    (inputRef as any).current = node;
  }, [inputRef]);

  useEffect(() => {
    // Keep the highlight in range as the candidate list shrinks/grows.
    if (slashActive >= slashMatches.length) setSlashActive(0);
  }, [slashMatches.length, slashActive]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = fieldRef.current as HTMLTextAreaElement | null;
    if (!el) return;
    const measuredBase = baseFieldHeightRef.current
      ?? Math.ceil(el.getBoundingClientRect().height || COMPOSER_INPUT_BASE_HEIGHT);
    baseFieldHeightRef.current = measuredBase;
    const maxHeight = measuredBase * 4;
    el.style.height = `${measuredBase}px`;
    const nextHeight = Math.min(Math.max(measuredBase, el.scrollHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [input]);
  const acceptSlash = useCallback((cmd: SlashCommand) => {
    // A command whose argument is picked from the model list opens the
    // composer's built-in picker instead of dropping the user into a
    // free-text "/model " they'd have to complete by hand.
    if (cmd.argSource === 'models' && onSelectModel && modelOptions && modelOptions.length > 0) {
      setModelMenuOpen(true);
      onInputChange('');
      return;
    }
    if (cmd.action) {
      cmd.action();
      onInputChange('');
      return;
    }
    // Insert the canonical "/name " into the composer so the user can
    // keep typing the argument.
    onInputChange(`/${cmd.name} `);
  }, [onInputChange, onSelectModel, modelOptions]);
  // Group the picker by family, ordered by effort inside each. One header
  // per subscription carries its headroom; the rows carry only what differs.
  const groupedModels = useMemo(() => {
    const order = ['light', 'standard', 'high', 'max'];
    const byFamily = new Map<string, typeof modelOptions>();
    for (const m of modelOptions ?? []) {
      const key = m.family || m.provider || 'Models';
      const list = byFamily.get(key) ?? [];
      list.push(m);
      byFamily.set(key, list);
    }
    return [...byFamily.entries()].map(([family, rows]) => ({
      family,
      // Every row in a family shares one account, so the first row's hint is
      // the family's hint.
      hint: rows?.[0]?.accountHint,
      tone: rows?.[0]?.accountTone,
      rows: [...(rows ?? [])].sort(
        (a, b) => order.indexOf(a.effort ?? 'standard') - order.indexOf(b.effort ?? 'standard'),
      ),
    }));
  }, [modelOptions]);

  const activeModel = modelOptions?.find((m) => m.id === activeModelId);
  const files = pendingFiles ?? [];
  // Failed and still-uploading entries stay in the list as visible
  // chips but don't count toward "there's something to send". Without
  // this check the user could fire a send before an upload settled and
  // get a message with no durable attachment reference.
  const sendableCount = files.reduce(
    (n, f) => n + (f.error || f.uploading || (!f.attachment && !f.remotePath) ? 0 : 1),
    0,
  );
  const canSend = (input.trim().length > 0 || sendableCount > 0) && !disabled;

  const handleKeyDown = useCallback((e: any) => {
    // IME composition (e.g. accent picker, CJK) ends with an Enter
    // keydown — don't intercept it as "send", that swallows the
    // composed character and feels broken.
    if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return;

    // Slash menu has first dibs on Tab/Up/Down/Enter when it's open
    // and has results to offer.
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashActive((i) => Math.min(slashMatches.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashActive((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        acceptSlash(slashMatches[slashActive]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onInputChange('');
        return;
      }
    }

    // Up/Down on empty composer = recall previous/next user message
    // (ChatGPT/Claude convention). Only walk when the textarea has no
    // text or the caret is at the very start, so editing isn't broken.
    if (onRecallPrev && e.key === 'ArrowUp' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const empty = input.length === 0;
      const atStart = e.target?.selectionStart === 0 && e.target?.selectionEnd === 0;
      if (empty || atStart) {
        e.preventDefault();
        onRecallPrev();
        return;
      }
    }
    if (onRecallNext && e.key === 'ArrowDown' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const empty = input.length === 0;
      const atEnd = e.target?.selectionStart === input.length && e.target?.selectionEnd === input.length;
      if (empty || atEnd) {
        e.preventDefault();
        onRecallNext();
        return;
      }
    }

    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    // Eat the Enter only when there is genuinely nothing to send (empty
    // composer / unsettled uploads) — that avoids queuing a no-op WS
    // frame and re-marking the session as Thinking… on every keystroke.
    // A non-empty Enter DOES fire onSend even while the agent is
    // processing: that is a steer / send-while-busy message, which the
    // server coalesces into the in-flight turn (vision §2).
    if (!canSend) return;
    onSend();
  }, [onSend, canSend, onRecallPrev, onRecallNext, input, slashMatches, slashActive, acceptSlash, onInputChange]);

  // The two mic-style buttons are mutually exclusive — when
  // continuous listening is on, hide the manual record button so the
  // user can't accidentally double-capture an utterance via both
  // pipelines at once.
  const showAlways = alwaysListening !== undefined && Platform.OS === 'web';
  const showMic = (
    recording !== undefined
    && Platform.OS === 'web'
    && !alwaysListening
  );

  return (
    <View style={styles.composerWrap}>
      {slashMatches.length > 0 && (
        <View style={styles.slashMenu}>
          {slashMatches.map((c, i) => (
            <TouchableOpacity
              key={c.name}
              style={[styles.slashRow, i === slashActive && styles.slashRowActive]}
              // @ts-ignore — web hover transition
              {...(Platform.OS === 'web'
                ? { className: 'oa-side-row', onMouseEnter: () => setSlashActive(i) } as any
                : {})}
              onPress={() => acceptSlash(c)}
            >
              <Text style={styles.slashName}>/{c.name}</Text>
              {c.description && (
                <Text style={styles.slashDesc} numberOfLines={1}>{c.description}</Text>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View
        style={styles.composer}
        // @ts-ignore — web focus-within affordance (border brightens on focus)
        {...(Platform.OS === 'web' ? { className: 'oa-composer' } : {})}
      >
        {files.length > 0 && (
          <View style={styles.pendingList}>
            {files.map((f, idx) => {
              const failed = !!f.error;
              const uploading = !!f.uploading;
              const isImage = f.kind === 'image';
              const showThumbnail = isImage && !!f.previewUrl;
              const glyph = failed ? 'alert-circle' : uploading ? 'loader' : 'paperclip';
              const glyphColor = failed ? colors.error : colors.textSecondary;
              return (
                <View
                  key={f.id}
                  style={[
                    styles.pendingChip,
                    showThumbnail && styles.pendingChipWithThumb,
                    failed && styles.pendingChipError,
                    uploading && styles.pendingChipUploading,
                  ]}
                  // @ts-ignore — web-only pulse so the user sees the chip is mid-upload
                  {...(Platform.OS === 'web' && uploading ? { className: 'oa-pulse' } : {})}
                >
                  {showThumbnail ? (
                    <Image
                      source={{ uri: f.previewUrl }}
                      style={styles.pendingThumb}
                      resizeMode="cover"
                    />
                  ) : (
                    <Feather name={glyph as any} size={10} color={glyphColor} />
                  )}
                  <Text
                    style={[styles.pendingText, failed && styles.pendingTextError]}
                    numberOfLines={1}
                  >
                    {failed
                      ? `${f.filename} — upload failed`
                      : uploading
                        ? `${f.filename} — uploading…`
                        : f.filename}
                  </Text>
                  {failed && onRetryFile && (
                    <TouchableOpacity
                      onPress={() => onRetryFile(idx)}
                      accessibilityLabel="Retry upload"
                      // @ts-ignore — web press affordance
                      {...(Platform.OS === 'web' ? { className: 'oa-press' } : {})}
                    >
                      <Feather name="refresh-cw" size={10} color={colors.primary} />
                    </TouchableOpacity>
                  )}
                  {onRemoveFile && (
                    <TouchableOpacity
                      onPress={() => onRemoveFile(idx)}
                      // @ts-ignore — web press affordance
                      {...(Platform.OS === 'web' ? { className: 'oa-press' } : {})}
                    >
                      <Feather name="x" size={11} color={failed ? colors.error : colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </View>
        )}

        <View style={styles.inputRow}>
          {Platform.OS === 'web' ? (
            <textarea
              ref={setFieldRef as any}
              value={input}
              onChange={(e: any) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              style={{
                flex: 1, background: 'transparent', border: 'none',
                paddingLeft: 0, paddingRight: 0, paddingTop: 6, paddingBottom: 6,
                color: colors.text, fontSize: 14, lineHeight: 1.5,
                fontFamily: font.sans,
                minHeight: COMPOSER_INPUT_BASE_HEIGHT,
                maxHeight: COMPOSER_INPUT_BASE_HEIGHT * 4,
                overflowY: 'hidden',
                resize: 'none', outline: 'none',
              } as any}
            />
          ) : (
            <TextInput
              ref={setFieldRef as any}
              style={styles.textInput}
              value={input} onChangeText={onInputChange}
              placeholder={placeholder} placeholderTextColor={colors.textMuted}
              onSubmitEditing={onSend} returnKeyType="send" multiline
            />
          )}
        </View>

        <View style={styles.composerActions}>
          <View style={styles.composerLeft}>
            {onPickFile && (
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={onPickFile}
                // @ts-ignore — web hover/press affordance
                {...(Platform.OS === 'web' ? { className: 'oa-icon-btn' } : {})}
              >
                <Feather name="paperclip" size={13} color={colors.textSecondary} />
              </TouchableOpacity>
            )}
            {modelOptions && modelOptions.length > 0 && onSelectModel && (
              <View>
                <TouchableOpacity
                  style={styles.modelChip}
                  onPress={() => setModelMenuOpen((v) => !v)}
                  accessibilityLabel="Choose model"
                  // @ts-ignore — web press affordance
                  {...(Platform.OS === 'web' ? { className: 'oa-press' } : {})}
                >
                  <Feather name="cpu" size={10} color={colors.textSecondary} />
                  <Text style={styles.modelChipLabel} numberOfLines={1}>
                    {activeModel ? activeModel.label : 'Auto'}
                  </Text>
                  <Feather
                    name={modelMenuOpen ? 'chevron-up' : 'chevron-down'}
                    size={10}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
                {modelMenuOpen && (
                  <ScrollView
                    style={styles.modelMenu}
                    contentContainerStyle={styles.modelMenuContent}
                  >
                    <TouchableOpacity
                      style={[styles.modelRow, !activeModelId && styles.modelRowActive]}
                      // @ts-ignore — web hover transition
                      {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
                      onPress={() => { onSelectModel(undefined); setModelMenuOpen(false); }}
                    >
                      <Feather
                        name="zap"
                        size={11}
                        color={!activeModelId ? colors.primary : colors.textMuted}
                      />
                      <View style={styles.modelRowText}>
                        <Text style={styles.modelRowTitle}>Auto (router)</Text>
                        <Text style={styles.modelRowSub}>Let the router pick</Text>
                      </View>
                    </TouchableOpacity>
                    {groupedModels.map(({ family, hint, tone, rows }) => (
                      <View key={family}>
                        <View style={styles.modelGroupHead}>
                          <Text style={styles.modelGroupTitle} numberOfLines={1}>{family}</Text>
                          {hint ? (
                            <Text
                              style={[
                                styles.modelRowHint,
                                tone === 'bad' ? { color: colors.error }
                                  : tone === 'warn' ? { color: colors.warning }
                                  : tone === 'ok' ? { color: colors.success }
                                  : null,
                              ]}
                              numberOfLines={1}
                            >
                              {hint}
                            </Text>
                          ) : null}
                        </View>
                        {rows.map((m) => (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.modelRow, m.id === activeModelId && styles.modelRowActive]}
                        // @ts-ignore — web hover transition
                        {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
                        onPress={() => { onSelectModel(m.id); setModelMenuOpen(false); }}
                      >
                        <Feather
                          name="cpu"
                          size={11}
                          color={m.id === activeModelId ? colors.primary : colors.textMuted}
                        />
                        <View style={styles.modelRowText}>
                          <Text style={styles.modelRowTitle} numberOfLines={1}>{m.label}</Text>
                          {m.provider && (
                            <Text style={styles.modelRowSub} numberOfLines={1}>{m.provider}</Text>
                          )}
                        </View>
                        {/* The headroom now lives once in the family header —
                            repeating it on every row said the same number
                            three times. What varies row to row is effort. */}
                        {m.effort ? (
                          <Text style={styles.modelRowEffort} numberOfLines={1}>{m.effort}</Text>
                        ) : null}
                      </TouchableOpacity>
                        ))}
                      </View>
                    ))}
                    {menuFooter ? (
                      <>
                        <View style={styles.modelMenuRule} />
                        {menuFooter}
                      </>
                    ) : null}
                  </ScrollView>
                )}
              </View>
            )}
            {showMic && (
              <TouchableOpacity
                style={[styles.iconBtn, recording && styles.iconBtnActive]}
                onPress={recording ? onStopRecord : onStartRecord}
                // @ts-ignore — web hover/press affordance
                {...(Platform.OS === 'web' ? { className: 'oa-icon-btn' } : {})}
              >
                <Feather
                  name={recording ? 'stop-circle' : 'mic'}
                  size={13}
                  color={recording ? colors.textInverse : colors.textSecondary}
                />
              </TouchableOpacity>
            )}
            {showAlways && (
              <TouchableOpacity
                style={[styles.iconBtn, alwaysListening && styles.iconBtnActive]}
                onPress={onToggleAlwaysListen}
                accessibilityLabel={
                  alwaysListening ? 'Stop continuous listening' : 'Start continuous listening'
                }
                // @ts-ignore — web hover/press affordance
                {...(Platform.OS === 'web' ? { className: 'oa-icon-btn' } : {})}
              >
                <Feather
                  name="headphones"
                  size={13}
                  color={alwaysListening ? colors.textInverse : colors.textSecondary}
                />
              </TouchableOpacity>
            )}
          </View>
          {processing && onStop ? (
            <TouchableOpacity
              style={styles.sendBtn}
              onPress={onStop}
              accessibilityLabel="Stop generating"
              // @ts-ignore — web press affordance
              {...(Platform.OS === 'web' ? { className: 'oa-press' } : {})}
            >
              <Feather name="square" size={11} color={colors.textInverse} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
              onPress={onSend}
              disabled={!canSend}
              accessibilityLabel="Send message"
              // @ts-ignore — web press affordance
              {...(Platform.OS === 'web' ? { className: 'oa-press' } : {})}
            >
              <Feather name="arrow-up" size={13} color={colors.textInverse} />
            </TouchableOpacity>
          )}
        </View>
      </View>
      {showHint && (
        <View style={styles.composerHintRow}>
          <Text style={styles.composerHint}>
            <Text style={styles.kbd}>Enter</Text> to send · <Text style={styles.kbd}>Shift+Enter</Text> for newline
          </Text>
          {input.length > 800 && (
            <Text style={[styles.composerHint, styles.charCount]}>
              {input.length.toLocaleString()} chars
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  composerWrap: {
    paddingHorizontal: 20, paddingBottom: 12, paddingTop: 4,
  },
  slashMenu: {
    maxWidth: 760, width: '100%', alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    marginBottom: 6, paddingVertical: 4,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1, shadowRadius: 12,
  },
  slashRow: {
    flexDirection: 'row', alignItems: 'baseline', gap: 10,
    paddingHorizontal: 12, paddingVertical: 6,
    marginHorizontal: 4, borderRadius: radius.sm,
  },
  slashRowActive: {
    backgroundColor: colors.hover,
  },
  slashName: {
    fontSize: 12, color: colors.text, fontWeight: '600',
    fontFamily: font.mono,
  },
  slashDesc: {
    flex: 1, fontSize: 11, color: colors.textMuted,
  },
  composer: {
    maxWidth: 760, width: '100%', alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 2,
    elevation: 1,
  },
  pendingList: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 5,
    marginBottom: 8,
  },
  pendingChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.sidebar,
    borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 3,
    borderWidth: 1, borderColor: colors.borderLight,
    maxWidth: 220,
  },
  pendingChipError: {
    borderColor: colors.error,
    backgroundColor: colors.surface,
  },
  pendingChipUploading: {
    borderColor: colors.borderLight,
    opacity: 0.75,
  },
  pendingChipWithThumb: {
    paddingLeft: 3, paddingVertical: 2,
  },
  pendingThumb: {
    width: 22, height: 22,
    borderRadius: radius.xs,
    backgroundColor: colors.codeBg,
  },
  pendingText: {
    fontSize: 11, color: colors.textSecondary, fontWeight: '500',
    flexShrink: 1,
  },
  pendingTextError: {
    color: colors.error,
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 4,
  },
  textInput: {
    flex: 1, color: colors.text, fontSize: 14,
    paddingVertical: 6, paddingHorizontal: 0,
    minHeight: COMPOSER_INPUT_BASE_HEIGHT,
    maxHeight: COMPOSER_INPUT_BASE_HEIGHT * 4,
  },
  composerActions: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 4,
  },
  composerLeft: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  modelChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.borderLight,
    backgroundColor: colors.surface,
    maxWidth: 170,
  },
  modelChipLabel: {
    fontSize: 11, color: colors.textSecondary,
    fontFamily: font.mono, fontWeight: '500',
    flexShrink: 1,
  },
  modelMenu: {
    position: 'absolute',
    bottom: 32, left: 0, minWidth: 220, maxWidth: 320,
    // SOLID, not `colors.surface` (~72% opaque): this menu floats over the
    // transcript, and at that opacity the page behind it read straight
    // through the model names. A dropdown has to be legible against
    // whatever happens to be underneath it.
    backgroundColor: colors.panelBgSolid,
    // An agent with a dozen models made this list taller than the window
    // with no way to reach the bottom entries.
    maxHeight: 320,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1, shadowRadius: 12,
    zIndex: 50,
  },
  modelMenuContent: { paddingVertical: 4 },
  modelRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 6,
    marginHorizontal: 4, borderRadius: radius.sm,
  },
  modelRowActive: { backgroundColor: colors.hover },
  modelRowText: { flex: 1, minWidth: 0 },
  modelRowTitle: { fontSize: 12, color: colors.text, fontWeight: '500' },
  modelRowSub: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  iconBtn: {
    width: 28, height: 28, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  iconBtnActive: { backgroundColor: colors.primary },
  sendBtn: {
    width: 28, height: 28, borderRadius: radius.sm,
    backgroundColor: colors.text,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.25 },
  composerHintRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 16, marginTop: 6,
  },
  composerHint: {
    fontSize: 10, color: colors.textMuted,
    textAlign: 'center',
    fontFamily: font.mono,
  },
  charCount: {
    color: colors.textSecondary,
  },
  kbd: {
    fontSize: 10, color: colors.textSecondary,
    fontFamily: font.mono, fontWeight: '500',
  },
  modelGroupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 2,
    gap: 8,
  },
  modelGroupTitle: {
    fontFamily: font.sans,
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  modelRowEffort: {
    fontFamily: font.mono,
    fontSize: 10.5,
    color: colors.textMuted,
  },
  modelRowHint: { fontSize: 10, color: colors.textMuted, marginLeft: 8 },
  modelMenuRule: {
    height: 1, backgroundColor: colors.borderLight,
    marginVertical: 4, marginHorizontal: 8,
  },
});
