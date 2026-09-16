/**
 * In-process loopback supervisor: brings up an iroh node, registers/logs
 * in to the coordinator, and exposes a localhost port the renderer hits
 * with plain HTTP/WS.
 *
 * Replaces the previous subprocess model (spawning ``openagent network
 * loopback``) with a native TS implementation. The renderer-facing IPC
 * shape is unchanged: the renderer still calls ``loopback:start`` /
 * ``loopback:stop`` and gets a port back.
 */
import type { WebContents } from 'electron';
import {
  startNativeLoopback,
  type RunningLoopback,
  type StartLoopbackArgs as NativeStartArgs,
  type VerifiedLoopbackTarget,
} from '../network/start.js';
import { handleTrustedIpc } from '../security/trusted-ipc';
import {
  createCredentialPreferenceCoordinator,
  isCredentialRejection,
  isRememberedCredentialTargetRejection,
  publicRememberedCredentialTarget,
  rememberedCredentialMatchesRequest,
  type PublicRememberedCredentialTarget,
  type RememberedCredentialTarget,
} from './credentials-core';
import {
  loadRememberedCredential,
  removeRememberedCredential,
  saveRememberedCredential,
} from './credentials';
import { createAccountStartCoordinator } from './account-start-coordinator';
import { createAccountStopBarrier } from './account-stop-barrier';
import { createLoopbackConsumerRegistry } from './loopback-consumer-registry';
import { verifiedLoopbackTargetsEqual } from '../network/agent-window-routing.js';
import { withDeadline } from './promise-deadline';

interface LoopbackHandle {
  id: string;
  loopback: RunningLoopback;
  startedAt: number;
}

const handles = new Map<string, LoopbackHandle>();
export interface StartedLoopback {
  port: number;
  credentialTarget: RememberedCredentialTarget;
}

export interface LoopbackStartResult {
  port: number;
  target: PublicRememberedCredentialTarget;
}

interface InternalStartLoopbackArgs extends StartLoopbackArgs {
  expectedTarget?: VerifiedLoopbackTarget;
}

const accountStarts = createAccountStartCoordinator<StartedLoopback>();
const accountStops = createAccountStopBarrier();
const credentialPreferences = createCredentialPreferenceCoordinator();
const consumers = createLoopbackConsumerRegistry();
const observedRenderers = new Set<number>();

/**
 * Teardown includes native iroh shutdown, which has no AbortSignal and can
 * occasionally stay pending. Keep the real promise in accountStops so a new
 * runtime cannot overlap it, but never leave an IPC caller waiting forever.
 * SessionDialer already gives in-flight dials 20 seconds, so 25 seconds leaves
 * room for that budget plus proxy/runtime cleanup.
 */
const LOOPBACK_TEARDOWN_DEADLINE_MS = 25_000;

function awaitLoopbackLifecycle<T>(operation: Promise<T>, label: string): Promise<T> {
  return withDeadline(operation, LOOPBACK_TEARDOWN_DEADLINE_MS, label);
}

function claimLoopback(accountId: string, rendererId: number, attemptToken?: number): void {
  consumers.claim(accountId, rendererId, attemptToken);
}

async function stopLoopbackIfUnclaimed(accountId: string): Promise<void> {
  if (!consumers.hasConsumers(accountId)) await stopLoopback(accountId);
}

async function releaseLoopbackClaim(
  accountId: string,
  rendererId: number,
  attemptToken?: number,
): Promise<void> {
  const isUnclaimed = consumers.release(accountId, rendererId, attemptToken);
  if (isUnclaimed) await stopLoopbackIfUnclaimed(accountId);
}

function releaseLoopbackClaimWithDeferredCleanup(
  accountId: string,
  rendererId: number,
  attemptToken?: number,
): void {
  const isUnclaimed = consumers.release(accountId, rendererId, attemptToken);
  if (!isUnclaimed) return;
  // The claim mutation above is synchronous. Do not make an already-timed-out
  // start spend a second full deadline waiting for the same native teardown;
  // its barrier is still tracked and this cleanup remains observed.
  void stopLoopbackIfUnclaimed(accountId).catch((error) => {
    console.warn('[loopback] deferred cleanup after failed start:', error);
  });
}

function observeRenderer(contents: WebContents): void {
  const rendererId = contents.id;
  if (observedRenderers.has(rendererId)) return;
  observedRenderers.add(rendererId);
  contents.once('destroyed', () => {
    observedRenderers.delete(rendererId);
    const unclaimedAccountIds = consumers.releaseRenderer(rendererId);
    // Native teardown is deadline-bound and may reject while continuing behind
    // its barrier. Renderer destruction is fire-and-forget, so observe every
    // result rather than leaking a process-level unhandled rejection.
    void Promise.allSettled(unclaimedAccountIds.map(stopLoopbackIfUnclaimed));
  });
}

/** Atomically hands a newly-started loopback reservation to the standalone
 * window that will consume it. The destination claim is installed before the
 * source attempt is released, so the sidecar cannot be reaped in the small
 * gap between BrowserWindow creation and its first renderer IPC call. */
export function transferLoopbackAttempt(
  accountId: string,
  sourceRendererId: number,
  attemptToken: number | undefined,
  destination: WebContents,
): void {
  observeRenderer(destination);
  claimLoopback(accountId, destination.id);
  consumers.release(accountId, sourceRendererId, attemptToken);
}

/** Release a renderer's temporary reservation when an existing window already
 * owns the same verified target. This also reaps the redundant loopback when
 * nobody else claimed that account id. */
export async function releaseLoopbackReservation(
  accountId: string,
  rendererId: number,
  attemptToken?: number,
): Promise<void> {
  await releaseLoopbackClaim(accountId, rendererId, attemptToken);
}

/** Main-process-only target lookup used to deduplicate BrowserWindows. */
export function getVerifiedLoopbackTarget(
  accountId: string,
): VerifiedLoopbackTarget | null {
  const target = handles.get(accountId)?.loopback.verifiedTarget;
  return target ? { ...target } : null;
}

export interface LoopbackLifecycleHooks {
  onStarted?: (accountId: string, loopback: RunningLoopback) => void;
  onStopping?: (accountId: string) => void | Promise<void>;
}

let lifecycleHooks: LoopbackLifecycleHooks = {};

/** Main-process integration point for services that reuse the same tunnel. */
export function configureLoopbackLifecycleHooks(hooks: LoopbackLifecycleHooks): void {
  lifecycleHooks = hooks;
}

/**
 * Install a loopback that is already bound by the Desktop E2E harness.
 *
 * This is deliberately unavailable outside ``NODE_ENV=test``. It lets
 * Playwright exercise the real renderer, preload, capability manager and
 * host broker against a deterministic loopback endpoint without exposing a
 * renderer IPC that could bypass device authentication in production.
 */
export function installTestLoopback(accountId: string, loopback: RunningLoopback): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('installTestLoopback is available only in NODE_ENV=test');
  }
  if (!accountId || handles.has(accountId)) {
    throw new Error(`invalid or duplicate Desktop E2E loopback: ${accountId}`);
  }
  handles.set(accountId, { id: accountId, loopback, startedAt: Date.now() });
  lifecycleHooks.onStarted?.(accountId, loopback);
}

/** Hard cap on the whole sidecar bring-up: iroh dial + SRP login +
 *  list_agents + proxy bind. iroh-js exposes no AbortSignal, so we can't
 *  cancel the inner promise — when the timeout fires we let it run, but
 *  attach a teardown so any partial RunningLoopback that resolves later
 *  gets cleaned up rather than leaked. Was: hung indefinitely when iroh
 *  discovery couldn't reach the coordinator (common in DMG builds where
 *  macOS Local Network access is blocked). */
const STARTUP_TIMEOUT_MS = 30_000;

export interface StartLoopbackArgs {
  accountId: string;
  password: string;
  agent?: string;
  ticket?: string;
  handle?: string;
  network?: string;
  /** Renderer opt-in. The handler persists only after coordinator login
   * succeeds; omitted means leave the current preference untouched. */
  remember?: boolean;
  /** Renderer-local latest-attempt token; scoped by webContents.id in main. */
  attemptToken?: number;
}

export type RememberedLoopbackResult =
  | { status: 'started'; port: number; target: PublicRememberedCredentialTarget }
  | { status: 'missing' }
  | { status: 'invalid'; error: string; target?: PublicRememberedCredentialTarget }
  | { status: 'retryable_error'; error: string; target?: PublicRememberedCredentialTarget };

type RememberedLoopbackArgs = Omit<StartLoopbackArgs, 'password'>;

function validateStartArgs(
  raw: unknown,
  channel: 'loopback:start' | 'loopback:startRemembered',
  requiresPassword: boolean,
): StartLoopbackArgs | RememberedLoopbackArgs {
  const args = raw as Partial<StartLoopbackArgs> | null;
  if (!args || typeof args.accountId !== 'string') {
    throw new Error(`${channel}: accountId is required`);
  }
  if (requiresPassword && typeof args.password !== 'string') {
    throw new Error(`${channel}: password is required`);
  }
  const hasTicket = typeof args.ticket === 'string' && args.ticket.length > 0;
  const hasHandleNet =
    typeof args.handle === 'string' && args.handle.length > 0 &&
    typeof args.network === 'string' && args.network.length > 0;
  if (requiresPassword && !hasTicket && !hasHandleNet) {
    throw new Error(`${channel}: pass either ticket, or handle + network`);
  }
  for (const key of ['ticket', 'handle', 'network', 'agent'] as const) {
    const value = (args as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`${channel}: ${key} must be a string when present`);
    }
  }
  if (args.remember !== undefined && typeof args.remember !== 'boolean') {
    throw new Error(`${channel}: remember must be a boolean when present`);
  }
  if (
    args.attemptToken !== undefined &&
    (!Number.isSafeInteger(args.attemptToken) || args.attemptToken <= 0)
  ) {
    throw new Error(`${channel}: attemptToken must be a positive safe integer when present`);
  }
  // Return a new object instead of the renderer-owned value. In particular,
  // this strips main-only fields such as `expectedTarget` if hostile JS adds
  // them to the IPC payload.
  const validated: Partial<StartLoopbackArgs> = { accountId: args.accountId };
  if (requiresPassword) validated.password = args.password as string;
  for (const key of ['ticket', 'handle', 'network', 'agent'] as const) {
    if (args[key] !== undefined) validated[key] = args[key];
  }
  if (args.remember !== undefined) validated.remember = args.remember;
  if (args.attemptToken !== undefined) validated.attemptToken = args.attemptToken;
  return validated as StartLoopbackArgs | RememberedLoopbackArgs;
}

export async function startLoopback(args: InternalStartLoopbackArgs): Promise<StartedLoopback> {
  // Privacy preference is not conditional on starting a fresh loopback.
  // Remember=false must forget immediately even when another window keeps an
  // existing handle alive or this caller joins an in-flight start.
  const credentialPreference = credentialPreferences.begin(args.accountId, args.remember);
  if (credentialPreference.forgetImmediately) {
    try { removeRememberedCredential(args.accountId); } catch { /* best effort */ }
  }

  // A prior handle is deleted before its async teardown completes. Never
  // create/reuse this account until that teardown's barrier has settled.
  await awaitLoopbackLifecycle(
    accountStops.wait(args.accountId),
    'secure tunnel shutdown',
  );
  const existing = handles.get(args.accountId);
  if (existing) {
    if (
      args.expectedTarget &&
      !verifiedLoopbackTargetsEqual(existing.loopback.verifiedTarget, args.expectedTarget)
    ) {
      throw new Error('remembered credential target does not match the running loopback');
    }
    return {
      port: existing.loopback.port,
      credentialTarget: {
        accountId: args.accountId,
        ...existing.loopback.verifiedTarget,
      },
    };
  }
  const started = await accountStarts.run(
    args.accountId,
    () => startLoopbackFresh(args),
    (owned) => {
      // Only the call that created this in-flight start may persist its
      // password. Waiters with the same accountId share the port but must not
      // overwrite the keychain with credentials that were never authenticated.
      // Persistence remains best-effort and never falls back to plaintext.
      try {
        if (credentialPreference.shouldSaveAuthenticatedOwner()) {
          saveRememberedCredential(args.accountId, args.password, owned.credentialTarget);
        }
      } catch {
        // A keychain failure must not turn a valid login into a failed one.
      }
    },
  );
  return started;
}

async function startLoopbackFresh(args: InternalStartLoopbackArgs): Promise<StartedLoopback> {
  const nativeArgs: NativeStartArgs = {
    password: args.password,
    ticket: args.ticket,
    handle: args.handle,
    network: args.network,
    agent: args.agent,
    expectedTarget: args.expectedTarget,
  };

  const startPromise = startNativeLoopback(nativeArgs);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new Error(`loopback startup timed out after ${STARTUP_TIMEOUT_MS}ms`));
    }, STARTUP_TIMEOUT_MS);
  });

  // If the native loopback eventually succeeds AFTER we've timed out, tear
  // it down so the iroh node + proxy don't leak.
  startPromise.then(
    (lb) => {
      if (timedOut) {
        lb.stop().catch(() => { /* ignore */ });
      }
    },
    () => { /* error surfaces through Promise.race below */ },
  );

  let loopback: RunningLoopback;
  try {
    loopback = await Promise.race([startPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle != null) clearTimeout(timeoutHandle);
  }

  handles.set(args.accountId, {
    id: args.accountId,
    loopback,
    startedAt: Date.now(),
  });
  lifecycleHooks.onStarted?.(args.accountId, loopback);
  return {
    port: loopback.port,
    credentialTarget: {
      accountId: args.accountId,
      ...loopback.verifiedTarget,
    },
  };
}

export function stopLoopback(accountId: string): Promise<void> {
  // Drop ownership synchronously, then publish the stop promise before its
  // async body runs so any immediately-following A restart observes it.
  consumers.clearAccount(accountId);
  const teardown = accountStops.run(accountId, async () => {
    const h = handles.get(accountId);
    if (!h) return;
    try {
      await lifecycleHooks.onStopping?.(accountId);
    } catch (error) {
      // Capability detachment must not strand the authenticated transport.
      // Continue native teardown, while keeping the cleanup failure visible.
      console.warn(`[loopback ${accountId}] lifecycle stop error:`, error);
    }
    handles.delete(accountId);
    try {
      await h.loopback.stop();
    } catch (err) {
      console.warn(`[loopback ${accountId}] stop error:`, err);
    }
  });
  // `teardown` remains registered in accountStops after this wrapper times
  // out. A later start therefore fails boundedly instead of overlapping the
  // still-running native cleanup.
  return awaitLoopbackLifecycle(teardown, 'secure tunnel teardown');
}

export async function stopAllLoopbacks(): Promise<void> {
  const ids = Array.from(handles.keys());
  // App shutdown is best effort. A native cleanup that misses its deadline
  // must not produce an unhandled rejection from Electron's fire-and-forget
  // before-quit hook.
  await Promise.allSettled(ids.map((id) => stopLoopback(id)));
}

export function registerLoopbackHandlers(): void {
  handleTrustedIpc('loopback:start', async (event, raw: unknown) => {
    const args = validateStartArgs(raw, 'loopback:start', true) as StartLoopbackArgs;
    observeRenderer(event.sender);
    // Reserve ownership before awaiting the per-account single-flight. A
    // newer same-account attempt is then already visible when an older waiter
    // resolves stale and releases its own token.
    claimLoopback(args.accountId, event.sender.id, args.attemptToken);
    try {
      const started = await startLoopback(args);
      // A renderer may disappear while native startup is in flight. Its
      // destroyed handler removes the reservation; reap a newly-created
      // handle when no sibling renderer or newer attempt owns it.
      await stopLoopbackIfUnclaimed(args.accountId);
      return {
        port: started.port,
        target: publicRememberedCredentialTarget(started.credentialTarget),
      } satisfies LoopbackStartResult;
    } catch (error) {
      releaseLoopbackClaimWithDeferredCleanup(
        args.accountId,
        event.sender.id,
        args.attemptToken,
      );
      if (isCredentialRejection(error)) {
        removeRememberedCredential(args.accountId);
      }
      throw error;
    }
  });

  // The renderer supplies account metadata only. Password decryption and
  // loopback startup both happen in this trusted process, so a remembered
  // plaintext credential never crosses the contextBridge back into JS UI.
  handleTrustedIpc('loopback:startRemembered', async (event, raw: unknown): Promise<RememberedLoopbackResult> => {
    const args = validateStartArgs(
      raw,
      'loopback:startRemembered',
      false,
    ) as RememberedLoopbackArgs;
    observeRenderer(event.sender);
    const credential = loadRememberedCredential(args.accountId);
    if (credential == null) return { status: 'missing' };
    if (!rememberedCredentialMatchesRequest(credential, args)) {
      // Includes legacy/tampered renderer metadata and every ticket-bearing
      // request. Fail closed and force one fresh explicit authentication.
      removeRememberedCredential(args.accountId);
      return {
        status: 'invalid',
        error: 'Saved credential no longer matches this account. Enter the password again.',
      };
    }

    const publicTarget = publicRememberedCredentialTarget(credential.target);
    claimLoopback(args.accountId, event.sender.id, args.attemptToken);
    try {
      const target = credential.target;
      const started = await startLoopback({
        accountId: args.accountId,
        password: credential.password,
        handle: target.handle,
        network: target.networkName,
        agent: target.agentHandle,
        attemptToken: args.attemptToken,
        expectedTarget: {
          networkName: target.networkName,
          networkId: target.networkId,
          handle: target.handle,
          coordinatorNodeId: target.coordinatorNodeId,
          agentHandle: target.agentHandle,
          agentNodeId: target.agentNodeId,
        },
      });
      await stopLoopbackIfUnclaimed(args.accountId);
      return { status: 'started', port: started.port, target: publicTarget };
    } catch (error) {
      releaseLoopbackClaimWithDeferredCleanup(
        args.accountId,
        event.sender.id,
        args.attemptToken,
      );
      const message = error instanceof Error ? error.message : String(error);
      if (
        isCredentialRejection(error) ||
        isRememberedCredentialTargetRejection(error)
      ) {
        removeRememberedCredential(args.accountId);
        return { status: 'invalid', error: message, target: publicTarget };
      }
      // Connectivity/timeouts do not prove the password is wrong. Keep the
      // ciphertext so the renderer can offer a passwordless retry.
      return { status: 'retryable_error', error: message, target: publicTarget };
    }
  });

  handleTrustedIpc('loopback:stop', async (event, raw: unknown) => {
    const args = raw as { accountId: string };
    if (!args || typeof args.accountId !== 'string') {
      throw new Error('loopback:stop: accountId required');
    }
    await releaseLoopbackClaim(args.accountId, event.sender.id);
  });

  handleTrustedIpc('loopback:releaseAttempt', async (event, raw: unknown) => {
    const args = raw as { accountId?: unknown; attemptToken?: unknown } | null;
    if (
      !args || typeof args.accountId !== 'string' ||
      typeof args.attemptToken !== 'number' ||
      !Number.isSafeInteger(args.attemptToken) || args.attemptToken <= 0
    ) {
      throw new Error('loopback:releaseAttempt: accountId + positive attemptToken required');
    }
    await releaseLoopbackClaim(args.accountId, event.sender.id, args.attemptToken);
  });

  handleTrustedIpc('loopback:getPort', async (event, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) {
      throw new Error('loopback:getPort: accountId required');
    }
    const h = handles.get(accountId);
    if (h) {
      observeRenderer(event.sender);
      claimLoopback(accountId, event.sender.id);
    }
    return h ? h.loopback.port : null;
  });
}
