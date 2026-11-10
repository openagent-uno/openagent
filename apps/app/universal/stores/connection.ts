/**
 * Connection state with multi-account support.
 *
 * Accounts represent ``handle@network`` memberships persisted via the
 * storage service (electron-store on desktop, localStorage on web).
 * Connecting an account spawns the loopback sidecar (handled by the
 * Electron main process) which exposes a localhost port that proxies
 * HTTP/WS over the Iroh transport. The renderer keeps using ``fetch``
 * and ``WebSocket`` against ``http://127.0.0.1:<sidecarPort>`` exactly
 * like before — auth + transport are below the visible layer.
 *
 * Passwords are never written to renderer storage. On Electron, an opted-in
 * credential is encrypted by safeStorage in the main process (Keychain /
 * DPAPI / a real Linux secret service). Automatic login asks the main
 * process to start the loopback without ever returning plaintext to JS UI.
 */

import { create } from 'zustand';
import type { ConnectionConfig, SavedAccount, ServerMessage } from '../../common/types';
import type { CapabilitiesResponse } from '../../common/unified-history';
import { sessionDiscoveryStrategy } from '../../common/history-feed-policy';
import { createLatestAttemptGate } from '../../common/latest-attempt';
import { persistAccountAdditionWhileCurrent } from '../../common/guarded-account-persistence';
import {
  accountAgentPresentation,
  accountLoopbackTarget,
  withVerifiedAccountTarget,
  type PublicAccountTarget,
} from '../../common/account-target-recovery';
import { OpenAgentWS } from '../services/ws';
import {
  setBaseUrl,
  clearBaseUrl,
  fetchSessions,
  getUnifiedCapabilities,
  isExplicitlyUnsupported,
  isUnsupportedByAgent,
  listUnifiedHistory,
  sessionEntryFromActivity,
} from '../services/api';
import * as storage from '../services/storage';
import { useChat } from './chat';
import { useConfig } from './config';

const STORAGE_KEY = 'openagent:accounts';
const ACTIVE_CONNECTION_KEY = 'openagent:activeConnection';

// Account mutations can overlap (join completion, auth metadata repair,
// removal, another window action). Serialize renderer storage writes so an
// older slow write can never land after and erase a newer in-memory list.
let accountStorageTail: Promise<void> = Promise.resolve();

function persistAccountsSerialized(accounts: SavedAccount[]): Promise<void> {
  const payload = JSON.stringify(accounts);
  const write = accountStorageTail
    .catch(() => {})
    .then(() => storage.setItem(STORAGE_KEY, payload));
  accountStorageTail = write.catch(() => {});
  return write;
}

function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Bootstrap only enough session metadata to choose the initial chat. V2
 * agents return one filtered history row and then load messages on demand;
 * the unpaginated flat list remains strictly a legacy compatibility path. */
async function discoverSessionsAfterAuth(
  inlineCapabilities: CapabilitiesResponse | undefined,
  stillCurrent: () => boolean,
): Promise<void> {
  let capabilities = inlineCapabilities;
  try {
    capabilities ??= await getUnifiedCapabilities();
  } catch (error) {
    if (!isUnsupportedByAgent(error) && !isExplicitlyUnsupported(error)) {
      // Do not guess "legacy" on a transient failure: that would turn one
      // missed capability response into the expensive flat-list request on a
      // v2 agent. The authenticated shell retries discovery independently.
      if (stillCurrent()) useChat.getState().markHydrated();
      return;
    }
    // Old agents do not expose capability discovery.
    capabilities = undefined;
  }
  if (!stillCurrent()) return;

  const strategy = sessionDiscoveryStrategy(capabilities?.features.history?.version);
  if (strategy === 'history_page') {
    const chat = useChat.getState();
    chat.setSessionHistoryMode('v2');
    // Reconnects keep the small set of sessions the user actually opened.
    // live_state + settleStaleTurns below reconcile their running status.
    if (chat.sessions.length > 0) {
      chat.markHydrated();
      return;
    }
    try {
      const page = await listUnifiedHistory({
        kinds: ['chat'],
        include_children: false,
        limit: 1,
      });
      if (!stillCurrent()) return;
      const entry = page.items.map(sessionEntryFromActivity).find((item) => item != null);
      const latestChat = useChat.getState();
      if (entry) latestChat.hydrateFromServer([entry]);
      else latestChat.markHydrated();
    } catch {
      if (stillCurrent()) useChat.getState().markHydrated();
    }
    return;
  }

  const chat = useChat.getState();
  chat.setSessionHistoryMode('legacy');
  try {
    const entries = await fetchSessions();
    if (stillCurrent()) chat.hydrateFromServer(entries);
  } catch {
    // Keep the old offline/error behaviour: the chat shell becomes usable
    // even if the compatibility listing failed.
  } finally {
    if (stillCurrent()) chat.markHydrated();
  }
}

/**
 * Translate a raw loopback / coordinator failure into something a human
 * can act on. The desktop bridge surfaces the Python child's stderr
 * verbatim — that's noisy ("loopback exited before printing port
 * (code=1); stderr: …") and leaks internal terminology. We strip the
 * envelope, then map the known coordinator error codes to plain
 * sentences. Anything we don't recognise falls through cleaned-up but
 * intact so we don't hide unexpected failures.
 */
function humanizeLoginError(raw: string | undefined | null): string {
  if (!raw) return 'Something went wrong. Please try again.';
  let msg = String(raw);

  // Drop the loopback envelope from the desktop bridge.
  msg = msg.replace(/^Error invoking remote method [^:]+: ?/, '');
  msg = msg.replace(/^Error: /, '');
  msg = msg.replace(/^loopback exited before printing port \(code=\d+\); stderr: ?/, '');
  msg = msg.replace(/^loopback startup timed out after \d+ms; stderr: ?/, '');
  // Click leaves a trailing "Aborted!" line on every error.
  msg = msg.replace(/\bAborted!\s*$/, '').trim();

  // Common Python-CLI error prefixes the user shouldn't have to read.
  msg = msg.replace(/^join failed: ?/, '');
  msg = msg.replace(/^login failed: ?/, '');

  const lower = msg.toLowerCase();

  if (lower.includes('unauthorized') || lower.includes('login failed')) {
    return 'Wrong password. Try again — passwords are case-sensitive.';
  }
  if (lower.includes('invalid_invite')) {
    if (lower.includes('different handle')) {
      return 'This invite is bound to a different handle. Ask the owner for one for your handle, or pick a fresh user invite.';
    }
    return 'This invite is no longer valid — expired, already used, or for the wrong role. Ask the network owner for a fresh one.';
  }
  if (lower.includes('handle') && lower.includes('already taken')) {
    const m = msg.match(/'([^']+)'/);
    const taken = m ? m[1] : 'that handle';
    return `“${taken}” is already in use on this network. Pick a different handle and try again.`;
  }
  if (lower.includes('could not reach') || lower.includes('is the openagent server running')) {
    return 'Can’t reach the agent server. Make sure ‘openagent serve’ is running on the host that issued the invite, and that this device has internet access.';
  }
  if (lower.includes('expected handle@network')) {
    return 'Pick a saved network or paste an invite ticket — the field can’t be empty.';
  }
  if (lower.includes('unknown network')) {
    return 'This device doesn’t know that network yet. Use a fresh invite to join from this Mac.';
  }
  if (lower.includes('cert') && lower.includes('expired')) {
    return 'Your saved credentials expired. Sign in again to refresh them.';
  }
  if (lower.includes('econnrefused') || lower.includes('connection refused')) {
    return 'Can’t reach the agent server. Make sure it’s running and reachable.';
  }
  if (lower.includes('secure tunnel') && (lower.includes('timed out') || lower.includes('timeout'))) {
    return 'The previous secure tunnel is still shutting down. Wait a moment and try again.';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return 'The agent didn’t respond in time. Check that the server is running and try again.';
  }
  if (lower.includes('password is required')) {
    return 'Enter your password to continue.';
  }

  // Trim whitespace + cap length so we never overflow the card.
  msg = msg.trim();
  if (!msg) return 'Something went wrong. Please try again.';
  if (msg.length > 280) msg = msg.slice(0, 277) + '…';

  // Capitalise the first letter for politeness; keep the rest verbatim.
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

interface DesktopAPI {
  clientInstanceId?: string;
  startLoopback: (args: {
    accountId: string;
    password: string;
    ticket?: string;
    handle?: string;
    network?: string;
    agent?: string;
    remember?: boolean;
    attemptToken?: number;
  }) => Promise<LoopbackStartResult>;
  startRememberedLoopback?: (args: {
    accountId: string;
    ticket?: string;
    handle?: string;
    network?: string;
    agent?: string;
    attemptToken?: number;
  }) => Promise<RememberedLoopbackResult>;
  credentialsAvailable?: () => Promise<boolean>;
  forgetCredential?: (accountId: string) => Promise<void>;
  releaseLoopbackAttempt?: (args: { accountId: string; attemptToken: number }) => Promise<void>;
  stopLoopback: (args: { accountId: string }) => Promise<void>;
  setRelayAgent?: (id: string | null) => void;
  wsRelayBroadcast?: (payload: string, id: string) => void;
  getLoopbackPort: (accountId: string) => Promise<number | null>;
  /** Open a standalone agent window bound to ``accountId`` (own
   *  connection). Present only in Electron; used for multi-window. */
  openAgentWindow?: (
    accountId: string,
    attemptToken?: number,
    sourceAccountId?: string,
  ) => Promise<void>;
}

export type RememberedLoopbackResult =
  | { status: 'started'; port: number; target: PublicAccountTarget }
  | { status: 'missing' }
  | { status: 'invalid'; error: string; target?: PublicAccountTarget }
  | { status: 'retryable_error'; error: string; target?: PublicAccountTarget };

export interface LoopbackStartResult {
  port: number;
  target: PublicAccountTarget;
}

export type RememberedConnectionResult =
  | RememberedLoopbackResult
  | { status: 'started'; port: number }
  | { status: 'stale' };

export interface RememberedCredentialFailure {
  accountId: string;
  kind: 'missing' | 'invalid' | 'retryable';
  error?: string;
}

function desktop(): DesktopAPI | null {
  // ``window.desktop`` is exposed by the Electron preload. On web this
  // is undefined — the connection flow surfaces a clear error and we
  // skip the sidecar altogether.
  if (typeof window === 'undefined') return null;
  // @ts-ignore — runtime-injected
  const d = (window as any).desktop;
  if (!d || typeof d.startLoopback !== 'function') return null;
  return d as DesktopAPI;
}

const DIRECTED_ACCOUNT_KEY = 'openagent:directedAccount';

/** This renderer is a *directed* (standalone agent) window — it was opened
 *  with ``?connect=<accountId>`` and owns its own connection to that
 *  account. Such windows derive their identity from the URL and must NOT
 *  touch the shared ``ACTIVE_CONNECTION_KEY`` slot (that belongs to the
 *  primary window's cold-start resume).
 *
 *  The ``?connect=`` marker is dropped from the URL once we redirect into
 *  the tab stack, so we mirror it into per-window ``sessionStorage`` (each
 *  Electron BrowserWindow has its own) and fall back to that — this keeps a
 *  standalone window bound to its agent across renderer reloads. Returns the
 *  target accountId, or null for a normal (primary) window. */
export function directedAccountId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('connect');
    if (fromUrl && fromUrl.length > 0) return fromUrl;
    return (window as any).sessionStorage?.getItem(DIRECTED_ACCOUNT_KEY) || null;
  } catch {
    return null;
  }
}

/** Pin the directed account into this window's sessionStorage so a reload
 *  reconnects to it even after we've navigated away from ``/?connect=``. */
export function rememberDirectedAccount(id: string): void {
  if (typeof window === 'undefined') return;
  try { (window as any).sessionStorage?.setItem(DIRECTED_ACCOUNT_KEY, id); } catch { /* ignore */ }
}

export interface JoinNetworkArgs {
  // Single string the user pastes — carries network name, network ID,
  // coordinator NodeId, invite code, role, and (for device tickets)
  // the handle to bind to. Generate one with ``openagent network invite``.
  ticket: string;
  // Required when the ticket is role=user (the new user picks their
  // own handle); ignored for role=device tickets. The CLI re-derives
  // it from the ticket on its end either way.
  handle: string;
  password: string;
  remember?: boolean;
  isLocal?: boolean;
  displayName?: string;
}

interface ConnectionState {
  // Persisted
  accounts: SavedAccount[];
  // Runtime
  activeAccountId: string | null;
  config: ConnectionConfig | null;
  ws: OpenAgentWS | null;
  isConnected: boolean;
  isConnecting: boolean;
  /** True between a post-auth WS drop and the next ``auth_ok``. The
   *  reconnect loop in OpenAgentWS still runs whether or not anyone
   *  reads this — the flag just lets the UI surface a "Reconnecting…"
   *  hint instead of letting the chat go silently dead. */
  isReconnecting: boolean;
  agentName: string | null;
  agentVersion: string | null;
  error: string | null;
  isLoading: boolean;
  /** Boot remains visually gated until the live loopback or remembered
   * credential path reaches a terminal result. */
  isRestoringSession: boolean;
  credentialStorageAvailable: boolean;
  rememberedFailure: RememberedCredentialFailure | null;

  // Account management
  loadAccounts: () => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  selectAccount: (id: string) => Promise<void>;
  relayFromChild: (payload: string, id?: string) => void;
  warmSavedAccounts: () => void;
  rememberAgentPresentation: (id: string, name?: string, thumbnail?: string | null) => void;
  refreshCredentialAvailability: () => Promise<boolean>;

  // Onboarding & connection
  joinNetwork: (args: JoinNetworkArgs) => Promise<void>;
  joinNetworkInNewWindow: (args: JoinNetworkArgs) => Promise<boolean>;
  connectAccount: (
    accountId: string,
    password: string,
    remember?: boolean,
    selectedAgentHandle?: string,
  ) => Promise<void>;
  connectRememberedAccount: (accountId: string) => Promise<RememberedConnectionResult>;
  disconnect: () => Promise<void>;
  resumeConnection: () => Promise<void>;

  // Multi-window (Electron desktop only)
  /** Open ``accountId`` in a *new* standalone window without disturbing
   *  this window's connection. Ensures the account's loopback is up
   *  (spawning it with ``password`` when it isn't yet), then asks the main
   *  process to open a window bound to that account — which connects to the
   *  now-running loopback passwordlessly. Returns ``{ ok }`` so the caller
   *  can surface a humanised error inline. */
  openAccountWindow: (
    accountId: string,
    password?: string,
    remember?: boolean,
    selectedAgentHandle?: string,
  ) => Promise<{ ok: boolean; needsPassword?: boolean; retryable?: boolean; error?: string }>;
  /** Boot path for a standalone window (``?connect=<id>``): connect to the
   *  account's already-running loopback with no password. No-op when the
   *  loopback isn't up (the window falls back to the login screen). */
  connectDirected: (accountId: string) => Promise<void>;
}

export function activeAgentName(state: Pick<ConnectionState, 'agentName' | 'accounts' | 'activeAccountId'>) {
  const account = state.accounts.find(account => account.id === state.activeAccountId);
  const display = state.agentName?.trim() || account?.agentDisplayName?.trim();
  if (display && display.toLowerCase() !== 'openagent') return display;
  if (!account) return display;
  const { alias, primary } = accountAgentPresentation(account);
  return alias && alias.toLowerCase() !== 'openagent' ? alias : primary;
}

export const useConnection = create<ConnectionState>((set, get) => {
  // Renderer-local by construction: every BrowserWindow evaluates this store
  // in its own JS realm. One window's A→B switch cannot cancel another
  // window's independent connection attempt.
  const connectionAttempts = createLatestAttemptGate<string>();
  const backgroundJoinAttempts = createLatestAttemptGate<string>();

  const sockets = new Map<string, ReturnType<typeof _openWebsocket>>();
  const warming = new Map<string, Promise<void>>();
  const warmAttempted = new Set<string>();
  // Warm starts use separate ownership tokens without cancelling UI attempts.
  let warmToken = Number.MAX_SAFE_INTEGER;
  const closeSocket = (id: string) => {
    const socket = sockets.get(id);
    sockets.delete(id);
    socket?.close();
  };
  const wire = (account: SavedAccount, port: number, activate = true) => {
    closeSocket(account.id);
    const socket = _openWebsocket(get, set, { ...account, sidecarPort: port }, account.id);
    sockets.set(account.id, socket);
    if (activate) socket.activate();
  };
  const beginConnectionAttempt = (accountId: string) => {
    const attempt = connectionAttempts.begin(accountId);
    const state = get();
    if (state.ws && state.activeAccountId && !sockets.has(state.activeAccountId)) {
      state.ws.disconnect();
    }
    if (state.activeAccountId) sockets.get(state.activeAccountId)?.deactivate();
    desktop()?.setRelayAgent?.(accountId);
    clearBaseUrl();
    useChat.getState().clearAll();
    useConfig.setState(useConfig.getInitialState());
    set({
      ws: null,
      config: null,
      isConnected: false,
      isConnecting: true,
      isReconnecting: false,
      activeAccountId: accountId,
      agentName: null,
      agentVersion: null,
      error: null,
      rememberedFailure: null,
    });
    return attempt;
  };

  const discardStaleLoopback = async (
    d: DesktopAPI,
    accountId: string,
    attemptToken: number,
  ) => {
    try {
      if (d.releaseLoopbackAttempt) {
        await d.releaseLoopbackAttempt({ accountId, attemptToken });
      } else {
        await d.stopLoopback({ accountId });
      }
    } catch { /* best effort */ }
  };

  const persistVerifiedTarget = async (
    accountId: string,
    target: PublicAccountTarget,
  ): Promise<SavedAccount | null> => {
    let repaired: SavedAccount | null = null;
    const accounts = get().accounts.map((account) => {
      if (account.id !== accountId) return account;
      repaired = withVerifiedAccountTarget(account, target);
      return repaired;
    });
    if (!repaired) return null;
    set({ accounts });
    try {
      await persistAccountsSerialized(accounts);
    } catch {
      // State still contains the trusted target for an immediate explicit
      // retry; a later account write will persist it again.
    }
    return repaired;
  };

  return ({
  accounts: [],
  activeAccountId: null,
  config: null,
  ws: null,
  isConnected: false,
  isConnecting: false,
  isReconnecting: false,
  agentName: null,
  agentVersion: null,
  error: null,
  isLoading: true,
  isRestoringSession: true,
  credentialStorageAvailable: false,
  rememberedFailure: null,

  // ── persistence ──

  loadAccounts: async () => {
    set({ isLoading: true });
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      const accounts: SavedAccount[] = raw ? JSON.parse(raw) : [];
      const connRaw = await storage.getItem(ACTIVE_CONNECTION_KEY);
      const ac = connRaw ? JSON.parse(connRaw) : null;
      set({
        accounts,
        activeAccountId: ac?.accountId ?? null,
        isLoading: false,
      });
    } catch {
      set({ accounts: [], isLoading: false });
    }
  },

  removeAccount: async (id) => {
    const wasActive = get().activeAccountId === id;
    const filtered = get().accounts.filter((a) => a.id !== id);
    set({ accounts: filtered });
    closeSocket(id);
    if (wasActive) {
      const next = filtered.find((account) => sockets.get(account.id)?.ready()) ?? filtered[0];
      if (next) void get().selectAccount(next.id);
      else await get().disconnect();
    }
    await persistAccountsSerialized(filtered);
    // Best-effort cleanup of any lingering sidecar for this account.
    try {
      await desktop()?.stopLoopback({ accountId: id });
    } catch {
      // ignore
    }
    try {
      await desktop()?.forgetCredential?.(id);
    } catch {
      // ignore
    }
  },

  rememberAgentPresentation: (id, name, thumbnail) => {
    const account = get().accounts.find((row) => row.id === id);
    if (!account || ((name === undefined || name === account.agentDisplayName)
      && (thumbnail === undefined || thumbnail === account.agentThumbnail))) return;
    const accounts = get().accounts.map((row) => row.id !== id ? row : {
      ...row,
      agentDisplayName: name ?? row.agentDisplayName,
      agentThumbnail: thumbnail === undefined ? row.agentThumbnail : thumbnail,
    });
    set({ accounts });
    void persistAccountsSerialized(accounts).catch(() => {});
  },

  relayFromChild: (payload, id) => {
    if (id) sockets.get(id)?.sendRaw(payload);
  },

  selectAccount: async (id) => {
    if (!get().accounts.some((account) => account.id === id)) return;
    if (get().activeAccountId === id && (get().isConnected || get().isConnecting)) return;
    const socket = sockets.get(id);
    if (socket?.ready()) {
      beginConnectionAttempt(id);
      socket.activate();
      return;
    }
    await get().connectRememberedAccount(id);
  },

  warmSavedAccounts: () => {
    const d = desktop();
    if (!d?.startRememberedLoopback || directedAccountId()
      || (typeof window !== 'undefined' && (window as any).desktop?.isChild)) return;
    const pending = get().accounts.filter(({ id }) => id !== get().activeAccountId
      && !sockets.has(id) && !warming.has(id) && !warmAttempted.has(id));
    for (const account of pending.slice(0, Math.max(0, 2 - warming.size))) {
      const token = warmToken--;
      warmAttempted.add(account.id);
      const job = (async () => {
        const existing = await d.getLoopbackPort(account.id);
        const result = existing ? null : await d.startRememberedLoopback!({
          ...accountLoopbackTarget(account), attemptToken: token,
        });
        const port = existing || (result?.status === 'started' ? result.port : null);
        if (!get().accounts.some(({ id }) => id === account.id)) {
          if (result?.status === 'started') await discardStaleLoopback(d, account.id, token);
          return;
        }
        if (port && !sockets.has(account.id)) wire(account, port, false);
      })().catch(() => {}).finally(() => {
        warming.delete(account.id);
        get().warmSavedAccounts();
      });
      warming.set(account.id, job);
    }
  },

  refreshCredentialAvailability: async () => {
    const d = desktop();
    if (!d?.credentialsAvailable) {
      set({ credentialStorageAvailable: false });
      return false;
    }
    try {
      const available = await d.credentialsAvailable();
      set({ credentialStorageAvailable: available });
      return available;
    } catch {
      set({ credentialStorageAvailable: false });
      return false;
    }
  },

  // ── connection ──
  //
  // Both join + connect funnel through ``startLoopback``. Join passes
  // the invite + coordinator so the underlying CLI registers the user
  // on its way to opening the proxy; subsequent connects only pass
  // password and reuse the persisted ``coordinatorNodeId``.

  joinNetwork: async (args) => {
    const accountId = genId();
    const attempt = beginConnectionAttempt(accountId);
    const d = desktop();
    if (!d) {
      if (attempt.isCurrent()) {
        set({
          isConnecting: false,
          error: 'Joining a network requires the desktop app — the loopback sidecar is unavailable here.',
        });
      }
      return;
    }
    // Spawn the loopback in ticket mode. The Python CLI parses the
    // ticket, registers/logs in via SRP-6a, mints the cert, persists
    // the network in the user store, and prints the bound port. We
    // don't see the ticket bits at all — just hand them off.
    let started: LoopbackStartResult;
    try {
      started = await d.startLoopback({
        accountId,
        password: args.password,
        ticket: args.ticket,
        handle: args.handle,
        remember: args.remember === true,
        attemptToken: attempt.token,
      });
    } catch (e: any) {
      if (!attempt.isCurrent()) return;
      set({ isConnecting: false, error: humanizeLoginError(e?.message || String(e)) });
      return;
    }

    // Main returns only non-secret metadata derived after coordinator auth.
    // Persist it even if this UI attempt was superseded: coordinator success
    // has already consumed the invite and created the membership. A stale
    // attempt may release its loopback, but deleting this row would orphan
    // both the membership and any remembered credential.
    const newAccount = withVerifiedAccountTarget<SavedAccount>({
      id: accountId,
      name: args.displayName ?? started.target.handle,
      network: '',
      handle: args.handle,
      isLocal: !!args.isLocal,
      createdAt: Date.now(),
      inviteCode: args.ticket,
    }, started.target);
    const persisted = await persistAccountAdditionWhileCurrent({
      account: newAccount,
      isCurrent: attempt.isCurrent,
      readAccounts: () => get().accounts,
      commitAccounts: (accounts) => set({ accounts }),
      persistAccounts: persistAccountsSerialized,
    });
    if (!persisted) {
      await discardStaleLoopback(d, accountId, attempt.token);
      return;
    }
    wire(newAccount, started.port);
  },

  joinNetworkInNewWindow: async (args) => {
    const d = desktop();
    if (!d?.openAgentWindow) {
      set({ error: 'Adding an agent in a separate window requires the desktop app.' });
      return false;
    }
    const accountId = genId();
    const attempt = backgroundJoinAttempts.begin(accountId);
    set({ isConnecting: true, error: null, rememberedFailure: null });

    let started: LoopbackStartResult;
    try {
      started = await d.startLoopback({
        accountId,
        password: args.password,
        ticket: args.ticket,
        handle: args.handle,
        remember: args.remember === true,
        attemptToken: attempt.token,
      });
    } catch (e: any) {
      if (attempt.isCurrent()) {
        set({ isConnecting: false, error: humanizeLoginError(e?.message || String(e)) });
      }
      return false;
    }

    const newAccount = withVerifiedAccountTarget<SavedAccount>({
      id: accountId,
      name: args.displayName ?? started.target.handle,
      network: '',
      handle: args.handle,
      isLocal: !!args.isLocal,
      createdAt: Date.now(),
      inviteCode: args.ticket,
    }, started.target);
    const current = await persistAccountAdditionWhileCurrent({
      account: newAccount,
      isCurrent: attempt.isCurrent,
      readAccounts: () => get().accounts,
      commitAccounts: (accounts) => set({ accounts }),
      persistAccounts: persistAccountsSerialized,
    });
    if (!current) {
      await discardStaleLoopback(d, accountId, attempt.token);
      return false;
    }

    try {
      // Main transfers this specific startup reservation to the new
      // BrowserWindow before releasing the source renderer, eliminating the
      // race where the sidecar could stop before connectDirected() runs.
      await d.openAgentWindow(accountId, attempt.token, get().activeAccountId ?? undefined);
      if (attempt.isCurrent()) set({ isConnecting: false, error: null });
      return true;
    } catch (e: any) {
      await discardStaleLoopback(d, accountId, attempt.token);
      if (attempt.isCurrent()) {
        set({ isConnecting: false, error: humanizeLoginError(e?.message || String(e)) });
      }
      return false;
    }
  },

  connectAccount: async (
    accountId,
    password,
    remember = false,
    selectedAgentHandle,
  ) => {
    const attempt = beginConnectionAttempt(accountId);
    const d = desktop();
    if (!d) {
      if (attempt.isCurrent()) {
        set({
          isConnecting: false,
          error: 'Connecting requires the desktop app — the loopback sidecar is unavailable here.',
        });
      }
      return;
    }
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) {
      if (attempt.isCurrent()) set({ isConnecting: false, error: 'Account not found' });
      return;
    }

    await warming.get(accountId);
    if (!attempt.isCurrent()) return;
    closeSocket(accountId);
    // Explicit password entry must perform a real coordinator login before
    // main stores the credential. Reusing a stale same-account loopback
    // would accept (and remember) an unverified replacement password.
    try {
      await d.stopLoopback({ accountId });
    } catch (error: any) {
      // Main keeps the real teardown behind its per-account barrier even when
      // the IPC deadline expires. Do not issue a start that would only wait on
      // the same stuck barrier; return control to the form so retry is possible
      // once native cleanup eventually finishes.
      if (attempt.isCurrent()) {
        set({
          isConnecting: false,
          isRestoringSession: false,
          error: humanizeLoginError(error?.message || String(error)),
        });
      }
      return;
    }
    if (!attempt.isCurrent()) return;

    let started: LoopbackStartResult;
    try {
      started = await d.startLoopback({
        accountId,
        password,
        handle: account.handle,
        network: account.network,
        agent: accountLoopbackTarget(account, selectedAgentHandle).agent,
        remember,
        attemptToken: attempt.token,
      });
    } catch (e: any) {
      if (!attempt.isCurrent()) return;
      set({ isConnecting: false, error: humanizeLoginError(e?.message || String(e)) });
      return;
    }
    if (!attempt.isCurrent()) {
      await discardStaleLoopback(d, accountId, attempt.token);
      return;
    }
    const repaired = await persistVerifiedTarget(accountId, started.target);
    if (!attempt.isCurrent()) {
      await discardStaleLoopback(d, accountId, attempt.token);
      return;
    }
    wire(repaired ?? account, started.port);
  },

  connectRememberedAccount: async (accountId) => {
    const d = desktop();
    const account = get().accounts.find((candidate) => candidate.id === accountId);
    const attempt = beginConnectionAttempt(accountId);
    if (!d || !account || !d.startRememberedLoopback) {
      const result: RememberedLoopbackResult = { status: 'missing' };
      if (attempt.isCurrent()) {
        set({
          isConnecting: false,
          isRestoringSession: false,
          rememberedFailure: { accountId, kind: 'missing' },
        });
      }
      return result;
    }

    await warming.get(accountId);
    if (!attempt.isCurrent()) return { status: 'stale' };
    const warm = sockets.get(accountId);
    if (warm?.usable()) {
      warm.activate();
      return { status: 'started', port: warm.port };
    }
    const livePort = await d.getLoopbackPort(accountId).catch(() => null);
    if (!attempt.isCurrent()) return { status: 'stale' };
    if (livePort) {
      wire(account, livePort);
      return { status: 'started', port: livePort };
    }
    let result: RememberedLoopbackResult;
    try {
      result = await d.startRememberedLoopback({
        ...accountLoopbackTarget(account),
        attemptToken: attempt.token,
      });
    } catch (error: any) {
      result = {
        status: 'retryable_error',
        error: error?.message || String(error),
      };
    }

    if (!attempt.isCurrent()) {
      if (result.status === 'started') {
        await discardStaleLoopback(d, accountId, attempt.token);
      }
      return { status: 'stale' };
    }

    // Main may recover this from an encrypted credential even when the
    // renderer row is a crash placeholder (`network: ''`). Persist the public
    // target before showing an invalid-password form so explicit retry works.
    let resolvedAccount = account;
    const recoveredTarget = 'target' in result ? result.target : undefined;
    if (recoveredTarget) {
      resolvedAccount = await persistVerifiedTarget(accountId, recoveredTarget) ?? account;
      if (!attempt.isCurrent()) {
        if (result.status === 'started') {
          await discardStaleLoopback(d, accountId, attempt.token);
        }
        return { status: 'stale' };
      }
    }

    if (result.status === 'started') {
      wire(resolvedAccount, result.port);
      return result;
    }

    if (result.status === 'missing') {
      set({
        isConnecting: false,
        isRestoringSession: false,
        rememberedFailure: { accountId, kind: 'missing' },
        error: null,
      });
      return result;
    }

    const message = humanizeLoginError(result.error);
    set({
      isConnecting: false,
      isRestoringSession: false,
      rememberedFailure: {
        accountId,
        kind: result.status === 'invalid' ? 'invalid' : 'retryable',
        error: message,
      },
      error: message,
    });
    return result;
  },

  disconnect: async () => {
    connectionAttempts.invalidate();
    const { ws, activeAccountId } = get();
    if (activeAccountId) { closeSocket(activeAccountId); warmAttempted.add(activeAccountId); }
    ws?.disconnect();
    desktop()?.setRelayAgent?.(null);
    clearBaseUrl();
    useConfig.setState(useConfig.getInitialState());
    // Flip the visible state SYNCHRONOUSLY before any await. Subscribers
    // (notably the login screen's auto-redirect effect) read this on
    // their next render — if we awaited the IPC first, a route change
    // racing in between would land them on /(tabs)/chat with the old
    // ``isConnected: true`` still latched.
    useChat.getState().clearAll();
    set({
      ws: null,
      isConnected: false,
      isConnecting: false,
      isReconnecting: false,
      config: null,
      agentName: null,
      agentVersion: null,
      activeAccountId: null,
      isRestoringSession: false,
      rememberedFailure: null,
      error: null,
    });
    // A standalone agent window neither owns the shared resume slot nor
    // exclusively owns its loopback (a sibling window may be on the same
    // account). It just drops its own WS; the loopback is reaped on app
    // quit (stopAllLoopbacks). A primary window clears the slot and tears
    // down its sidecar as before.
    if (directedAccountId()) return;
    // Clear persisted connection so a reload doesn't try to resume it.
    await storage.removeItem(ACTIVE_CONNECTION_KEY);
    // Best-effort sidecar cleanup. Even if this fails we're already
    // disconnected from the renderer's perspective.
    if (activeAccountId) {
      try { await desktop()?.stopLoopback({ accountId: activeAccountId }); } catch { /* ignore */ }
    }
  },

  resumeConnection: async () => {
    const d = desktop();
    if (!d) {
      set({ isRestoringSession: false });
      return;
    }
    void get().refreshCredentialAvailability();
    const { activeAccountId, ws: currentWs } = get();
    if (currentWs) return;
    if (!activeAccountId) {
      set({ isRestoringSession: false });
      return;
    }
    const attempt = beginConnectionAttempt(activeAccountId);
    const connRaw = await storage.getItem(ACTIVE_CONNECTION_KEY);
    if (!attempt.isCurrent()) return;
    if (!connRaw) {
      set({ isRestoringSession: false, isConnecting: false });
      return;
    }
    let connInfo: { accountId: string; sidecarPort: number };
    try { connInfo = JSON.parse(connRaw); } catch {
      set({ isRestoringSession: false, isConnecting: false });
      return;
    }
    if (connInfo.accountId !== activeAccountId) {
      set({ isRestoringSession: false, isConnecting: false });
      return;
    }
    const port = await d.getLoopbackPort(activeAccountId);
    if (!attempt.isCurrent()) return;
    const account = get().accounts.find((a) => a.id === activeAccountId);
    if (!account) {
      set({ isRestoringSession: false, isConnecting: false });
      return;
    }
    if (port) {
      wire(account, port);
      return;
    }
    await get().connectRememberedAccount(activeAccountId);
  },

  // ── multi-window (Electron) ──

  openAccountWindow: async (
    accountId,
    password,
    remember = false,
    selectedAgentHandle,
  ) => {
    const d = desktop();
    if (!d || typeof d.openAgentWindow !== 'function') {
      return { ok: false, error: 'Opening another agent in its own window requires the desktop app.' };
    }
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };

    // Bring up (or reuse) this account's loopback WITHOUT tearing down any
    // other connection — this window keeps its current agent. Two windows on
    // the same account share one loopback: ``startLoopback`` is idempotent
    // and returns the existing port (so an already-running agent needs no
    // password). We only need the password to spawn a loopback that isn't up
    // yet; it never leaves this window.
    try {
      const existingPort = await d.getLoopbackPort(accountId);
      if (!existingPort) {
        if (!password) {
          if (!d.startRememberedLoopback) {
            return { ok: false, needsPassword: true, error: 'Enter the password to open this agent.' };
          }
          const remembered = await d.startRememberedLoopback(accountLoopbackTarget(account));
          const recoveredTarget = 'target' in remembered ? remembered.target : undefined;
          if (recoveredTarget) {
            await persistVerifiedTarget(accountId, recoveredTarget);
          }
          if (remembered.status === 'missing') {
            return { ok: false, needsPassword: true, error: 'Enter the password to open this agent.' };
          }
          if (remembered.status === 'invalid') {
            return {
              ok: false,
              needsPassword: true,
              error: humanizeLoginError(remembered.error),
            };
          }
          if (remembered.status === 'retryable_error') {
            return {
              ok: false,
              retryable: true,
              error: humanizeLoginError(remembered.error),
            };
          }
        } else {
          const started = await d.startLoopback({
            ...accountLoopbackTarget(account, selectedAgentHandle),
            password,
            remember,
          });
          await persistVerifiedTarget(accountId, started.target);
        }
      }
    } catch (e: any) {
      return { ok: false, error: humanizeLoginError(e?.message || String(e)) };
    }

    // Loopback is up — hand off to the main process, which opens a standalone
    // window at ``/?connect=<accountId>`` that connects passwordlessly.
    try {
      await d.openAgentWindow(accountId, undefined, get().activeAccountId ?? undefined);
    } catch (e: any) {
      return { ok: false, error: humanizeLoginError(e?.message || String(e)) };
    }
    return { ok: true };
  },

  connectDirected: async (accountId) => {
    const d = desktop();
    if (!d) {
      set({ isRestoringSession: false });
      return;
    }
    // Guard against a double-connect if boot runs this twice.
    if (get().ws) return;
    const attempt = beginConnectionAttempt(accountId);
    const port = await d.getLoopbackPort(accountId);
    if (!attempt.isCurrent()) return;
    // No live loopback for this account → can't connect without a password;
    // leave the window on the login screen (index.tsx preselects the account).
    if (!port) {
      // A standalone window can still use the same remembered-credential
      // path as the primary window. This keeps the password inside main.
      const result = await get().connectRememberedAccount(accountId);
      if (result.status === 'started') rememberDirectedAccount(accountId);
      return;
    }
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) {
      set({ isRestoringSession: false, isConnecting: false });
      return;
    }
    wire(account, port);
  },
  });
});

/** Hard cap on how long we wait for the gateway's auth_ok / auth_error
 *  frame after the WebSocket is wired. The loopback proxy is already
 *  bound at this point, so the budget only covers TCP-to-localhost +
 *  one iroh stream + one server frame — 15 s is generous. Cleared on
 *  any terminal outcome (auth_ok, auth_error, pre-auth close, manual
 *  disconnect). Was: no cap, so a silent gateway hang would lock the
 *  UI in "Connecting…" forever. */
const WS_AUTH_TIMEOUT_MS = 15_000;

/** How long after ``auth_ok`` to wait before deciding that a turn this
 *  client still shows as running is actually gone. The gateway replays its
 *  ``live_state`` snapshots immediately after auth, so this only has to
 *  cover their delivery, not a model's thinking time. */
const STALE_TURN_GRACE_MS = 8_000;

/** Wire up the WebSocket once we have a sidecar port.
 *
 * ``opts.persistActive`` (default true) controls whether an ``auth_ok``
 * writes the shared ``ACTIVE_CONNECTION_KEY`` slot. Standalone agent
 * windows pass ``false``: their account identity lives in the URL
 * (``?connect=<id>``), so they must not clobber the primary window's
 * cold-start resume target. */
function _openWebsocket(
  get: () => ConnectionState,
  set: (s: Partial<ConnectionState>) => void,
  config: ConnectionConfig & { sidecarPort: number },
  accountId: string,
) {
  let isChild = false;
  try {
    isChild = typeof window !== 'undefined' &&
      !!(window as any).desktop?.isChild;
  } catch { /* web / RN */ }

  const host = '127.0.0.1';
  const port = config.sidecarPort;
  const url = `ws://${host}:${port}/ws`;
  const instanceId = typeof window !== 'undefined'
    ? (window as any).desktop?.clientInstanceId
    : undefined;
  const ws = new OpenAgentWS(url, undefined, instanceId);

  if (isChild) {
    try {
      const { IpcWebSocket } = require('../services/ipc-ws');
      ws.setTransport(new IpcWebSocket());
    } catch { /* fall back to direct WS */ }
  }

  // Single-shot finalizer: any of {auth_ok, auth_error, pre-auth close,
  // retries-exhausted, timeout, disconnect} marks the attempt done so
  // later events don't double-fire (e.g. close → timer firing 3 s
  // later and overwriting the error).
  let attemptDone = false;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  const finalize = () => {
    attemptDone = true;
    if (authTimer != null) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  };
  // Skip mutations if this attempt is stale (the user clicked Connect
  // again before this attempt resolved → the store's ws is now a
  // different instance). Without this, a stale failure could overwrite
  // a fresh ``isConnecting: true``.
  const isCurrent = () => get().ws === ws;

  let cachedAuth: Extract<ServerMessage, { type: 'auth_ok' }> | null = null;
  let terminal = false;
  const authenticate = (msg: Extract<ServerMessage, { type: 'auth_ok' }>) => {
      const st = get();
      const acct = st.accounts.find((a) => a.id === accountId);
      set({
        isConnected: true,
        isConnecting: false,
        isReconnecting: false,
        isRestoringSession: false,
        rememberedFailure: null,
        // Fall back to persisted agent info or account name for child
        // windows where the synthesized auth_ok has no agent metadata.
        // @ts-ignore
        agentName: msg.agent_name || st.agentName || acct?.name,
        // @ts-ignore
        agentVersion: msg.version || st.agentVersion,
        error: null,
      });
      get().warmSavedAccounts();
      // Patch the saved account from the gateway's auth_ok frame —
      // covers post-join when we didn't yet know the network ID, and
      // keeps the display label fresh as the agent name evolves.
      const acc = get().accounts.find((a) => a.id === accountId);
      const serverAgent = (msg as any).agent_name as string | undefined;
      const serverNetwork = (msg as any).network as string | undefined;
      const serverHandle = (msg as any).handle as string | undefined;
      if (acc) {
        const updated = get().accounts.map((a) => {
          if (a.id !== accountId) return a;
          const next = { ...a };
          if (serverNetwork && !a.network) next.network = serverNetwork;
          if (serverHandle && !a.handle) next.handle = serverHandle;
          // Auto-name only when the account row is still sitting on
          // the bare handle / placeholder — leave user-customised
          // labels alone.
          if (serverAgent && (a.name === a.handle || a.name === '')) {
            next.name = `${next.handle}@${next.network} — ${serverAgent}`;
          }
          return next;
        });
        set({ accounts: updated });
        void persistAccountsSerialized(updated).catch(() => {});
      }
      // Persist the active connection so a renderer reload can resume
      // without re-entering credentials. Skipped for standalone agent
      // windows (they resume from their own ``?connect=`` URL instead) so
      // they don't overwrite the primary window's resume target — including
      // the login-fallback path, hence the ``directedAccountId()`` guard.
      if (!isChild && !directedAccountId()) {
        storage.setItem(ACTIVE_CONNECTION_KEY, JSON.stringify({
          accountId,
          sidecarPort: config.sidecarPort,
        }));
      }
      // Discover one initial v2 chat summary (or use the legacy list only on
      // old agents). Reconnect liveness is handled by the authoritative
      // live_state replay + grace check below, so it never needs a full
      // session-index download.
      const attachedAt = Date.now();
      void discoverSessionsAfterAuth(msg.capabilities, isCurrent);
      // A session the server never persisted (its turn died before the run
      // was written) is in no listing at all, so hydration cannot settle it.
      // The gateway's reattach replay is the signal instead: it lands right
      // after auth_ok, so anything still marked as running and silent past
      // this grace window is not running anywhere. The window is generous on
      // purpose — being slow to admit a turn is dead costs a few seconds of
      // spinner, while being hasty would tell the user their live turn had
      // been interrupted while its answer is still streaming in.
      setTimeout(() => {
        if (!isCurrent() || !get().isConnected) return;
        useChat.getState().settleStaleTurns(attachedAt);
      }, STALE_TURN_GRACE_MS);
  };

  ws.onMessage((msg) => {
    if (!isChild) desktop()?.wsRelayBroadcast?.(JSON.stringify(msg), accountId);
    if (msg.type === 'auth_ok') {
      cachedAuth = msg;
      finalize();
      get().rememberAgentPresentation(accountId, msg.agent_name, msg.thumbnail);
      if (isCurrent()) authenticate(msg);
    } else if (msg.type === 'agent_identity_changed') {
      if (cachedAuth) cachedAuth = { ...cachedAuth, agent_name: msg.name,
        thumbnail: msg.thumbnail === undefined ? cachedAuth.thumbnail : msg.thumbnail,
      };
      get().rememberAgentPresentation(accountId, msg.name, msg.thumbnail);
      if (!isCurrent()) return;
      set({ agentName: msg.name });
      // The broadcast carries only public presentation, never persona text.
      void useConfig.getState().loadConfig();
    } else if (msg.type === 'auth_error') {
      cachedAuth = null;
      terminal = true;
      finalize();
      if (!isCurrent()) return;
      const authError = humanizeLoginError((msg as any).reason);
      // An explicit authentication rejection is the one renderer-visible
      // signal that invalidates a remembered credential. Transport failures
      // below deliberately keep it and expose a passwordless retry instead.
      void desktop()?.forgetCredential?.(accountId).catch(() => { /* best effort */ });
      set({
        isConnected: false,
        isConnecting: false,
        isRestoringSession: false,
        rememberedFailure: { accountId, kind: 'invalid', error: authError },
        error: authError,
      });
    }
  });

  // Pre-auth WS drops (proxy can't reach the gateway, port stale,
  // gateway refused the cert pre-handshake) used to be invisible —
  // ``onclose`` only logged + scheduled a 3 s reconnect. Now the WS
  // surfaces them through onClose so we clear the loading state.
  ws.onClose(async (info) => {
    cachedAuth = null;
    if (info.reason !== 'post_auth') terminal = true;
    if (!isCurrent() && terminal) { finalize(); ws.disconnect(); return; }
    if (info.reason === 'replaced') {
      // The gateway has already accepted a newer transport for this device.
      // OpenAgentWS deliberately does not reconnect this superseded socket:
      // doing so would evict the newer one and start a replacement loop.
      // If this attempt is stale, the newer renderer-local WS owns the store
      // and must remain untouched.  Otherwise expose a settled, manually
      // retryable state without invalidating the remembered credential.
      finalize();
      if (!isCurrent()) return;
      const replacementError = 'This connection was replaced by a newer OpenAgent client on this device.';
      set({
        ws: null,
        config: null,
        isConnected: false,
        isConnecting: false,
        isReconnecting: false,
        isRestoringSession: false,
        rememberedFailure: {
          accountId,
          kind: 'retryable',
          error: replacementError,
        },
        error: replacementError,
      });
      return;
    }
    if (info.reason === 'post_auth') {
      // Mid-session drop — the WS auto-reconnect kicks in; surface a
      // "Reconnecting…" hint so the user knows why their messages have
      // stopped getting replies. Cleared on the next ``auth_ok``.
      if (!isCurrent()) return;
      set({ isReconnecting: true });
      return;
    }
    // Retries exhausted → the loopback's iroh transport is likely dead while
    // the proxy port is still bound (common after macOS sleep, a network
    // change, or an agent that never came back). Handled BEFORE the
    // ``attemptDone`` guard on purpose: ``finalize()`` runs on the first
    // ``auth_ok``, so for a session that HAS authenticated — the only kind
    // that can reach the post-auth budget — that guard used to swallow this
    // branch entirely. The tunnel was declared dead by the socket, nobody
    // was told, and the session stayed on "Reconnecting…" with no error and
    // no way back except relaunching the app.
    if (info.reason === 'retries_exhausted') {
      finalize();
      if (!isCurrent()) return;
      const acctId = get().activeAccountId;
      const account = acctId ? get().accounts.find((a) => a.id === acctId) : undefined;
      if (acctId && account) {
        // We can't restart the loopback without the password, but we
        // can at least stop the dead one and surface a clear error
        // with a reconnect prompt instead of "Reconnecting…" forever.
        try { await desktop()?.stopLoopback({ accountId: acctId }); } catch { /* ignore */ }
        if (!isCurrent()) return;
        set({
          isConnected: false,
          isConnecting: false,
          isReconnecting: false,
          isRestoringSession: false,
          rememberedFailure: {
            accountId: acctId,
            kind: 'retryable',
            error: 'Connection lost. The secure tunnel stopped responding. Check the network or agent and retry.',
          },
          error: 'Connection lost. The secure tunnel stopped responding. Check the network or agent and retry.',
        });
        ws.disconnect();
        return;
      }
    }
    if (attemptDone) return;
    if (info.reason === 'pre_auth' || info.reason === 'retries_exhausted') {
      finalize();
      if (!isCurrent()) return;
      const detail = info.detail || `WebSocket closed before authentication (code=${info.code})`;
      const retryError = humanizeLoginError(detail);

      set({
        isConnected: false,
        isConnecting: false,
        isReconnecting: false,
        isRestoringSession: false,
        rememberedFailure: { accountId, kind: 'retryable', error: retryError },
        error: retryError,
      });
      ws.disconnect();
    }
  });

  ws.onError(() => {
    // onError fires alongside onClose with no extra signal; let the
    // close handler do the work. Kept registered so future per-error
    // diagnostics can hook in without re-wiring the store.
  });

  authTimer = setTimeout(() => {
    if (attemptDone) return;
    finalize();
    terminal = true;
    if (!isCurrent()) { ws.disconnect(); return; }
    set({
      isConnected: false,
      isConnecting: false,
      isRestoringSession: false,
      rememberedFailure: {
        accountId,
        kind: 'retryable',
        error: 'The agent didn’t respond in time. Check that the server is running and try again.',
      },
      error: 'The agent didn’t respond in time. Check that the server is running and try again.',
    });
    ws.disconnect();
  }, WS_AUTH_TIMEOUT_MS);

  ws.setPresentationActive(false);
  ws.connect();
  return {
    port,
    sendRaw: (payload: string) => ws.sendRaw(payload),
    ready: () => !terminal && cachedAuth !== null,
    usable: () => !terminal && (!attemptDone || cachedAuth !== null),
    deactivate: () => ws.setPresentationActive(false),
    activate: () => {
      ws.setPresentationActive(true);
      setBaseUrl(host, port);
      set({ config, ws, error: null, activeAccountId: accountId });
      if (cachedAuth) authenticate(cachedAuth);
    },
    close: () => { terminal = true; finalize(); ws.disconnect(); },
  };
}
