import {
  CapabilityProtocolError,
  type ClientCapabilityServer,
  type ClientToolCall,
  type DesktopCapabilityStatus,
} from './protocol';
import { CapabilitySocket, type CapabilityConnectionPhase } from './capability-socket';
import { CapabilityConsentStore, type CapabilityConsent } from './consent-store';
import { LocalHostBridge, type HostToolsLaunch } from './host-bridge';

interface LoopbackTarget {
  accountId: string;
  baseUrl: string;
  gatewayKey: string;
  networkId: string;
  deviceId: string;
}

interface PendingToolEvent {
  clientAccountId: string;
  channelId: string;
  networkId: string;
  deviceId: string;
  generation: number;
  event: Record<string, unknown>;
}

const MAX_PENDING_TOOL_EVENTS = 1_024;
const CONSENT_STATUS_POLL_MS = 500;

export interface CapabilityManagerOptions {
  clientInstanceId: string;
  deviceLabel: string;
  hostLaunch: HostToolsLaunch;
  consentStore: CapabilityConsentStore;
  onStatus?: (status: DesktopCapabilityStatus) => void;
  /** Test/diagnostic override; production watches shared consent twice/second. */
  statusPollMs?: number;
}

/** Coordinates one local host process and one capability WS per loopback. */
export class CapabilityManager {
  private consent: CapabilityConsent;
  private generation = 1;
  private servers: ClientCapabilityServer[] = [];
  private targets = new Map<string, LoopbackTarget>();
  private sockets = new Map<string, CapabilitySocket>();
  private socketOwners = new Map<string, string>();
  private socketPhases = new Map<string, CapabilityConnectionPhase>();
  private socketActivity = new Map<string, number>();
  private pendingToolEvents = new Map<string, PendingToolEvent>();
  private stalePrincipals = new Map<string, Record<string, unknown>>();
  private host: LocalHostBridge;
  private hostReady = false;
  private consentVerified = false;
  private hostStarting: Promise<void> | null = null;
  private hostRetry: ReturnType<typeof setTimeout> | null = null;
  private hostRetryAttempt = 0;
  private catalogTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private statusSync: Promise<void> | null = null;
  private lastError: string | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private lifecycleOperations = new Set<Promise<unknown>>();
  private emergencyBlocked = false;
  private emergencyRevokePending = false;
  private consentWriteInProgress = false;

  constructor(private readonly options: CapabilityManagerOptions) {
    this.consent = options.consentStore.get();
    this.emergencyRevokePending =
      options.consentStore.getEmergencyRevokePending?.() ?? false;
    this.emergencyBlocked = this.emergencyRevokePending || !this.consent.enabled;
    this.host = new LocalHostBridge({
      launch: options.hostLaunch,
      principal: {
        kind: 'desktop',
        client_instance_id: options.clientInstanceId,
        device_label: options.deviceLabel,
      },
    });
    this.host.on('exit', (error: Error) => this.handleHostExit(error));
    this.host.on('protocol-error', (error: Error) => {
      this.lastError = error.message;
      this.emitStatus();
    });
    this.host.on('event', (frame: Record<string, unknown>) => this.handleHostEvent(frame));
  }

  async start(): Promise<void> {
    this.emitStatus();
    // The stand-alone host is the canonical consent owner shared with the
    // interactive CLI. Never push the Electron cache into it at boot. Once
    // that canonical state has been read, a persisted grant must attach every
    // already-certified loopback installed during Desktop startup; otherwise
    // a renderer reload looks enabled while a real Electron relaunch silently
    // stops advertising capabilities until the user toggles consent again.
    await this.ensureHost();
  }

  getStatus(): DesktopCapabilityStatus {
    const activeCalls = [...this.socketActivity.values()].reduce((sum, n) => sum + n, 0);
    const connectedAccounts = [...this.targets.values()].filter(
      (target) => this.sockets.get(target.gatewayKey)?.isAcknowledged,
    ).length;
    let phase: DesktopCapabilityStatus['phase'];
    if (!this.consentVerified) phase = this.hostStarting ? 'starting' : 'unavailable';
    else if (!this.consent.enabled || this.emergencyBlocked || this.emergencyRevokePending) phase = 'disabled';
    else if (activeCalls > 0) phase = 'active';
    else if (connectedAccounts > 0) phase = 'connected';
    else if (this.hostStarting) phase = 'starting';
    else if (!this.hostReady) phase = 'unavailable';
    else if ([...this.socketPhases.values()].some((value) => value === 'connecting')) phase = 'connecting';
    else phase = 'ready';

    return {
      clientInstanceId: this.options.clientInstanceId,
      consent: {
        ...this.consent,
        enabled: this.consent.enabled && !this.emergencyBlocked && !this.emergencyRevokePending,
      },
      phase,
      generation: this.generation,
      connectedAccounts,
      activeCalls,
      servers: this.servers.map((server) => ({ name: server.name, tools: server.tools.length })),
      error: this.lastError,
    };
  }

  setEnabled(enabled: boolean): Promise<DesktopCapabilityStatus> {
    if (this.shuttingDown) {
      return Promise.reject(new CapabilityProtocolError(
        'host_stopped',
        'OpenAgent is quitting; local computer access cannot be changed',
      ));
    }
    return this.trackLifecycleOperation(this.performSetEnabled(enabled));
  }

  private async performSetEnabled(enabled: boolean): Promise<DesktopCapabilityStatus> {
    // Reaching this method is an explicit user action (the IPC layer performs
    // the one-time native confirmation for grants). Persist through the host
    // so Desktop and CLI observe exactly one device-level decision.
    this.consentWriteInProgress = true;
    this.emergencyBlocked = true;
    this.stopSockets(enabled
      ? 'Local computer access enable is being persisted'
      : 'Local computer access disabled');
    // An explicit grant is the only user action allowed to supersede a
    // pending emergency tombstone. It remains runtime-blocked until the
    // canonical broker write below succeeds.
    if (enabled) this.setEmergencyRevokePending(false);
    this.emitStatus();
    try {
      await this.ensureHost(true);
      if (!this.host.running) {
        throw new CapabilityProtocolError('host_unavailable', 'Cannot update shared device consent while host-tools is unavailable');
      }
      await this.host.setConsent(enabled);
      this.setEmergencyRevokePending(false);
      this.emergencyBlocked = !enabled;
      this.consent = this.options.consentStore.cacheCanonical(enabled);
      this.consentVerified = true;
      this.generation += 1;
      this.lastError = null;
      this.emitStatus();
      if (enabled) {
        this.hostReady = true;
        await this.refreshCatalog();
        this.startCatalogPolling();
        for (const accountId of this.targets.keys()) this.attachSocket(accountId);
      } else {
        await this.disableRuntime();
      }
      return this.getStatus();
    } finally {
      this.consentWriteInProgress = false;
    }
  }

  /** Immediate kill switch: revoke first, then tear every execution path down. */
  emergencyDisable(): Promise<DesktopCapabilityStatus> {
    if (this.shuttingDown) {
      this.setEmergencyRevokePending(true);
      this.emergencyBlocked = true;
      this.stopSockets('OpenAgent is quitting');
      this.emitStatus();
      return Promise.resolve(this.getStatus());
    }
    return this.trackLifecycleOperation(this.performEmergencyDisable());
  }

  private async performEmergencyDisable(): Promise<DesktopCapabilityStatus> {
    this.setEmergencyRevokePending(true);
    this.emergencyBlocked = true;
    this.generation += 1;
    this.stopSockets('Emergency local-access disable');
    this.emitStatus();
    try {
      if (!this.host.running) await this.ensureHost(true);
      if (!this.host.running) throw new Error('Local capability host is unavailable');
      await this.persistEmergencyRevocation();
    } catch (error) {
      // Runtime access is still stopped immediately. Keep the failure visible:
      // another process cannot be claimed revoked until canonical persistence
      // succeeds.
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    await this.host.hardStop();
    this.hostReady = false;
    this.servers = [];
    this.scheduleHostRetry();
    this.emitStatus();
    return this.getStatus();
  }

  addLoopback(
    accountId: string,
    baseUrl: string,
    gatewayKey: string,
    networkId: string,
    deviceId: string,
  ): void {
    if (![accountId, baseUrl, gatewayKey, networkId, deviceId].every(
      (value) => typeof value === 'string' && value.length > 0,
    )) {
      this.lastError = 'Capability loopback is missing its certified account/device binding';
      this.emitStatus();
      return;
    }
    this.targets.set(accountId, { accountId, baseUrl, gatewayKey, networkId, deviceId });
    if (!this.emergencyBlocked && this.consentVerified && this.consent.enabled) {
      void this.ensureHost().then(() => this.attachSocket(accountId)).catch(() => {});
    }
  }

  async removeLoopback(accountId: string): Promise<void> {
    const target = this.targets.get(accountId);
    const principal = target ? this.accountPrincipal(accountId, target.networkId) : null;
    this.targets.delete(accountId);
    for (const [key, pending] of this.pendingToolEvents) {
      if (pending.clientAccountId === accountId) this.pendingToolEvents.delete(key);
    }
    if (!target) return;
    if (this.shuttingDown) {
      // beginShutdown already closed the capability socket. Closing the one
      // existing broker transport below will release all of its principals;
      // do not race an in-flight emergency consent barrier with another
      // release_principal request from loopback teardown.
      this.emitStatus();
      return;
    }
    const socket = this.sockets.get(target.gatewayKey);
    const remaining = [...this.targets.values()].find(
      (candidate) => candidate.gatewayKey === target.gatewayKey,
    );
    // A deduplicated channel is owned by one account solely for local audit /
    // per-account sidecar state. If that account disappears, rebind the same
    // gateway through another account rather than retaining a stale scope.
    if (remaining && this.socketOwners.get(target.gatewayKey) !== accountId) {
      this.emitStatus();
      return;
    }
    socket?.stop('Account loopback stopped');
    this.sockets.delete(target.gatewayKey);
    this.socketOwners.delete(target.gatewayKey);
    this.socketPhases.delete(target.gatewayKey);
    this.socketActivity.delete(target.gatewayKey);
    if (this.host.running && principal) {
      await this.host.releasePrincipal(principal).catch(() => {});
    }
    if (remaining && this.consent.enabled && !this.emergencyBlocked) {
      this.attachSocket(remaining.accountId);
    }
    this.emitStatus();
  }

  /**
   * Close the capability admission boundary synchronously.
   *
   * Electron calls this before waiting for loopback teardown so no retry,
   * catalog refresh, or account removal can reopen the local host meanwhile.
   */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.hostRetry) clearTimeout(this.hostRetry);
    if (this.catalogTimer) clearInterval(this.catalogTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.hostRetry = null;
    this.catalogTimer = null;
    this.statusTimer = null;
    this.stopSockets('OpenAgent is quitting');
  }

  shutdown(): Promise<void> {
    this.beginShutdown();
    if (!this.shutdownPromise) this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    // A click handler may have published the immediate fail-closed emergency
    // status while its canonical set_consent(false) request is still draining
    // providers. Never race that request with release/shutdown frames.
    if (this.lifecycleOperations.size > 0) {
      await Promise.allSettled([...this.lifecycleOperations]);
    }
    const hostStarting = this.hostStarting;
    if (hostStarting) await hostStarting.catch(() => {});
    const statusSync = this.statusSync;
    if (statusSync) await statusSync.catch(() => {});

    const owners = new Set(this.socketOwners.values());
    const activePrincipals = [...owners].flatMap((accountId) => {
      const target = this.targets.get(accountId);
      return target
        ? [this.accountPrincipal(accountId, target.networkId, this.generation)]
        : [];
    });
    const cleanup = [...this.stalePrincipals.values(), ...activePrincipals];
    // Never spawn a new stdio shim while quitting. The broker associates every
    // principal with its existing control socket and releases it on shutdown
    // or EOF, including a prior shim crash. Explicit release is useful only
    // while that exact transport is already alive.
    if (this.host.running) {
      await Promise.allSettled(
        cleanup.map((principal) => this.host.releasePrincipal(principal)),
      );
    }
    this.stalePrincipals.clear();
    await this.host.stop();
    this.hostReady = false;
  }

  private async ensureHost(controlOnly = false): Promise<void> {
    if (this.shuttingDown) return;
    if (this.hostReady && this.host.running && !this.emergencyRevokePending) {
      this.startStatusPolling();
      if (
        !controlOnly && !this.emergencyBlocked &&
        this.consentVerified && this.consent.enabled
      ) {
        for (const accountId of this.targets.keys()) this.attachSocket(accountId);
      }
      return;
    }
    if (this.hostStarting) return this.hostStarting;

    let shouldRetry = false;
    this.hostStarting = (async () => {
      this.lastError = null;
      this.emitStatus();
      try {
        const initialized = await this.host.start();
        this.hostReady = true;
        this.hostRetryAttempt = 0;
        const status = initialized ?? await this.host.status();
        const canonical = readCanonicalConsent(status);
        if (!canonical) {
          const explicitStatus = await this.host.status();
          const fromStatus = readCanonicalConsent(explicitStatus);
          if (!fromStatus) throw new CapabilityProtocolError(
            'invalid_host_response',
            'host-tools status did not include canonical consent',
          );
          this.consent = this.options.consentStore.cacheCanonical(
            fromStatus.enabled,
            fromStatus.version,
            fromStatus.updatedAt,
          );
        } else {
          this.consent = this.options.consentStore.cacheCanonical(
            canonical.enabled,
            canonical.version,
            canonical.updatedAt,
          );
        }
        this.consentVerified = true;
        if (this.emergencyRevokePending) {
          await this.persistEmergencyRevocation();
        } else if (!this.consentWriteInProgress) {
          this.emergencyBlocked = !this.consent.enabled;
        }
        this.startStatusPolling();
        await this.releaseStalePrincipals();
        if (this.consent.enabled && !this.emergencyBlocked && !this.emergencyRevokePending) {
          await this.refreshCatalog();
          this.startCatalogPolling();
          if (!controlOnly) {
            for (const accountId of this.targets.keys()) this.attachSocket(accountId);
          }
        }
      } catch (error) {
        this.hostReady = false;
        this.lastError = describeHostFailure(error, this.options.hostLaunch);
        shouldRetry = true;
      } finally {
        this.hostStarting = null;
        if (shouldRetry) this.scheduleHostRetry();
        this.emitStatus();
      }
    })();
    return this.hostStarting;
  }

  private async refreshCatalog(): Promise<void> {
    if (
      !this.consent.enabled || this.emergencyBlocked ||
      this.emergencyRevokePending || !this.host.running
    ) return;
    try {
      const catalog = await this.host.catalog();
      const next = sanitizeCatalog(catalog.servers);
      const changed = JSON.stringify(next) !== JSON.stringify(this.servers);
      this.servers = next;
      this.lastError = null;
      if (changed) {
        // A catalog revision is not a new execution-host generation. Keeping
        // the generation stable lets the Gateway atomically replace the
        // catalog on this existing socket without invalidating in-flight calls.
        for (const socket of this.sockets.values()) socket.updateCatalog();
      }
      this.emitStatus();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emitStatus();
      throw error;
    }
  }

  private attachSocket(accountId: string): void {
    if (
      this.shuttingDown || this.emergencyBlocked ||
      !this.consent.enabled || !this.hostReady
    ) return;
    const target = this.targets.get(accountId);
    if (!target) return;
    const channelKey = target.gatewayKey;
    if (this.sockets.has(channelKey)) return;
    const url = capabilityUrl(target.baseUrl);
    const socket = new CapabilitySocket({
      accountId,
      trustedAccountId: target.networkId,
      trustedDeviceId: target.deviceId,
      url,
      clientInstanceId: this.options.clientInstanceId,
      deviceLabel: this.options.deviceLabel,
      getOffer: () => ({ generation: this.generation, servers: this.servers }),
      invoke: (call, signal) => this.invoke(accountId, call, signal),
      onPhase: (phase, error) => {
        this.socketPhases.set(channelKey, phase);
        if (error && phase === 'error') this.lastError = error;
        if (phase === 'connected') this.lastError = null;
        this.emitStatus();
      },
      onActivity: (count) => {
        this.socketActivity.set(channelKey, count);
        this.emitStatus();
      },
    });
    this.sockets.set(channelKey, socket);
    this.socketOwners.set(channelKey, accountId);
    this.socketPhases.set(channelKey, 'connecting');
    this.drainPendingToolEvents(accountId, socket);
    socket.start();
    this.emitStatus();
  }

  private async invoke(accountId: string, call: ClientToolCall, signal: AbortSignal) {
    if (this.emergencyBlocked || !this.consent.enabled) {
      throw new CapabilityProtocolError('consent_required', 'Local computer access is disabled');
    }
    if (!this.hostReady || !this.host.running) {
      throw new CapabilityProtocolError('host_unavailable', 'Local capability host is unavailable');
    }
    const server = this.servers.find((candidate) => candidate.name === call.server);
    if (!server || !server.tools.some((tool) => tool.name === call.tool)) {
      throw new CapabilityProtocolError(
        'unknown_tool',
        `Tool ${call.server}.${call.tool} is not in this client's advertised catalog`,
      );
    }
    const target = this.targets.get(accountId);
    if (
      call.network_id !== undefined &&
      (!target || call.network_id !== target.networkId)
    ) {
      throw new CapabilityProtocolError(
        'network_mismatch',
        'Capability call network does not match its certified loopback',
      );
    }
    return this.host.call({
      callId: call.call_id,
      server: call.server,
      tool: call.tool,
      toolArgs: call.args,
      idempotencyKey: call.idempotency_key,
      argumentsSha256: call.arguments_sha256,
      deadlineMs: call.deadline_ms,
      signal,
      // CapabilitySocket already compared this server-supplied value with
      // the coordinator-certified network bound to the local loopback. It is
      // therefore safe as a broker isolation key, but never as a selector.
      principal: this.accountPrincipal(accountId, call.account_id),
    });
  }

  private accountPrincipal(
    accountId: string,
    certifiedAccountId?: string,
    generation = this.generation,
  ): Record<string, unknown> {
    const target = this.targets.get(accountId);
    if (!target) {
      throw new CapabilityProtocolError(
        'account_context_unavailable',
        'Local capability account has no certified loopback binding',
      );
    }
    if (certifiedAccountId !== undefined && certifiedAccountId !== target.networkId) {
      throw new CapabilityProtocolError(
        'account_mismatch',
        'Capability call account does not match its certified loopback',
      );
    }
    return {
      kind: 'desktop',
      client_instance_id: this.options.clientInstanceId,
      device_label: this.options.deviceLabel,
      account_id: target.networkId,
      // Local opaque id is carried separately for local audit/lifecycle only.
      // It never crosses the capability socket or reaches the model.
      client_account_id: accountId,
      network_id: target.networkId,
      channel_id: target.gatewayKey,
      device_id: target.deviceId,
      generation,
    };
  }

  private async disableRuntime(): Promise<void> {
    if (this.catalogTimer) clearInterval(this.catalogTimer);
    this.catalogTimer = null;
    this.stopSockets('Local computer access disabled');
    // Keep the control shim connected to the single-instance broker. Desktop
    // must observe a later CLI grant (and vice versa) without either process
    // having to restart.
    this.hostReady = this.host.running;
    this.servers = [];
    this.startStatusPolling();
    this.emitStatus();
  }

  private stopSockets(reason: string): void {
    for (const socket of this.sockets.values()) socket.stop(reason);
    this.sockets.clear();
    this.socketOwners.clear();
    this.socketPhases.clear();
    this.socketActivity.clear();
    this.pendingToolEvents.clear();
  }

  private handleHostEvent(frame: Record<string, unknown>): void {
    if (this.shuttingDown) return;
    const raw = frame.event;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const event = raw as Record<string, unknown>;
    if (event.type === 'catalog_changed') {
      void this.refreshCatalog().catch(() => {});
      return;
    }

    // Broker events carry the canonical principal that owned the local
    // resource. Use it only to select the already-certified account socket;
    // never forward it as a server-controlled selector.
    const principal = parseEventPrincipal(event.principal);
    if (
      !this.consent.enabled ||
      this.emergencyBlocked ||
      !principal ||
      principal.client_instance_id !== this.options.clientInstanceId ||
      typeof principal.account_id !== 'string' ||
      !principal.account_id ||
      principal.network_id !== principal.account_id ||
      principal.generation !== this.generation ||
      typeof principal.client_account_id !== 'string' ||
      !principal.client_account_id ||
      typeof principal.channel_id !== 'string' ||
      !principal.channel_id ||
      typeof principal.device_id !== 'string' ||
      !principal.device_id
    ) return;

    const forwarded = { ...event };
    delete forwarded.principal;
    const clientAccountId = principal.client_account_id;
    const channelId = principal.channel_id;
    const target = this.targets.get(clientAccountId);
    if (target && !targetMatchesPrincipal(target, principal)) return;
    const socket = target ? this.sockets.get(target.gatewayKey) : undefined;
    if (target && socket && this.socketOwners.get(target.gatewayKey) === clientAccountId) {
      socket.sendToolEvent(forwarded);
      return;
    }
    const key = pendingToolEventKey(clientAccountId, channelId, forwarded);
    if (!key) return;
    this.pendingToolEvents.set(key, {
      clientAccountId,
      channelId,
      networkId: principal.account_id,
      deviceId: principal.device_id,
      generation: this.generation,
      event: forwarded,
    });
    while (this.pendingToolEvents.size > MAX_PENDING_TOOL_EVENTS) {
      const oldest = this.pendingToolEvents.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.pendingToolEvents.delete(oldest);
    }
  }

  private drainPendingToolEvents(accountId: string, socket: CapabilitySocket): void {
    const target = this.targets.get(accountId);
    if (!target) return;
    for (const [key, pending] of this.pendingToolEvents) {
      if (
        pending.clientAccountId !== accountId ||
        pending.channelId !== target.gatewayKey ||
        pending.networkId !== target.networkId ||
        pending.deviceId !== target.deviceId ||
        pending.generation !== this.generation
      ) continue;
      if (socket.sendToolEvent(pending.event)) this.pendingToolEvents.delete(key);
    }
  }

  private handleHostExit(error: Error): void {
    if (this.catalogTimer) clearInterval(this.catalogTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.catalogTimer = null;
    this.statusTimer = null;
    this.hostReady = false;
    if (this.shuttingDown) {
      this.stopSockets('OpenAgent is quitting');
      return;
    }
    // Preserve the exact old principals so a surviving single-instance
    // broker can revoke their background shells/browser leases after the
    // control shim restarts. New calls never inherit those resources.
    for (const accountId of new Set(this.socketOwners.values())) {
      const target = this.targets.get(accountId);
      if (!target) continue;
      const principal = this.accountPrincipal(accountId, target.networkId, this.generation);
      this.stalePrincipals.set(JSON.stringify(principal), principal);
    }
    // A transport/broker restart keeps the capability generation stable. The
    // Gateway can then retry only read-only/idempotent calls on this exact
    // device+instance+generation. Mutations are already made indeterminate by
    // the lost transport and are never retried. Stale local resources are
    // revoked above before the same-generation socket is reattached.
    this.lastError = error.message;
    this.stopSockets('Local capability host exited');
    this.emitStatus();
    this.scheduleHostRetry();
  }

  private async releaseStalePrincipals(): Promise<void> {
    if (this.shuttingDown || !this.host.running || this.stalePrincipals.size === 0) return;
    for (const [key, principal] of this.stalePrincipals) {
      await this.host.releasePrincipal(principal);
      this.stalePrincipals.delete(key);
    }
  }

  private scheduleHostRetry(): void {
    if (this.shuttingDown || this.hostRetry || this.hostStarting) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.hostRetryAttempt++, 5));
    this.hostRetry = setTimeout(() => {
      this.hostRetry = null;
      // A failed emergency stop is a control-only retry. It may only persist
      // `enabled=false`; it must never refresh/advertise a catalog first.
      void this.ensureHost(this.emergencyRevokePending);
    }, delay);
  }

  private startCatalogPolling(): void {
    if (
      this.catalogTimer || !this.consent.enabled ||
      this.emergencyBlocked || this.emergencyRevokePending
    ) return;
    this.catalogTimer = setInterval(() => {
      void this.refreshCatalog().catch(() => {});
    }, 30_000);
  }

  private startStatusPolling(): void {
    if (this.statusTimer || this.shuttingDown || !this.host.running) return;
    this.statusTimer = setInterval(() => {
      if (this.statusSync) return;
      this.statusSync = this.syncCanonicalConsent().finally(() => {
        this.statusSync = null;
      });
    }, this.options.statusPollMs ?? CONSENT_STATUS_POLL_MS);
  }

  private async syncCanonicalConsent(): Promise<void> {
    if (this.shuttingDown || !this.host.running || this.consentWriteInProgress) return;
    try {
      if (this.emergencyRevokePending) {
        await this.persistEmergencyRevocation();
        await this.disableRuntime();
        return;
      }
      const canonical = readCanonicalConsent(await this.host.status());
      if (!canonical) throw new CapabilityProtocolError(
        'invalid_host_response',
        'host-tools status did not include canonical consent',
      );
      const enabledChanged = canonical.enabled !== this.consent.enabled;
      const metadataChanged = canonical.version !== this.consent.version ||
        canonical.updatedAt !== this.consent.updatedAt;
      if (!enabledChanged && !metadataChanged) return;

      this.consent = this.options.consentStore.cacheCanonical(
        canonical.enabled,
        canonical.version,
        canonical.updatedAt,
      );
      this.consentVerified = true;
      this.lastError = null;
      if (!enabledChanged) {
        this.emitStatus();
        return;
      }

      // A device-level decision made by CLI/Desktop is a new capability
      // generation. Calls on the previous catalog can never migrate across it.
      this.generation += 1;
      this.emergencyBlocked = !canonical.enabled;
      if (!canonical.enabled) {
        await this.disableRuntime();
        return;
      }

      this.hostReady = true;
      await this.refreshCatalog();
      this.startCatalogPolling();
      for (const accountId of this.targets.keys()) this.attachSocket(accountId);
      this.emitStatus();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emitStatus();
    }
  }

  private setEmergencyRevokePending(pending: boolean): void {
    this.emergencyRevokePending = pending;
    // Unit-test stores and older development clients may not yet implement
    // the tombstone methods; production CapabilityConsentStore always does.
    this.options.consentStore.setEmergencyRevokePending?.(pending);
  }

  private async persistEmergencyRevocation(): Promise<void> {
    if (!this.emergencyRevokePending) return;
    if (!this.host.running) {
      throw new CapabilityProtocolError(
        'host_unavailable',
        'Cannot persist emergency revocation while host-tools is unavailable',
      );
    }
    await this.host.setConsent(false);
    this.consent = this.options.consentStore.cacheCanonical(false);
    this.consentVerified = true;
    this.emergencyBlocked = true;
    // set_consent(false) is an admission barrier in host-tools: it cancels or
    // drains active calls and releases every registered principal before the
    // response. Old crash-recovery entries are therefore already satisfied.
    this.stalePrincipals.clear();
    this.setEmergencyRevokePending(false);
    this.lastError = null;
  }

  private trackLifecycleOperation<T>(operation: Promise<T>): Promise<T> {
    this.lifecycleOperations.add(operation);
    operation.then(
      () => this.lifecycleOperations.delete(operation),
      () => this.lifecycleOperations.delete(operation),
    );
    return operation;
  }

  private emitStatus(): void {
    this.options.onStatus?.(this.getStatus());
  }
}

function parseEventPrincipal(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function targetMatchesPrincipal(
  target: LoopbackTarget,
  principal: Record<string, unknown>,
): boolean {
  return principal.client_account_id === target.accountId &&
    principal.channel_id === target.gatewayKey &&
    principal.account_id === target.networkId &&
    principal.network_id === target.networkId &&
    principal.device_id === target.deviceId;
}

function pendingToolEventKey(
  clientAccountId: string,
  channelId: string,
  event: Record<string, unknown>,
): string | null {
  if (event.type !== 'shell_completed' || typeof event.shell_id !== 'string' || !event.shell_id) {
    return null;
  }
  return `${clientAccountId}:${channelId}:shell_completed:${event.shell_id}`;
}

function capabilityUrl(baseUrl: string): string {
  const url = new URL('/ws/capabilities', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function sanitizeCatalog(servers: ClientCapabilityServer[]): ClientCapabilityServer[] {
  const seen = new Set<string>();
  const clean: ClientCapabilityServer[] = [];
  for (const server of servers) {
    if (!server || typeof server.name !== 'string' || !server.name || seen.has(server.name)) continue;
    seen.add(server.name);
    const tools = Array.isArray(server.tools)
      ? server.tools.filter((tool) => tool && typeof tool.name === 'string' && tool.name.length > 0)
      : [];
    clean.push({ ...server, tools });
  }
  return clean;
}

function describeHostFailure(error: unknown, launch: HostToolsLaunch): string {
  const detail = error instanceof Error ? error.message : String(error);
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || detail.includes('ENOENT')) {
    return `Local capability host is not installed (${launch.command})`;
  }
  return detail;
}

function readCanonicalConsent(value: unknown): {
  enabled: boolean;
  version: number;
  updatedAt: string | null;
} | null {
  if (!value || typeof value !== 'object') return null;
  const root = value as Record<string, unknown>;
  const raw = root.consent && typeof root.consent === 'object'
    ? root.consent as Record<string, unknown>
    : root;
  if (typeof raw.enabled !== 'boolean') return null;
  return {
    enabled: raw.enabled,
    version: typeof raw.version === 'number' ? raw.version : 1,
    updatedAt: typeof raw.updated_at === 'string'
      ? raw.updated_at
      : typeof raw.updated_at === 'number'
        ? new Date(raw.updated_at * 1000).toISOString()
        : typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}
