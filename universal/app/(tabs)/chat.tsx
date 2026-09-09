/**
 * Chat screen — editorial single-column flow, no left/right bubbles.
 * Inspired by Claude Code / Codex: messages read like a document, with
 * user prompts as left-rule quotes and assistant replies as full-width
 * prose. Tool invocations inline as compact rows.
 *
 * Voice mode: when always-listening is toggled on, the screen shows a
 * compact voice bar (SoundWaves + caption + webcam/screen toggles) above
 * the transcript and streams the mic through the active chat session.
 */

import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, Image,
} from 'react-native';

import type { Attachment } from '../../../common/types';
import { runRoutePath, type RunLaunchTarget, type MemoryTarget } from '../../../common/types';
import { attachmentsForSend } from '../../../common/attachments';
import { chatSessionIntent, resolveChatAnchor } from '../../../common/search-navigation';
import { useConnection } from '../../stores/connection';
import { useChat } from '../../stores/chat';
import { sessionReadGuard } from '../../stores/sessionReadAccess';
import { useEvents } from '../../stores/events';
import { useSearch } from '../../stores/search';
import { fetchChildSessions, fetchSessions } from '../../services/api';
import MessageComposer, { type PendingFile, type SlashCommand } from '../../components/MessageComposer';
import MessageList from '../../components/MessageList';
import SharedPresence, { useSharedView } from '../../components/SharedPresence';
import SessionSharing from '../../components/SessionSharing';
import SessionDetailsDrawerShell from '../../components/SessionDetailsDrawer';
import BrandLogo from '../../components/BrandLogo';
import {
  useHeaderInset,
  HeaderMenuAndBack,
  HeaderMenu,
  HeaderRight,
  HeaderSessionDetails,
} from '../../components/screenHeader';
import PopupMenu from '../../components/PopupMenu';
import Notice from '../../components/Notice';
import { NO_DRAG } from '../../components/DragRegion';
import { goBack } from '../../services/windows';
import { useNavHistory } from '../../stores/navHistory';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { Skeleton, SkeletonLines } from '../../components/Skeleton';
import { useConfirm } from '../../components/ConfirmDialog';
import { useRenameSession } from '../../components/RenameSessionDialog';
import {
  uploadFile, guessMimeType, listDbModels,
  getSessionModelPin, pinSessionModel, unpinSessionModel, isAgentUnreachable,
  getGatewayCommands, listServingAccounts, listSessionMessages, getToolInvocationDetail,
} from '../../services/api';
import { modelEffort, modelFamily } from '../../../common/types';
import type { ModelEntry, GatewayCommandSpec, ProviderAccounts } from '../../../common/types';
import AgentSwitcher from '../../components/AgentSwitcher';
import { formatDuration } from '../../components/AccountsPanel';

// Commands that act on the agent, not on one conversation: they must be
// sent without a session_id (see WSClient.sendCommand). Everything else is
// scoped to the chat tab it was typed in.
const AGENT_WIDE_COMMANDS = new Set(['help', 'usage', 'update', 'restart', 'status', 'queue']);

// Resolved once: the packaged app icon, as a URL the notification layer can
// load. ``resolveAssetSource`` is the React-Native-Web way to turn a bundled
// asset into a URI; if anything about that fails we simply omit the icon and
// get the old fallback behaviour rather than a broken notification.
const NOTIFICATION_ICON: string | undefined = (() => {
  try {
    const src = Image.resolveAssetSource(require('../../assets/app-icon.png'));
    return src?.uri;
  } catch {
    return undefined;
  }
})();

const SUGGESTED_PROMPTS: { label: string; prompt: string; icon: string }[] = [
  { label: 'Explain a concept', prompt: 'Explain ', icon: 'book-open' },
  { label: 'Write code', prompt: 'Write a function that ', icon: 'code' },
  { label: 'Plan a task', prompt: 'Help me plan ', icon: 'list' },
  { label: 'Summarize', prompt: 'Summarize the key points of ', icon: 'align-left' },
];
import { useVoiceConfig } from '../../stores/voice';
import {
  startWebcamCapture, startScreenCapture, useStreamingMic, useAudioPlayback,
  type VideoStreamHandle,
} from '../../services/voice';
import SoundWaves, { type SoundWavesState } from '../../components/SoundWaves';
import { colors, font, radius } from '../../theme';

const log = (event: string, data?: Record<string, unknown>) => {
  console.log(`[chat:voice] ${event}`, data ?? {});
};

export default function ChatScreen() {
  const headerInset = useHeaderInset();
  const ws = useConnection((s) => s.ws);
  const currentUserHandle = useConnection((s) => s.config?.handle);
  const router = useRouter();
  const navigation = useNavigation<any>();
  const routeParams = useLocalSearchParams<{
    session?: string;
    message?: string;
    toolInvocation?: string;
  }>();
  // Fine-grained selectors instead of the whole-store `useChat()`. The
  // no-arg form returns a freshly-merged state object on EVERY mutation,
  // so this ~1600-line screen used to re-render on every store change —
  // including unrelated fields. State selectors below subscribe only to
  // the slices this screen reads; action selectors return stable refs and
  // never trigger a re-render on their own.
  const sessions = useChat((s) => s.sessions);
  const activeSessionId = useChat((s) => s.activeSessionId);
  useSharedView('session', activeSessionId || undefined);
  const sessionsHydrated = useChat((s) => s.sessionsHydrated);
  const createSession = useChat((s) => s.createSession);
  const setActiveSession = useChat((s) => s.setActiveSession);
  const removeSession = useChat((s) => s.removeSession);
  const confirm = useConfirm();
  const renameSession = useRenameSession();
  const addUserMessage = useChat((s) => s.addUserMessage);
  const editUserMessage = useChat((s) => s.editUserMessage);
  const setDraftInput = useChat((s) => s.setDraftInput);
  const setLlmPin = useChat((s) => s.setLlmPin);
  const setSystemPrompt = useChat((s) => s.setSystemPrompt);
  const hydrateFromServer = useChat((s) => s.hydrateFromServer);
  const mergeMessageWindow = useChat((s) => s.mergeMessageWindow);
  const loadEarlierMessages = useChat((s) => s.loadEarlierMessages);
  const chatSearchDestination = useSearch((s) => s.chatDestination);
  const clearChatSearchDestination = useSearch((s) => s.clearChatDestination);
  // Delete a chat session behind a confirmation dialog (vision §16: sessions
  // are durable — removal is an explicit, confirmed action). The server
  // cascades the delete to every sub-agent session this chat spawned, so the
  // copy warns about it up front. Only manual chats reach this path (the
  // affordances are gated to ``origin === 'chat'``).
  const confirmAndRemove = useCallback(
    async (ses: { id: string; title?: string }) => {
      const ok = await confirm({
        title: 'Delete chat',
        message:
          `Delete "${ses.title || 'this chat'}"? This permanently removes the ` +
          'conversation and any sub-agent sessions it spawned. This cannot be undone.',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger',
      });
      if (ok) removeSession(ses.id);
    },
    [confirm, removeSession],
  );
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [llmModels, setLlmModels] = useState<ModelEntry[]>([]);
  // Set when the server refuses a model pin, so the composer can say why
  // the chip snapped back instead of leaving the rejection invisible.
  const [modelPinError, setModelPinError] = useState<string | null>(null);
  const [anchorError, setAnchorError] = useState<string | null>(null);
  // The gateway's command registry. `null` until it loads (or if it fails),
  // in which case the composer falls back to the local handlers alone.
  const [gatewayCommands, setGatewayCommands] = useState<GatewayCommandSpec[] | null>(null);
  // Which subscription account serves each provider, and how much of its
  // window is left. Shown beside each model so "which model can I still
  // use" is answerable without leaving the composer.
  const [accounts, setAccounts] = useState<ProviderAccounts[] | null>(null);
  useEffect(() => {
    if (!ws) return;
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await listServingAccounts();
        if (!cancelled) setAccounts(rows);
      } catch (e) {
        // An older gateway has no /api/accounts. The picker simply shows no
        // hints — it must never lose the model list over this.
        console.debug('[chat] serving accounts unavailable:', e);
      }
    };
    void load();
    // Quota windows tick down in hours; a limit lifts on a timer.
    const t = setInterval(() => { void load(); }, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [ws]);
  useEffect(() => {
    if (!ws) return;
    let cancelled = false;
    (async () => {
      try {
        const specs = await getGatewayCommands();
        if (!cancelled) setGatewayCommands(specs);
      } catch (e) {
        // An older gateway has no /api/commands. Not an error worth showing:
        // the local list still drives the menu.
        console.debug('[chat] gateway command registry unavailable:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [ws]);
  // Lazy-load the LLM catalogue once the WS is up — the picker shows
  // models opted into ``enabled`` so disabled rows don't pollute it.
  //
  // Re-read it on focus as well. Loading once on connect meant a model added
  // or enabled in Settings was invisible in the picker until the whole app
  // was restarted, which reads as "the model didn't save".
  const loadLlmModels = useCallback(async () => {
    try {
      setLlmModels(await listDbModels({ enabledOnly: true, kind: 'llm' }));
    } catch (e) {
      console.error('[chat] failed to load LLM catalogue:', e);
    }
  }, []);
  useEffect(() => {
    if (!ws) return;
    void loadLlmModels();
  }, [ws, loadLlmModels]);
  useFocusEffect(useCallback(() => {
    if (ws) void loadLlmModels();
  }, [ws, loadLlmModels]));
  const isDesktop = typeof window !== 'undefined' && !!window.desktop?.isDesktop;
  const [recording, setRecording] = useState(false);
  const voiceLanguage = useVoiceConfig((s) => s.config.language);
  const voiceConfig = useVoiceConfig((s) => s.config);
  const setVoiceConfig = useVoiceConfig((s) => s.setConfig);
  const mediaRecorderRef = useRef<any>(null);
  const chunksRef = useRef<Blob[]>([]);
  // The composer's underlying text field, so a stray printable keystroke
  // anywhere on the chat screen can be routed into it (type-to-focus).
  const composerInputRef = useRef<any>(null);
  // Monotonic per-mount counter for stable chip ids — collisions across
  // remounts don't matter (state resets), and we only need uniqueness
  // within one ``pendingFiles`` array.
  const nextPendingId = useRef(0);
  const newPendingId = () => `pf-${++nextPendingId.current}`;
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // Voice mode state
  const [hasTts, setHasTts] = useState<boolean | null>(null);
  const [webcamOn, setWebcamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const webcamHandleRef = useRef<VideoStreamHandle | null>(null);
  const screenHandleRef = useRef<VideoStreamHandle | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSessionId ?? null);
  activeSessionIdRef.current = activeSessionId ?? null;

  // Latest-value refs mirrored on every render. The callbacks handed to the
  // memoized <MessageList/> (onEditUser/onRegenerate/onOpenChild/…) MUST keep
  // a stable identity, otherwise MessageList's React.memo is defeated and the
  // whole transcript re-renders — markdown re-parse, syntax highlight, the
  // full 60-node window — on *every keystroke* in the composer. The natural
  // useCallback deps here are unstable: ``activeSession`` is a fresh
  // sessions.find() object each render, ``router`` is a new object each render
  // (useRouter), and ``ws`` flips on reconnect. Reading them through refs lets
  // those callbacks be created once with empty/stable deps.
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const routerRef = useRef(router);
  routerRef.current = router;
  const handleLoadEarlier = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (sessionId) await loadEarlierMessages(sessionId);
  }, [loadEarlierMessages]);
  // Mirrors the live composer text so the session-switch handler can flush the
  // outgoing draft synchronously (the persist write itself is debounced).
  const inputValueRef = useRef('');
  inputValueRef.current = input;

  const browserAvailable =
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const voiceOn = voiceConfig.chatAlwaysListen && browserAvailable;
  const langHint = voiceConfig.language && voiceConfig.language !== 'auto'
    ? voiceConfig.language : undefined;

  const toggleAlwaysListen = useCallback(() => {
    setVoiceConfig({ chatAlwaysListen: !voiceConfig.chatAlwaysListen });
  }, [setVoiceConfig, voiceConfig.chatAlwaysListen]);

  const handleStreamTranscript = useCallback((text: string) => {
    if (activeSessionId) {
      log('stt.committed', { chars: text.length });
      addUserMessage(activeSessionId, text);
    }
  }, [activeSessionId, addUserMessage]);

  const { vadState, audioState, energy, micError } = useStreamingMic({
    ws,
    sessionId: activeSessionId ?? null,
    enabled: voiceConfig.chatAlwaysListen,
    voiceConfig,
    sessionOpen: { profile: 'realtime', clientKind: 'webapp', language: langHint },
    onTranscript: handleStreamTranscript,
    onLog: log,
  });

  useAudioPlayback({
    ws,
    sessionId: activeSessionId ?? null,
    enabled: !voiceConfig.chatAlwaysListen,
  });

  // TTS-availability check on focus
  useFocusEffect(
    useCallback(() => {
      if (!ws || !activeSessionId) return;
      void (async () => {
        try {
          const all = await listDbModels({ enabledOnly: true });
          setHasTts(all.some((m) => m.kind === 'tts'));
        } catch (e) {
          log('tts.check_error', { error: String(e) });
          setHasTts(true);
        }
      })();
      return () => {
        if (webcamHandleRef.current) {
          webcamHandleRef.current.stop();
          webcamHandleRef.current = null;
        }
        if (screenHandleRef.current) {
          screenHandleRef.current.stop();
          screenHandleRef.current = null;
        }
        setWebcamOn(false);
        setScreenOn(false);
      };
    }, [ws, activeSessionId]),
  );

  // Hydrate composer from the active session's persisted draft. Runs
  // only on session-switch (id change) so we don't clobber whatever
  // the user is currently typing.
  const hydratedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId) return;
    if (hydratedSessionRef.current === activeSessionId) return;
    const prevId = hydratedSessionRef.current;
    // Flush the OUTGOING session's draft synchronously before swapping, so
    // switching sessions within the persist debounce window never drops the
    // text still sitting in the composer.
    if (prevId) setDraftInput(prevId, inputValueRef.current);
    hydratedSessionRef.current = activeSessionId;
    const draft = activeSession?.draftInput ?? '';
    setInput(draft);
  }, [activeSessionId, activeSession?.draftInput, setDraftInput]);

  // Persist composer text back into the active session, DEBOUNCED. Writing on
  // every keystroke rebuilt the whole ``sessions`` array in the store, which
  // re-ran the sidebar's filter+sort (and, while searching, a full-text scan
  // over every message of every session) and re-rendered this screen a second
  // time per character. The draft is an in-memory convenience — it survives a
  // session switch, not a reload — so collapsing writes to one ~400ms after
  // typing pauses is invisible to the user and keeps the keystroke path off
  // the store entirely. The trailing timer is cleared on switch/unmount.
  useEffect(() => {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    const t = setTimeout(() => setDraftInput(sid, input), 400);
    return () => clearTimeout(t);
  }, [input, activeSessionId, setDraftInput]);

  // Deep-link: a ``?session=<id>`` param (set when a delegation card is
  // pressed, or by linking into a run's child session) drives the active
  // session. Guard with a ref so this one-way application never ping-pongs
  // with the store's own ``setActiveSession`` → URL update.
  const appliedParamRef = useRef<string | null>(null);
  const startNewSession = useCallback(() => {
    const id = createSession();
    // Commit both sources of navigation truth together. The store keeps the
    // live transcript while Chat is unmounted; the route makes that exact
    // transcript reachable again when returning from Settings or another tab.
    appliedParamRef.current = id;
    routerRef.current.push(chatSessionIntent(id) as any);
    return id;
  }, [createSession]);
  useEffect(() => {
    const want = typeof routeParams.session === 'string' ? routeParams.session : undefined;
    if (!want) {
      appliedParamRef.current = null;
      return;
    }
    if (appliedParamRef.current === want) return;
    appliedParamRef.current = want;
    if (want === activeSessionId) return;
    setActiveSession(want);
  }, [routeParams.session, activeSessionId, setActiveSession]);

  // Expo Router v5 can drop changed query parameters when a Drawer replaces
  // its already-focused Chat route. Search therefore carries the exact
  // in-app message/tool destination in account-scoped memory as well. Clear a
  // stale anchor as soon as the user intentionally switches to another chat.
  useEffect(() => {
    if (!chatSearchDestination || chatSearchDestination.sessionId === activeSessionId) return;
    clearChatSearchDestination();
  }, [activeSessionId, chatSearchDestination, clearChatSearchDestination]);

  const routeAnchorSession = typeof routeParams.session === 'string'
    ? routeParams.session : undefined;
  const routeAnchorMessage = typeof routeParams.message === 'string'
    ? routeParams.message : undefined;
  const routeAnchorTool = typeof routeParams.toolInvocation === 'string'
    ? routeParams.toolInvocation : undefined;
  // A fresh in-app destination wins over possibly stale route params. Root
  // chat destinations are explicit too, so opening a conversation clears an
  // earlier message/tool highlight even if the Drawer drops the new params.
  const resolvedAnchor = resolveChatAnchor({
    sessionId: routeAnchorSession,
    messageId: routeAnchorMessage,
    toolInvocationId: routeAnchorTool,
  }, chatSearchDestination, activeSessionId);
  const anchorSession = resolvedAnchor.sessionId;
  const anchorMessage = resolvedAnchor.messageId;
  const anchorToolInvocation = resolvedAnchor.toolInvocationId;
  const anchorGeneration = resolvedAnchor.generation;

  // Exact operational-search anchor. The search overlay only navigates; Chat
  // owns the authorized messages-around/tool-detail fetch and range merge.
  useEffect(() => {
    if (!anchorSession || !anchorMessage) return;
    const controller = new AbortController();
    const current = sessionReadGuard(anchorSession);
    setAnchorError(null);
    void (async () => {
      try {
        const [page, tool] = await Promise.all([
          listSessionMessages(
            anchorSession,
            { around: anchorMessage, before: 30, after: 30 },
            controller.signal,
          ),
          anchorToolInvocation
            ? getToolInvocationDetail(anchorToolInvocation, controller.signal)
            : Promise.resolve(undefined),
        ]);
        if (controller.signal.aborted || !current()) return;
        if (page.anchor_found === false) {
          setAnchorError('This result is no longer available.');
          return;
        }
        mergeMessageWindow(page, tool);
      } catch (error) {
        if (controller.signal.aborted) return;
        setAnchorError(
          error instanceof Error && /404|not found/i.test(error.message)
            ? 'This result is no longer available.'
            : 'Could not load this message. Try opening the result again.',
        );
      }
    })();
    return () => controller.abort();
  }, [
    anchorGeneration,
    anchorMessage,
    anchorSession,
    anchorToolInvocation,
    mergeMessageWindow,
  ]);

  // Navigate into a child session (delegation card / run node) by swapping
  // the active session and reflecting it in the URL so it's deep-linkable.
  // Record it as the applied param too: setActiveSession commits synchronously
  // (so the effect above never sees want≠active to record it itself), and
  // without this a later sidebar switch-away would re-apply the now-stale
  // ``?session=<child>`` and yank the user back into the child.
  const openChildSession = useCallback((childSessionId: string) => {
    appliedParamRef.current = childSessionId;
    setActiveSession(childSessionId);
    // Replace by the canonical path so the URL stays a clean, round-trippable
    // ``/chat?session=…`` while staying on the same screen (no push/remount).
    routerRef.current.replace({ pathname: '/(tabs)/chat', params: { session: childSessionId } });
  }, [setActiveSession]);

  // A chat turn that ran a scheduled task / workflow shows a RunLaunchCard;
  // pressing it opens that firing's execution screen (``/runs/{id}``) — the
  // same single-run destination the sidebar's Recent feed uses.
  const openRun = useCallback((target: RunLaunchTarget) => {
    const path = runRoutePath(target);
    if (path) routerRef.current.push(`/${path}` as any);
  }, []);

  // A memory-vault tool chip deep-links into the Memory tab: a single-note op
  // opens that note's markdown screen (the same destination as clicking its
  // graph node — see (tabs)/memory/index.tsx ``openNote``); a search / list /
  // maintenance op opens the memory graph.
  const openMemory = useCallback((target: MemoryTarget) => {
    if (target.kind === 'note') {
      routerRef.current.push({
        pathname: '/(tabs)/memory/[...path]',
        params: { path: target.path.split('/') },
      });
    } else {
      routerRef.current.push('/(tabs)/memory');
    }
  }, []);

  // Drive the (drawer) header's left control. A child session — a delegation
  // sub-agent, a scheduled firing, or a workflow node — gets a real "back"
  // chevron instead of the drawer toggle: it swaps to the parent session in
  // place when that session is loaded (walking the lineage to any depth),
  // and otherwise steps back through navigation history to whatever screen
  // opened it (e.g. a run detail). A top-level chat session keeps the drawer
  // toggle. ``router``/``openChildSession`` are intentionally out of the deps
  // (``useRouter`` returns a fresh ref each render, which would re-run
  // setOptions every frame); the captured refs stay correct because the
  // effect re-runs whenever the session being viewed actually changes.
  const parentSession = activeSession?.parentSessionId
    ? sessions.find((s) => s.id === activeSession.parentSessionId)
    : undefined;
  const isChildSession = !!activeSession
    && (!!activeSession.parentSessionId
      || (!!activeSession.origin && activeSession.origin !== 'chat'));
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () =>
        isChildSession ? (
          <HeaderMenuAndBack
            onPress={() => {
              // If this child was drilled into from a NON-chat screen (e.g. a
              // run detail's sub-agent card), return to that screen via the
              // route trail. Otherwise it's an in-chat delegation → swap to the
              // parent session in place (the session-lineage axis, any depth).
              const trail = useNavHistory.getState().trail;
              const prev = trail[trail.length - 2];
              if (prev && !prev.startsWith('/chat')) goBack(router);
              else if (parentSession) openChildSession(parentSession.id);
              else goBack(router);
            }}
          />
        ) : (
          <HeaderMenu />
        ),
      // Session details live in the right navigation drawer. The overflow menu
      // remains only for destructive chat actions, while the drawer button is
      // always available for every open session (including child/run sessions).
      headerRight: () =>
        activeSession ? (
          <HeaderRight>
            {!isChildSession ? (
              <PopupMenu
                triggerIcon="more-vertical"
                triggerSize={18}
                triggerColor={colors.textSecondary}
                triggerStyle={[styles.headerMenuBtn, NO_DRAG]}
                accessibilityLabel="Chat options"
                items={[
                  {
                    label: 'Rename',
                    icon: 'edit-2' as const,
                    onPress: () => renameSession(activeSession),
                  },
                  {
                    label: 'Delete chat',
                    icon: 'trash-2' as const,
                    destructive: true,
                    onPress: () => confirmAndRemove(activeSession),
                  },
                ]}
              />
            ) : null}
            <HeaderSessionDetails />
          </HeaderRight>
        ) : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, isChildSession, parentSession?.id, activeSession?.id, activeSession?.title, renameSession]);

  // A freshly-spawned child session fires a resource_event. V2 normally gets
  // its exact summary from history_changed; gateways without that realtime
  // feature fetch only this open parent's children. The unbounded flat list
  // remains a legacy-only fallback.
  useEffect(() => {
    const off = useEvents.getState().subscribe('session', () => {
      const search = useSearch.getState();
      const chat = useChat.getState();
      if (chat.sessionHistoryMode === 'v2') {
        if (search.capabilities?.features.history?.realtime_event === 'history_changed') return;
        const parentId = chat.activeSessionId;
        if (parentId) fetchChildSessions(parentId).then(hydrateFromServer).catch(() => {});
        return;
      }
      if (chat.sessionHistoryMode === 'legacy') {
        fetchSessions().then(hydrateFromServer).catch(() => {});
      }
    });
    return off;
  }, [hydrateFromServer]);

  // Auto-scroll: stick to the bottom while the agent streams live updates.
  // When the user scrolls away from the bottom, auto-scroll pauses and a
  // jump-to-bottom pill appears. Scrolling back to the very bottom
  // re-engages auto-scroll — the same pattern as Claude Code, VS Code,
  // Slack, and every chat application.
  const {
    scrollRef,
    onScroll,
    onContentSizeChange,
    isPinned,
    scrollToBottom,
  } = useAutoScroll({
    trackDeps: [
      activeSession?.messages.length,
      activeSession?.statusText,
      activeSession?.messages[activeSession?.messages.length - 1]?.text.length,
    ],
  });

  // Shared upload pipeline used by every file-source surface (native
  // file dialog on desktop, hidden ``<input type=file>`` on plain web,
  // and the drop-zone overlay below). Centralising it keeps the
  // ``setPendingFiles`` accumulation logic + error handling in one
  // spot.
  // Run a single browser File through the upload pipeline + drive the
  // chip state. Reused by the initial upload AND by the retry handler.
  const runUpload = useCallback((
    file: File,
    id: string,
    kind: 'image' | 'file',
    previewUrl?: string,
  ) => {
    const controller = new AbortController();
    const retry = () => runUpload(file, id, kind, previewUrl);
    setPendingFiles((prev) => prev.map((p) => p.id === id
      ? { id, filename: file.name, kind, uploading: true, previewUrl, abort: () => controller.abort(), retry }
      : p));
    (async () => {
      try {
        const result = await uploadFile(file, undefined, {
          kind,
          sessionId: activeSessionIdRef.current ?? undefined,
          signal: controller.signal,
        });
        setPendingFiles((prev) => prev.map((p) => p.id === id
          ? { id, filename: result.filename, attachment: result, kind, previewUrl, retry }
          : p));
      } catch (e: any) {
        if (e?.name === 'AbortError' || controller.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error('Upload failed:', file.name, msg);
        setPendingFiles((prev) => prev.map((p) => p.id === id
          ? { id, filename: file.name, kind, error: msg, previewUrl, retry }
          : p));
      }
    })();
  }, []);

  const uploadBrowserFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    // Spawn an in-flight placeholder chip per file *before* awaiting the
    // upload so the user gets immediate visual feedback.
    for (const file of files) {
      const id = newPendingId();
      const kind = file.type?.startsWith('image/') ? 'image' as const : 'file' as const;
      const previewUrl = kind === 'image' && typeof URL !== 'undefined'
        ? URL.createObjectURL(file) : undefined;
      // Push the placeholder first so the chip appears immediately;
      // runUpload then transitions it through uploading → ok/error.
      setPendingFiles((prev) => [
        ...prev,
        { id, filename: file.name, kind, uploading: true, previewUrl },
      ]);
      runUpload(file, id, kind, previewUrl);
    }
  }, [runUpload]);

  // Drag-and-drop attachments. Web + Electron only — RN mobile has no
  // OS drag source. We listen on ``window`` (not the composer) so the
  // whole chat surface is a drop target: dropping anywhere lights up
  // the same overlay and routes to the upload pipeline. Browsers fire
  // ``dragenter``/``dragleave`` per child element, so we maintain a
  // counter to know when the cursor has actually left the window.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof window === 'undefined') return;

    let depth = 0;

    const hasFiles = (e: DragEvent): boolean => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true;
      }
      return false;
    };

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragActive(false);
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      // Fire-and-forget — uploads are async and we don't block here.
      uploadBrowserFiles(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [uploadBrowserFiles]);

  // Browser notification when an assistant turn finishes while the
  // window is unfocused — modern desktop apps surface "your reply is
  // ready" without making the user babysit the tab. Requires the user
  // to have granted Notification permission at least once.
  const wasProcessingRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof document === 'undefined' || typeof Notification === 'undefined') return;
    const isProcessing = !!activeSession?.isProcessing;
    const fellEdge = wasProcessingRef.current && !isProcessing;
    wasProcessingRef.current = isProcessing;
    if (!fellEdge) return;
    if (document.hasFocus()) return;
    const askPermission = async () => {
      try {
        if (Notification.permission === 'default') {
          await Notification.requestPermission();
        }
        if (Notification.permission !== 'granted') return;
        const title = activeSession?.title || 'OpenAgent';
        const last = activeSession?.messages[activeSession.messages.length - 1];
        const body = last?.role === 'assistant'
          ? (last.text || '').slice(0, 140)
          : 'Reply ready';
        // Say WHICH icon. A Web Notification with no ``icon`` falls back to
        // the page favicon, which on this build was still the previous
        // artwork — the badge with the rounded frame and margins — so the
        // banner showed one icon while the Dock showed another. Naming the
        // app icon here means the notification no longer depends on which
        // asset happens to be stale.
        const notif = new Notification(title, { body, icon: NOTIFICATION_ICON, silent: false });
        notif.onclick = () => { window.focus(); notif.close(); };
        setTimeout(() => notif.close(), 8000);
      } catch (e) { /* ignore */ }
    };
    askPermission();
  }, [activeSession?.isProcessing, activeSession?.title, activeSession?.messages]);

  // Cmd/Ctrl+V on the composer textarea → if the clipboard carries
  // image bytes (a screenshot, copied screenshot from a chat app),
  // attach it instead of pasting nothing. We listen on the document
  // ``paste`` event so the textarea's default text-paste keeps working
  // when the clipboard only carries text.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof document === 'undefined') return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        if (it.kind !== 'file') continue;
        const f = it.getAsFile();
        if (f) files.push(f);
      }
      if (!files.length) return;
      e.preventDefault();
      uploadBrowserFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [uploadBrowserFiles]);

  // Global keyboard shortcuts (web + Electron). Kept narrow and
  // non-invasive — we only listen on ``window`` and bail out if the
  // event was already prevented by something else (a modal, IME, etc).
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof window === 'undefined') return;

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+K — new chat session.
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        startNewSession();
        return;
      }

      // Cmd/Ctrl+Backspace — clear composer text + abort any in-flight
      // upload chips. Only when the focus is on the composer textarea
      // so the user doesn't lose chat sidebar context unexpectedly.
      if (mod && e.key === 'Backspace') {
        const active = document.activeElement as HTMLElement | null;
        const isTextarea = active?.tagName === 'TEXTAREA';
        if (!isTextarea) return;
        e.preventDefault();
        setInput('');
        setPendingFiles((prev) => {
          prev.forEach((p) => p.abort?.());
          return [];
        });
        return;
      }

      // Esc — dismiss any failed upload chips (keep good + uploading).
      if (!mod && e.key === 'Escape') {
        setPendingFiles((prev) => prev.filter((p) => !p.error));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startNewSession]);

  // Switch the LLM pin for the active session. We must close the WS
  // session so the next sendMessage re-opens it with the new pin —
  // without this, the cached ``openedSessions`` entry on the WS keeps
  // the previous llmPin in force.
  //
  // The pin is also written through to ``/api/sessions/{id}/model``. It
  // belongs to the session, not to this device: a conversation resumed
  // from the CLI, another client, or a channel has to answer with the
  // model chosen here. Local state moves first so the chip responds
  // instantly, and rolls back if the server refuses (unregistered or
  // disabled model) so the chip never claims a model that is not in use.
  const handleSelectModel = useCallback((modelId: string | undefined) => {
    // With no session yet this used to return silently: the user picked a
    // model, the menu closed, the chip stayed on "Auto" and nothing said
    // why. Picking a model IS an intent to start a conversation, so create
    // the session and pin it — the same gesture the user thought they made.
    const sessionId = activeSessionId ?? startNewSession();
    if (!sessionId) return;
    const previous = sessions.find((s) => s.id === sessionId)?.llmPin;
    setLlmPin(sessionId, modelId);
    setModelPinError(null);
    if (ws && !ws.collaboration) ws.sendSessionClose(sessionId);
    (async () => {
      try {
        if (ws?.collaboration) await ws.sendSharedCommand(sessionId, '/model ' + (modelId || 'auto'));
        else if (modelId) await pinSessionModel(sessionId, modelId);
        else await unpinSessionModel(sessionId);
      } catch (e) {
        // A pin that never reached the agent is not a model problem, and
        // "Failed to fetch" is not something a user can act on. Name the
        // actual condition — the connection — so the next move is obvious.
        const msg = isAgentUnreachable(e)
          ? 'your agent is offline. Reconnect, then pick the model again.'
          : e instanceof Error ? e.message : String(e);
        console.error('[chat] failed to persist model pin:', msg);
        setLlmPin(sessionId, previous);
        setModelPinError(msg);
        if (ws && !ws.collaboration) ws.sendSessionClose(sessionId);
      }
    })();
  }, [ws, activeSessionId, sessions, setLlmPin, startNewSession]);

  // Reconcile the chip with the server's pin whenever a session becomes
  // active: it may have been pinned from another client, or by a `/model`
  // command in a channel, and the chip must show what will actually run.
  useEffect(() => {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    let cancelled = false;
    (async () => {
      try {
        const pin = await getSessionModelPin(sessionId);
        if (cancelled) return;
        setLlmPin(sessionId, pin.runtime_id ?? undefined);
      } catch (e) {
        // A session the server has never seen 404s here — that is not an
        // error, it just has no pin yet. Leave local state alone.
        console.debug('[chat] no server-side model pin for', sessionId, e);
      }
    })();
    return () => { cancelled = true; };
  }, [activeSessionId, setLlmPin]);

  // Serialize a session's transcript to a Markdown document and
  // trigger a browser download. Skips tool rows (they're noisy and
  // tend to be JSON dumps), keeps user + assistant turns + the model
  // attribution line.
  const exportSessionAsMarkdown = useCallback((sessionId: string) => {
    if (Platform.OS !== 'web') return;
    if (typeof document === 'undefined') return;
    const ses = sessions.find((s) => s.id === sessionId);
    if (!ses) return;
    const lines: string[] = [`# ${ses.title}`, ''];
    for (const m of ses.messages) {
      if (m.role === 'tool') continue;
      if (m.role === 'user') {
        lines.push('## You', '', m.text || '_(empty)_', '');
        if (m.attachments?.length) {
          for (const a of m.attachments) {
            lines.push(`- attached ${a.type}: \`${a.filename}\``);
          }
          lines.push('');
        }
      } else if (m.role === 'assistant') {
        const tag = m.model ? `## OpenAgent (${m.model})` : '## OpenAgent';
        lines.push(tag, '', m.text || '_(empty)_', '');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ses.title.replace(/[^a-z0-9-_.\s]/gi, '_')}.md`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 200);
  }, [sessions]);

  // Edit a previous user message and re-fire the turn from that
  // point. The store truncates everything after the edited message so
  // the new assistant reply lands on a clean tail (ChatGPT convention).
  const handleEditUser = useCallback((messageId: string, newText: string) => {
    const conn = wsRef.current;
    const sid = activeSessionIdRef.current;
    const ses = activeSessionRef.current;
    if (!conn || !sid) return;
    const original = ses?.messages.find((message) => message.id === messageId);
    const attachments = attachmentsForSend(original?.attachments);
    // Shared history belongs to every participant; a correction is a new turn.
    const ok = conn.collaboration || editUserMessage(sid, messageId, newText);
    if (!ok) return;
    conn.sendMessage(newText, sid, {
      llmPin: ses?.llmPin,
      systemPrompt: ses?.systemPrompt,
      attachments,
    });
  }, [editUserMessage]);

  // Cancel an in-flight assistant turn for the active session. Turns run
  // inside a server-side StreamSession whose cancel verb is the
  // ``interrupt`` frame (barge-in) — NOT the legacy ``command:stop``,
  // which targets a separate, unused queue and silently does nothing.
  // sendInterrupt routes to _cancel_active_turn so streaming + tool
  // execution actually halt and the server emits a terminal turn so the
  // composer un-sticks. ``reason: 'manual'`` = an explicit user stop.
  const handleStop = useCallback(() => {
    if (!ws || !activeSessionId) return;
    ws.sendInterrupt(activeSessionId, 'manual');
  }, [ws, activeSessionId]);

  // Resend the most recent user message verbatim (with its original
  // attachments). Used by the Regenerate button on the last assistant
  // bubble. Walks back from the tail to find the most recent
  // ``role: 'user'``; everything after it stays in the transcript so
  // the user can compare old vs new — ChatGPT-style.
  const handleRegenerate = useCallback(() => {
    const conn = wsRef.current;
    const sid = activeSessionIdRef.current;
    const ses = activeSessionRef.current;
    if (!conn || !sid || !ses) return;
    const lastUser = [...ses.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    const attachments = attachmentsForSend(lastUser.attachments);
    if (!conn.collaboration) addUserMessage(sid, lastUser.text || '(regenerate)', lastUser.attachments);
    conn.sendMessage(lastUser.text, sid, {
      llmPin: ses.llmPin,
      systemPrompt: ses.systemPrompt,
      attachments,
    });
  }, [addUserMessage]);

  // Up/Down recall — walk the user-message history when composer is
  // empty (or caret at boundary). Index = position from the tail.
  const recallIdxRef = useRef<number | null>(null);
  const userMessages = useMemo(
    () => (activeSession ? activeSession.messages.filter((m) => m.role === 'user') : []),
    [activeSession?.messages],
  );
  const recallPrev = useCallback(() => {
    if (!userMessages.length) return;
    const cur = recallIdxRef.current;
    const next = cur === null ? userMessages.length - 1 : Math.max(0, cur - 1);
    recallIdxRef.current = next;
    setInput(userMessages[next].text);
  }, [userMessages]);
  const recallNext = useCallback(() => {
    const cur = recallIdxRef.current;
    if (cur === null) return;
    const next = cur + 1;
    if (next >= userMessages.length) {
      recallIdxRef.current = null;
      setInput('');
      return;
    }
    recallIdxRef.current = next;
    setInput(userMessages[next].text);
  }, [userMessages]);

  // Type-to-focus: a printable keystroke anywhere on the focused chat
  // screen jumps into the composer and starts typing it — like Slack /
  // Discord / Telegram. Web/desktop only; native has no global key stream.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web' || typeof window === 'undefined') return;
      const onKey = (e: KeyboardEvent) => {
        // Leave shortcuts, IME composition and non-printing keys alone.
        if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
        // Only single printable characters; keep Space free to scroll.
        if (e.key.length !== 1 || e.key === ' ') return;
        // Don't hijack a keystroke already destined for a field.
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
        const ta = composerInputRef.current as HTMLTextAreaElement | null;
        // Bail when the composer isn't on screen (no session / hidden tab).
        if (!ta || ta.offsetParent === null) return;
        e.preventDefault();
        ta.focus();
        recallIdxRef.current = null;
        setInput((prev) => prev + e.key);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []),
  );

  const swState: SoundWavesState =
    audioState === 'playing' ? 'speaking'
    : activeSession?.isProcessing ? 'processing'
    : vadState === 'listening' ? 'listening'
    : 'idle';

  const caption = micError ? `Mic ${micError}`
    : swState === 'speaking' ? 'Speaking…'
    : swState === 'processing' ? (activeSession?.isReasoning ? 'Reasoning…' : 'Thinking…')
    : swState === 'listening' ? 'Listening…'
    : 'Speak any time';

  const handleSend = () => {
    recallIdxRef.current = null;
    if (!ws || !activeSessionId) return;
    const text = input.trim();
    // Failed uploads stay in pendingFiles as visible error chips so the
    // user knows the file didn't make it; they must dismiss explicitly.
    // Filter them out of the WS message + attachment list here.
    const sendableFiles = pendingFiles.filter(
      (f) => !f.error && !f.uploading && (f.attachment || f.remotePath),
    );
    if (!text && sendableFiles.length === 0) return;

    // Intercept gateway slash-commands typed with an argument (e.g.
    // "/model claude-opus", "/compact"). Commands whose ``action`` is
    // defined in slashCommands fire immediately on autocomplete selection
    // and never reach here; commands without ``action`` (model, help) get
    // their "/name " template inserted and the user types the rest — that
    // fully-formed "/name arg" arrives here. Route as a COMMAND frame so
    // the server's _handle_command branch runs instead of the agent.
    if (text.startsWith('/') && sendableFiles.length === 0) {
      const spaceIdx = text.indexOf(' ');
      const cmdName = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
      const cmdArg = spaceIdx === -1 ? undefined : text.slice(spaceIdx + 1).trim() || undefined;
      // Only intercept known gateway commands — unknown "/foo" text still
      // goes to the agent as a normal message.
      const GATEWAY_COMMANDS = new Set([
        'compact', 'model', 'new', 'clear', 'reset', 'stop',
        'status', 'queue', 'usage', 'context', 'update', 'restart', 'help',
      ]);
      if (GATEWAY_COMMANDS.has(cmdName)) {
        ws.sendCommand(cmdName as any, activeSessionId, cmdArg);
        setInput('');
        return;
      }
    }

    const attachments: Attachment[] = sendableFiles.flatMap((f) => {
      if (f.attachment) return [f.attachment];
      return f.remotePath ? [{ type: f.kind, path: f.remotePath, filename: f.filename }] : [];
    });

    if (!ws.collaboration) addUserMessage(activeSessionId, text, attachments.length ? attachments : undefined);
    ws.sendMessage(text, activeSessionId, {
      llmPin: activeSession?.llmPin,
      systemPrompt: activeSession?.systemPrompt,
      attachments: attachmentsForSend(attachments),
    });
    setInput('');
    // Drop only the chips we actually sent; keep failed + still-uploading
    // entries visible so the user notices them (and the next Enter can
    // attach the late-arriving files into a follow-up message).
    setPendingFiles((prev) => prev.filter((f) => f.error || f.uploading));
  };

  const handleFilePick = async () => {
    if (isDesktop && window.desktop?.pickFiles && window.desktop?.readFile) {
      type Picked = Awaited<ReturnType<NonNullable<typeof window.desktop.pickFiles>>>[number];
      let picked: Picked[] = [];
      try {
        picked = await window.desktop.pickFiles();
      } catch (e: any) {
        console.error('Native picker failed:', e);
        return;
      }
      if (!picked.length) return;

      // Reject oversized files before we spawn an in-flight chip — the
      // ``dialog:readFile`` IPC would otherwise refuse them with a
      // generic "readFile: too big" string and surface as a useless
      // error chip. Doing it here puts the actual size + the limit in
      // front of the user.
      const oversized = picked.filter((p) => p.size > 0 && p.size > p.maxBytes);
      const okPicked = picked.filter((p) => !(p.size > 0 && p.size > p.maxBytes));
      if (oversized.length) {
        setPendingFiles((prev) => [
          ...prev,
          ...oversized.map((p) => ({
            id: newPendingId(),
            filename: p.filename,
            kind: p.kind,
            error: `File too large (${(p.size / 1024 / 1024).toFixed(1)} MB; limit ${Math.round(p.maxBytes / 1024 / 1024)} MB)`,
          })),
        ]);
      }
      if (!okPicked.length) return;

      // Same placeholder-first flow as the web drop path.
      const items = okPicked.map((p) => ({
        meta: p,
        id: newPendingId(),
        controller: new AbortController(),
      }));
      setPendingFiles((prev) => [
        ...prev,
        ...items.map(({ id, meta, controller }) => ({
          id,
          filename: meta.filename,
          kind: meta.kind,
          uploading: true,
          abort: () => controller.abort(),
        })),
      ]);
      await Promise.allSettled(items.map(async ({ meta, id, controller }) => {
        try {
          const bytes = await window.desktop!.readFile!(meta.path);
          if (controller.signal.aborted) return;
          const blob = new Blob([bytes as BlobPart], { type: guessMimeType(meta.filename, meta.kind) });
          const file = new File([blob], meta.filename, { type: blob.type });
          const result = await uploadFile(file, undefined, {
            kind: meta.kind,
            sessionId: activeSessionIdRef.current ?? undefined,
            signal: controller.signal,
          });
          setPendingFiles((prev) => prev.map((p) => p.id === id
            ? { id, filename: result.filename, attachment: result, kind: meta.kind }
            : p));
        } catch (e: any) {
          if (e?.name === 'AbortError' || controller.signal.aborted) return;
          const msg = e instanceof Error ? e.message : String(e);
          console.error('Desktop upload failed:', meta.filename, msg);
          setPendingFiles((prev) => prev.map((p) => p.id === id
            ? { id, filename: meta.filename, kind: meta.kind, error: msg }
            : p));
        }
      }));
      return;
    }

    if (isDesktop && window.desktop?.pickFiles) {
      try {
        const picked = await window.desktop.pickFiles();
        if (picked.length) {
          setPendingFiles((prev) => [
            ...prev,
            ...picked.map((f) => ({
              id: newPendingId(),
              filename: f.filename,
              remotePath: f.path,
              kind: f.kind,
            })),
          ]);
        }
      } catch (e: any) {
        console.error('Native picker failed:', e);
      }
      return;
    }

    if (Platform.OS !== 'web') return;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = 'image/*,.pdf,.txt,.md,.csv,.json,.py,.js,.ts,.yaml,.yml,.log';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    fileInput.onchange = async () => {
      const files = Array.from(fileInput.files || []);
      document.body.removeChild(fileInput);
      await uploadBrowserFiles(files);
    };
    fileInput.click();
  };

  const startRecording = async () => {
    if (Platform.OS !== 'web') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
        if (!activeSessionId || !ws) return;
        try {
          const langHint2 = voiceLanguage && voiceLanguage !== 'auto' ? voiceLanguage : undefined;
          const result = await uploadFile(file, undefined, {
            kind: 'voice',
            language: langHint2,
            sessionId: activeSessionId,
          });
          const msg = result.transcription || 'The user sent a voice message.';
          addUserMessage(activeSessionId, msg, [result]);
          ws.sendMessage(msg, activeSessionId, {
            source: 'stt',
            attachments: attachmentsForSend([result]),
          });
        } catch (e: any) {
          console.error('Voice upload failed:', e);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (e) {
      console.error('Mic access denied:', e);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      setRecording(false);
    }
  };

  const toggleWebcam = useCallback(async () => {
    if (!ws) return;
    if (webcamHandleRef.current) {
      webcamHandleRef.current.stop();
      webcamHandleRef.current = null;
      setWebcamOn(false);
      log('webcam.stop');
      return;
    }
    if (!activeSessionIdRef.current) return;
    try {
      const handle = await startWebcamCapture(
        (b64, w, h) => {
          const sid = activeSessionIdRef.current;
          if (!sid) return;
          ws.sendVideoFrame(sid, 'webcam', b64, { width: w, height: h });
        },
        { fps: 1 },
      );
      webcamHandleRef.current = handle;
      setWebcamOn(true);
      log('webcam.start');
    } catch (e) {
      log('webcam.error', { error: String(e) });
    }
  }, [ws]);

  const toggleScreen = useCallback(async () => {
    if (!ws) return;
    if (screenHandleRef.current) {
      screenHandleRef.current.stop();
      screenHandleRef.current = null;
      setScreenOn(false);
      log('screen.stop');
      return;
    }
    if (!activeSessionIdRef.current) return;
    try {
      const handle = await startScreenCapture(
        (b64, w, h) => {
          const sid = activeSessionIdRef.current;
          if (!sid) return;
          ws.sendVideoFrame(sid, 'screen', b64, { width: w, height: h });
        },
        { fps: 1 },
      );
      screenHandleRef.current = handle;
      setScreenOn(true);
      log('screen.start');
    } catch (e) {
      log('screen.error', { error: String(e) });
    }
  }, [ws]);

  const videoSupported = browserAvailable
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia;
  const screenSupported = videoSupported
    && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  // Local handlers for the commands this client services itself. These are
  // NOT the catalogue — the catalogue comes from the gateway's registry
  // (`/api/commands`), which exists so a rich client does not hardcode the
  // list and drift from it. A command the server grows appears here on its
  // own; these entries only say "when it fires, run this locally instead of
  // sending it down the socket".
  //
  // `export` and `system` have no server counterpart: they act purely on
  // client state, so they are appended to whatever the registry returns.
  const localCommands: SlashCommand[] = [
    {
      name: 'new',
      description: 'Start a new chat',
      action: startNewSession,
    },
    {
      name: 'clear',
      description: 'Clear the active session transcript',
      action: () => {
        if (activeSessionId) ws?.sendCommand('clear', activeSessionId);
      },
    },
    {
      name: 'stop',
      description: 'Stop the current generation',
      action: handleStop,
    },
    {
      name: 'help',
      description: 'Ask the agent what it can do',
    },
    {
      name: 'compact',
      description: 'Compress conversation history to free up context',
      action: () => {
        if (activeSessionId) ws?.sendCommand('compact', activeSessionId);
      },
    },
    {
      name: 'context',
      description: 'Show this conversation’s context-window usage',
      // The panel is always visible; this forces an immediate refresh (the
      // command_result carries the fresh breakdown, applied in _layout.tsx).
      action: () => {
        if (activeSessionId) ws?.sendCommand('context', activeSessionId);
      },
    },
    {
      name: 'model',
      description: 'Switch the model for this conversation',
      // Opens the composer's model picker instead of inserting "/model "
      // for the user to type a runtime id by hand.
      argSource: 'models',
    },
    {
      name: 'export',
      description: 'Export this conversation as Markdown',
      action: () => { if (activeSessionId) exportSessionAsMarkdown(activeSessionId); },
    },
    {
      name: 'system',
      description: 'Set a system prompt for this session',
      action: () => {
        if (!activeSessionId) return;
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const current = activeSession?.systemPrompt ?? '';
        const next = window.prompt(
          'System prompt for this session (leave empty to clear):',
          current,
        );
        if (next === null) return;
        setSystemPrompt(activeSessionId, next.trim());
        if (ws) ws.sendSessionClose(activeSessionId);
      },
    },
  ];

  // The gateway's registry, merged with the local handlers above.
  // Falls back to the local list alone if the fetch fails, so losing the
  // gateway degrades the menu instead of emptying it.
  const slashCommands: SlashCommand[] = useMemo(() => {
    const localByName = new Map(localCommands.map((c) => [c.name, c]));
    if (!gatewayCommands) return localCommands;
    const merged: SlashCommand[] = [];
    for (const spec of gatewayCommands) {
      // `menu_visible: false` marks an alias the menu should not repeat
      // (`reset` duplicates `clear`, `queue` duplicates `status`).
      if (!spec.menu_visible) continue;
      const local = localByName.get(spec.name);
      merged.push({
        name: spec.name,
        // The server's description is the canonical wording; a local entry
        // only overrides it when it describes a different, client-side act.
        description: local?.description ?? spec.description,
        // No local handler → send it down the socket. Scope matters: the
        // agent-wide commands must go WITHOUT a session_id, while the
        // conversation-scoped ones must carry it so other chat tabs stay
        // intact. The registry doesn't express scope, so the client decides
        // — and defaults an unknown new command to session-scoped, which is
        // the safer wrong answer of the two.
        action: local?.action ?? (() => {
          if (AGENT_WIDE_COMMANDS.has(spec.name)) ws?.sendCommand(spec.name);
          else if (activeSessionId) ws?.sendCommand(spec.name, activeSessionId);
        }),
        argSource: (spec.arg_source === 'models' ? 'models' : undefined),
      });
      localByName.delete(spec.name);
    }
    // Whatever the registry did not claim is client-only — keep it.
    for (const leftover of localByName.values()) merged.push(leftover);
    return merged;
  }, [gatewayCommands, localCommands, activeSessionId, ws]);

  // Composer model-picker rows. Memoized on the raw catalogue so a keystroke
  // (which re-renders this screen) doesn't rebuild a fresh array each time and
  // hand the composer a new ``modelOptions`` reference.
  // Per provider, the headroom of the account that would serve the NEXT
  // request: the least-used account that is not rate-limited. That is the
  // number that decides whether a model is usable right now — an average
  // across accounts would hide one exhausted account behind a fresh one.
  const providerHints = useMemo(() => {
    const out = new Map<string, { hint: string; tone: 'ok' | 'warn' | 'bad' | undefined }>();
    for (const p of accounts ?? []) {
      if (!p.accounts.length) continue;
      const usable = p.accounts.filter((a) => !a.limited && !a.dead);
      if (usable.length === 0) {
        // Everything is cooling down: say when the earliest one returns.
        const soonest = p.accounts
          .map((a) => a.cooldown_remaining_s
            ?? (a.limited_until_ms ? (a.limited_until_ms - Date.now()) / 1000 : null))
          .filter((v): v is number => typeof v === 'number' && v > 0)
          .sort((a, b) => a - b)[0];
        out.set(p.provider, {
          hint: soonest ? `limited · ${formatDuration(soonest)}` : 'limited',
          tone: 'bad',
        });
        continue;
      }
      const withQuota = usable
        .map((a) => a.quota?.primary_used_percent)
        .filter((v): v is number => typeof v === 'number');
      if (withQuota.length === 0) {
        // No upstream quota to report — say "available", never a fake 100%.
        out.set(p.provider, { hint: 'available', tone: 'ok' });
        continue;
      }
      const left = 100 - Math.min(...withQuota);
      out.set(p.provider, {
        hint: `${Math.round(left)}% left`,
        tone: left <= 10 ? 'bad' : left <= 30 ? 'warn' : 'ok',
      });
    }
    return out;
  }, [accounts]);

  const modelOptions = useMemo(
    () => llmModels.map((m) => {
      const h = providerHints.get(m.provider_name);
      return {
        id: m.runtime_id,
        label: m.display_name || m.model || m.runtime_id,
        provider: m.provider_name,
        // Which subscription pays, and how hard it thinks — the two
        // questions the flat list used to ask the reader to untangle.
        family: modelFamily(m),
        effort: modelEffort(m),
        accountHint: h?.hint,
        accountTone: h?.tone,
      };
    }),
    [llmModels, providerHints],
  );

  return (
    <SessionDetailsDrawerShell topInset={headerInset}>
      <View style={[styles.chatArea, { paddingTop: headerInset }]}>
        {dragActive && (
          <View style={styles.dropOverlay} pointerEvents="none">
            <View style={styles.dropPanel}>
              <Feather name="upload-cloud" size={32} color={colors.primary} />
              <Text style={styles.dropTitle}>Drop to attach</Text>
              <Text style={styles.dropSub}>
                Files will be uploaded and added to the next message.
              </Text>
            </View>
          </View>
        )}
        {activeSession ? (
          <>
            {/* TTS banner */}
            {voiceOn && hasTts === false && (
              <View style={styles.banner} accessibilityRole="alert">
                <Feather name="volume-x" size={13} color={colors.error} />
                <Text style={styles.bannerText}>
                  No TTS model configured — replies will be text-only. Add a{' '}
                  <Text style={styles.bannerStrong}>kind=tts</Text> row in Models to hear spoken replies.
                </Text>
              </View>
            )}

            {/* Voice bar */}
            {voiceOn && (
              <View style={styles.voiceBar}>
                <View style={styles.voiceBarLeft}>
                  <SoundWaves level={energy} state={swState} bars={5} maxHeight={28} />
                  <Text style={styles.voiceCaption}>{caption}</Text>
                </View>
                <View style={styles.voiceBarRight}>
                  {videoSupported && (
                    <TouchableOpacity
                      style={[styles.voiceIconBtn, webcamOn && styles.voiceIconBtnActive]}
                      onPress={toggleWebcam}
                      accessibilityLabel={webcamOn ? 'Stop webcam' : 'Share webcam'}
                    >
                      <Feather
                        name={webcamOn ? 'video' : 'video-off'}
                        size={12}
                        color={webcamOn ? colors.text : colors.textSecondary}
                      />
                    </TouchableOpacity>
                  )}
                  {screenSupported && (
                    <TouchableOpacity
                      style={[styles.voiceIconBtn, screenOn && styles.voiceIconBtnActive]}
                      onPress={toggleScreen}
                      accessibilityLabel={screenOn ? 'Stop screen share' : 'Share screen'}
                    >
                      <Feather
                        name={screenOn ? 'monitor' : 'cast'}
                        size={12}
                        color={screenOn ? colors.text : colors.textSecondary}
                      />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

            {(webcamOn || screenOn) && voiceOn && (
              <Text style={styles.shareBadge}>
                Sharing: {[webcamOn && 'webcam', screenOn && 'screen'].filter(Boolean).join(' + ')}
              </Text>
            )}

            <ScrollView
              ref={scrollRef}
              // Pull up behind the transparent header (its empty top padding
              // is transparent, so any banners above still show through) and
              // pad the content so the first message clears the header.
              style={[styles.messages, { marginTop: -headerInset }]}
              contentContainerStyle={[styles.messagesContent, { paddingTop: headerInset + 12 }]}
              onScroll={onScroll}
              onContentSizeChange={onContentSizeChange}
              scrollEventThrottle={100}
              // Always show the scrollbar so the user sees there's
              // scrollable content even when the transcript is short.
              // @ts-ignore — RN Web prop, no-op on native
              persistentScrollbar
            >
              <View style={styles.messagesInner}>
                {(activeSession.parentSessionId || (activeSession.origin && activeSession.origin !== 'chat')) ? (
                  (() => {
                    const parent = sessions.find((s) => s.id === activeSession.parentSessionId);
                    const originName = activeSession.origin && activeSession.origin !== 'chat'
                      ? activeSession.origin : 'parent';
                    const label = parent
                      ? `${originName} · ${parent.title}`
                      : `${originName}${activeSession.originLabel ? ` · ${activeSession.originLabel}` : ''}`;
                    return (
                      <TouchableOpacity
                        disabled={!parent}
                        onPress={() => parent && openChildSession(parent.id)}
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: 6,
                          paddingVertical: 6, paddingHorizontal: 8, marginBottom: 4,
                          alignSelf: 'flex-start', borderRadius: 6,
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Back to parent session"
                      >
                        <Feather name="corner-up-left" size={12} color={colors.textMuted} />
                        <Text style={{
                          color: colors.textMuted, fontSize: 11,
                          textTransform: 'uppercase', letterSpacing: 0.5,
                        }} numberOfLines={1}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })()
                ) : null}
                {activeSession.messages.length === 0 && (
                  <View style={styles.heroEmpty}>
                    <BrandLogo size={84} />
                    <Text style={styles.heroTitle}>At your service</Text>
                    <Text style={styles.heroSub}>
                      Ask a question, request a task, or attach a file.
                    </Text>
                    <View style={styles.suggestedRow}>
                      {SUGGESTED_PROMPTS.map((p) => (
                        <TouchableOpacity
                          key={p.label}
                          style={styles.suggestedChip}
                          onPress={() => setInput(p.prompt)}
                          // @ts-ignore
                          {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
                        >
                          <Feather name={p.icon as any} size={11} color={colors.primary} />
                          <Text style={styles.suggestedLabel}>{p.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}
                <MessageList
                  messages={activeSession.messages}
                  isProcessing={activeSession.isProcessing}
                  statusText={activeSession.statusText}
                  isReasoning={activeSession.isReasoning}
                  onRegenerate={handleRegenerate}
                  onEditUser={handleEditUser}
                  onOpenChild={openChildSession}
                  onOpenRun={openRun}
                  onOpenMemory={openMemory}
                  currentUserHandle={currentUserHandle}
                  anchorMessageId={anchorMessage}
                  anchorToolInvocationId={anchorToolInvocation}
                  onAnchorLayout={(y) => scrollRef.current?.scrollTo({ y: Math.max(0, y - 96), animated: true })}
                  hasMoreBefore={activeSession.messageWindow?.hasMoreBefore}
                  onLoadEarlier={handleLoadEarlier}
                />
              </View>
            </ScrollView>

            {activeSession.systemPrompt ? (
              <View style={styles.systemHint}>
                <Feather name="settings" size={10} color={colors.textMuted} />
                <Text style={styles.systemHintText} numberOfLines={1}>
                  System: {activeSession.systemPrompt}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    if (!activeSessionId) return;
                    setSystemPrompt(activeSessionId, '');
                    if (ws) ws.sendSessionClose(activeSessionId);
                  }}
                  accessibilityLabel="Clear system prompt"
                >
                  <Feather name="x" size={10} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            ) : null}
            {!isPinned && (
              <TouchableOpacity
                style={styles.jumpToBottom}
                onPress={() => scrollToBottom(true)}
                accessibilityLabel="Jump to bottom"
                // @ts-ignore
                {...(Platform.OS === 'web' ? { className: 'oa-hover-lift oa-fade-in' } : {})}
              >
                <Feather name="chevron-down" size={14} color={colors.text} />
              </TouchableOpacity>
            )}

            {modelPinError && (
              <Notice style={styles.pinErrorBar} onDismiss={() => setModelPinError(null)}>
                {`Could not switch model — ${modelPinError}`}
              </Notice>
            )}
            {anchorError && (
              <Notice style={styles.pinErrorBar} onDismiss={() => setAnchorError(null)}>
                {anchorError}
              </Notice>
            )}

            <SharedPresence id={activeSessionId || undefined} />
            {activeSessionId && <SessionSharing sessionId={activeSessionId} />}
            <MessageComposer
              inputRef={composerInputRef}
              input={input}
              onInputChange={(v) => {
                // Any manual edit invalidates the history-recall index.
                if (recallIdxRef.current !== null) recallIdxRef.current = null;
                setInput(v);
              }}
              processing={activeSession.isProcessing}
              onStop={handleStop}
              onRecallPrev={recallPrev}
              onRecallNext={recallNext}
              slashCommands={slashCommands}
              modelOptions={modelOptions}
              activeModelId={activeSession?.llmPin}
              menuFooter={<AgentSwitcher variant="menu-row" />}
              onSelectModel={handleSelectModel}
              pendingFiles={pendingFiles}
              onRetryFile={(idx) => {
                const target = pendingFiles[idx];
                if (target?.retry) target.retry();
              }}
              onRemoveFile={(idx) => setPendingFiles((prev) => {
                const target = prev[idx];
                // Cancel the underlying fetch if the upload is still in
                // flight — otherwise the request orphan-completes and
                // the gateway accepts a file the user no longer wants.
                target?.abort?.();
                if (target?.previewUrl) {
                  try { URL.revokeObjectURL(target.previewUrl); } catch { /* ignore */ }
                }
                return prev.filter((_, i) => i !== idx);
              })}
              onPickFile={(Platform.OS === 'web' || isDesktop) ? handleFilePick : undefined}
              onSend={handleSend}
              // Composer stays interactive while the agent is processing so
              // the user can send a steer / send-while-busy message mid-turn
              // (vision §2 — "fast bursts coalesced into a single turn"); the
              // server coalesces it into the in-flight turn. Stopping is still
              // one tap away via the Stop button (rendered while processing)
              // and the command palette.
              recording={Platform.OS === 'web' ? recording : undefined}
              onStartRecord={startRecording}
              onStopRecord={stopRecording}
              alwaysListening={
                Platform.OS === 'web' ? voiceConfig.chatAlwaysListen : undefined
              }
              onToggleAlwaysListen={toggleAlwaysListen}
            />
          </>
        ) : !sessionsHydrated ? (
          // Sessions are still loading from the server — render the
          // transcript shell with shimmering placeholders so we land on
          // the page immediately instead of flashing "Standing by".
          <View style={styles.messages}>
            <View style={[styles.messagesInner, styles.skeletonInner]}>
              <View style={styles.skeletonTurn}>
                <Skeleton width={64} height={11} />
                <SkeletonLines lines={2} lastWidth="70%" />
              </View>
              <View style={styles.skeletonTurn}>
                <Skeleton width={88} height={11} />
                <SkeletonLines lines={3} lastWidth="45%" />
              </View>
              <View style={styles.skeletonTurn}>
                <Skeleton width={64} height={11} />
                <SkeletonLines lines={2} lastWidth="80%" />
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <BrandLogo size={96} />
            <Text style={styles.emptyTitle}>Standing by</Text>
            <Text style={styles.emptySub}>Select a session from the sidebar, or open a new one.</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={createSession}>
              <Feather name="plus" size={13} color={colors.text} />
              <Text style={styles.emptyBtnText}>New chat</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </SessionDetailsDrawerShell>
  );
}

const styles = StyleSheet.create({
  headerMenuBtn: {
    width: 34, height: 34,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.md,
  },

  // Chat area
  chatArea: { flex: 1, flexDirection: 'column' },

  // TTS banner
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 9,
    backgroundColor: colors.errorSoft,
    borderBottomWidth: 1, borderBottomColor: colors.errorBorder,
  },
  bannerText: {
    flex: 1, fontSize: 12, color: colors.error, lineHeight: 17,
  },
  bannerStrong: { fontFamily: font.mono, fontWeight: '600' },

  // Voice bar
  voiceBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: colors.borderLight,
    minHeight: 44,
  },
  voiceBarLeft: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  voiceBarRight: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  voiceCaption: {
    fontSize: 11, color: colors.textMuted,
    fontFamily: font.mono, letterSpacing: 0.6, textTransform: 'uppercase',
  },
  voiceIconBtn: {
    width: 24, height: 24, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  voiceIconBtnActive: {
    borderColor: colors.text,
    backgroundColor: colors.borderLight,
  },
  shareBadge: {
    fontSize: 10, color: colors.textSecondary,
    fontFamily: font.mono, letterSpacing: 0.4,
    textAlign: 'center', paddingVertical: 4,
    borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },

  messages: { flex: 1 },
  messagesContent: { paddingVertical: 12, paddingBottom: 12 },
  messagesInner: { maxWidth: 760, width: '100%', alignSelf: 'center', paddingHorizontal: 20 },

  // Loading placeholder while sessions hydrate from the server.
  skeletonInner: { paddingTop: 28, gap: 28 },
  skeletonTurn: { gap: 10 },

  // Hero empty state
  heroEmpty: {
    alignItems: 'center', paddingVertical: 60, paddingHorizontal: 16,
  },
  heroGlyph: {
    fontSize: 26, color: colors.primary, marginBottom: 12,
    fontFamily: font.display,
  },
  heroLogo: {
    width: 56, height: 56, marginBottom: 14,
  },
  heroTitle: {
    fontSize: 20, fontWeight: '500', color: colors.text,
    letterSpacing: -0.4, marginBottom: 4,
    fontFamily: font.display,
  },
  heroSub: {
    fontSize: 13, color: colors.textMuted, textAlign: 'center',
    marginBottom: 22,
  },
  suggestedRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    justifyContent: 'center', maxWidth: 520,
  },
  suggestedChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  suggestedLabel: {
    fontSize: 12, fontWeight: '500', color: colors.text,
  },
  systemHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 5,
    marginHorizontal: 20, marginBottom: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.codeBg,
    borderWidth: 1, borderColor: colors.borderLight,
    maxWidth: 760, alignSelf: 'center', width: '100%',
  },
  systemHintText: {
    flex: 1, fontSize: 11, color: colors.textSecondary,
    fontFamily: font.mono,
  },
  jumpToBottom: {
    position: 'absolute',
    bottom: 88,
    alignSelf: 'center',
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    zIndex: 5,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 3,
  },

  // Empty
  emptyState: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18, fontWeight: '500', color: colors.text,
    letterSpacing: -0.3, marginBottom: 4,
    fontFamily: font.display,
  },
  emptySub: {
    fontSize: 13, color: colors.textMuted, textAlign: 'center', marginBottom: 16,
  },
  emptyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  emptyBtnText: { fontSize: 12, fontWeight: '500', color: colors.text },

  // Drag-and-drop overlay (web/desktop only — see useEffect above).
  dropOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 1000,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
    padding: 24,
  },
  dropPanel: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 2, borderColor: colors.primary,
    paddingHorizontal: 32, paddingVertical: 28,
    alignItems: 'center', gap: 10,
    maxWidth: 420,
    // @ts-ignore — web-only dashed border
    ...(Platform.OS === 'web' ? { borderStyle: 'dashed' as any } : {}),
  },
  dropTitle: {
    fontSize: 16, fontWeight: '600', color: colors.text,
    fontFamily: font.display, letterSpacing: -0.3,
  },
  dropSub: {
    fontSize: 12, color: colors.textMuted, textAlign: 'center',
  },
  // Inline notice for a rejected model pin. Sits directly above the
  // composer so it reads as an answer to the chip the user just clicked.
  pinErrorBar: { marginHorizontal: 12, marginBottom: 6 },
});
