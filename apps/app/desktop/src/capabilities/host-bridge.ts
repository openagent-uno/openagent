import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  CapabilityProtocolError,
  HOST_TOOLS_PROTOCOL,
  type HostToolsCatalog,
  type HostToolsRequest,
  type HostToolsResponse,
} from './protocol';

const CONTROL_TIMEOUT_MS = 10_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 1_500;
const TERMINATE_EXIT_TIMEOUT_MS = 1_500;
const FORCE_EXIT_TIMEOUT_MS = 1_000;
// Match the capability plane's 64 MiB per-call artifact budget after base64
// expansion, with JSON envelope headroom. Larger output fails closed.
const MAX_LINE_BYTES = 96 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

export interface HostToolsLaunch {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  unavailableReason?: string;
  source: 'override' | 'packaged' | 'development' | 'path';
}

export interface HostToolsDiscoveryOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  manifestPath?: string;
}

/**
 * Resolve the stand-alone host-tools executable without invoking a shell.
 * The final PATH fallback is intentional: development installs made with
 * pipx/uv remain usable even when no sibling checkout is present.
 */
export function discoverHostTools(options: HostToolsDiscoveryOptions): HostToolsLaunch {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const exe = platform === 'win32' ? 'openagent-host-tools.exe' : 'openagent-host-tools';
  const override = env.OPENAGENT_HOST_TOOLS_BIN?.trim();
  if (override && !options.isPackaged) {
    return { command: override, args: [], source: 'override' };
  }

  const packaged = [
    path.join(options.resourcesPath, 'host-tools', `${platform}-${arch}`, exe),
    path.join(options.resourcesPath, 'host-tools', 'bin', exe),
    path.join(options.resourcesPath, 'host-tools', exe),
  ];
  for (const candidate of packaged) {
    if (exists(candidate)) {
      const error = verifyPackagedExecutable(
        candidate,
        options.resourcesPath,
        options.manifestPath,
        platform,
        arch,
      );
      return {
        command: candidate,
        args: [],
        source: 'packaged',
        ...(error ? { unavailableReason: error } : {}),
      };
    }
  }
  if (options.isPackaged) {
    return {
      command: packaged[0],
      args: [],
      source: 'packaged',
      unavailableReason: `No packaged host-tools executable for ${platform}-${arch}`,
    };
  }

  // appPath is normally <workspace>/openagent-app/desktop in development.
  const workspaceRoot = path.dirname(path.dirname(options.appPath));
  const repo = path.join(workspaceRoot, 'openagent-host-tools');
  const development = platform === 'win32'
    ? [
        path.join(repo, 'dist', `${platform}-${arch}`, exe),
        path.join(repo, '.venv', 'Scripts', exe),
        path.join(repo, 'dist', exe),
        path.join(repo, 'bin', exe),
      ]
    : [
        path.join(repo, 'dist', `${platform}-${arch}`, exe),
        path.join(repo, '.venv', 'bin', exe),
        path.join(repo, 'dist', exe),
        path.join(repo, 'bin', exe),
      ];
  for (const candidate of development) {
    if (exists(candidate)) {
      return { command: candidate, args: [], cwd: repo, source: 'development' };
    }
  }

  const sourceMain = path.join(repo, 'src', 'openagent_host_tools', '__main__.py');
  if (exists(sourceMain)) {
    const configuredPython = env.OPENAGENT_HOST_TOOLS_PYTHON?.trim();
    const pythonCandidates = platform === 'darwin'
      ? ['/opt/homebrew/bin/python3.11', '/usr/local/bin/python3.11']
      : [];
    const python = configuredPython
      || pythonCandidates.find((candidate) => exists(candidate))
      || (platform === 'win32' ? 'python' : 'python3.11');
    return {
      command: python,
      args: ['-m', 'openagent_host_tools'],
      cwd: repo,
      env: {
        PYTHONPATH: [path.join(repo, 'src'), env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      source: 'development',
    };
  }

  return { command: exe, args: [], source: 'path' };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LocalHostBridgeOptions {
  launch: HostToolsLaunch;
  principal: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

/** Main-process-only NDJSON bridge to the stand-alone capability host. */
export class LocalHostBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';
  private requestSequence = 0;
  private pending = new Map<string, PendingRequest>();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private childClosed = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

  constructor(private readonly options: LocalHostBridgeOptions) {
    super();
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode == null && !this.child.killed;
  }

  async start(): Promise<unknown> {
    if (this.stopPromise) await this.stopPromise;
    if (this.running) return undefined;
    if (this.options.launch.unavailableReason) {
      throw new CapabilityProtocolError(
        'host_integrity_error',
        this.options.launch.unavailableReason,
      );
    }
    this.stopping = false;
    this.stdoutBuffer = '';
    this.stderrTail = '';

    const launch = this.options.launch;
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...this.options.launch.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    this.childClosed.set(child, new Promise((resolve) => child.once('close', () => resolve())));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      this.emit('stderr', chunk);
    });
    child.on('error', (error) => this.handleExit(child, error));
    child.on('exit', (code, signal) => {
      const suffix = this.stderrTail.trim();
      const detail = `host-tools exited (code=${String(code)}, signal=${String(signal)})${suffix ? `: ${suffix}` : ''}`;
      this.handleExit(child, new Error(detail));
    });

    return this.request({
      type: 'initialize',
      protocol: HOST_TOOLS_PROTOCOL,
      principal: this.options.principal,
    });
  }

  async catalog(): Promise<HostToolsCatalog> {
    const result = await this.request({ type: 'catalog' });
    if (!result || typeof result !== 'object' || !Array.isArray((result as HostToolsCatalog).servers)) {
      throw new CapabilityProtocolError('invalid_host_response', 'host-tools returned an invalid catalog');
    }
    return result as HostToolsCatalog;
  }

  async setConsent(enabled: boolean): Promise<void> {
    await this.request({
      type: 'set_consent',
      enabled,
      consent_version: 1,
    });
  }

  async status(): Promise<unknown> {
    return this.request({ type: 'status' });
  }

  async releasePrincipal(principal: Record<string, unknown>): Promise<void> {
    await this.request({ type: 'release_principal', principal }, 5_000);
  }

  async call(args: {
    callId: string;
    server: string;
    tool: string;
    toolArgs: Record<string, unknown>;
    idempotencyKey: string;
    argumentsSha256: string;
    deadlineMs?: number;
    signal?: AbortSignal;
    principal?: Record<string, unknown>;
  }): Promise<unknown> {
    if (args.signal?.aborted) {
      throw new CapabilityProtocolError('cancelled', 'Client tool call was cancelled');
    }
    const onAbort = () => {
      void this.request({ type: 'cancel', call_id: args.callId }, 2_000).catch(() => {});
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.request({
        type: 'call',
        call_id: args.callId,
        server: args.server,
        tool: args.tool,
        args: args.toolArgs,
        idempotency_key: args.idempotencyKey,
        arguments_sha256: args.argumentsSha256,
        deadline_ms: args.deadlineMs,
        principal: args.principal ?? this.options.principal,
      }, requestTimeout(args.deadlineMs));
    } finally {
      args.signal?.removeEventListener('abort', onAbort);
    }
  }

  stop(): Promise<void> {
    return this.startStop(false);
  }

  hardStop(): Promise<void> {
    return this.startStop(true);
  }

  private startStop(immediate: boolean): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const operation = this.stopChild(immediate);
    this.stopPromise = operation;
    operation.then(
      () => { if (this.stopPromise === operation) this.stopPromise = null; },
      () => { if (this.stopPromise === operation) this.stopPromise = null; },
    );
    return operation;
  }

  private async stopChild(immediate: boolean): Promise<void> {
    const child = this.child;
    if (!child) {
      if (immediate) {
        this.rejectPending(new CapabilityProtocolError(
          'host_stopped',
          'Local capability host stopped',
        ));
      }
      return;
    }
    this.stopping = true;
    if (immediate) {
      this.rejectPending(new CapabilityProtocolError(
        'host_stopped',
        'Local capability host stopped',
      ));
    } else {
      try {
        await this.request({ type: 'shutdown' }, GRACEFUL_EXIT_TIMEOUT_MS);
      } catch {
        // The owned shim is terminated below if its protocol shutdown failed.
      }
      if (await this.waitForChildClose(child, GRACEFUL_EXIT_TIMEOUT_MS)) {
        if (this.child === child) this.child = null;
        return;
      }
    }

    if (child.exitCode == null) child.kill('SIGTERM');
    if (!await this.waitForChildClose(child, TERMINATE_EXIT_TIMEOUT_MS)) {
      if (child.exitCode == null) child.kill('SIGKILL');
      if (!await this.waitForChildClose(child, FORCE_EXIT_TIMEOUT_MS)) {
        throw new CapabilityProtocolError(
          'host_stop_timeout',
          `Owned local capability shim did not exit (pid=${String(child.pid)})`,
        );
      }
    }
    if (this.child === child) this.child = null;
  }

  private async waitForChildClose(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    const closed = this.childClosed.get(child);
    if (!closed) return child.exitCode != null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([closed.then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private request(request: Omit<HostToolsRequest, 'id'>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode != null || child.killed) {
      return Promise.reject(new CapabilityProtocolError(
        'host_unavailable',
        `Local capability host is not running (${this.options.launch.source}: ${this.options.launch.command})`,
      ));
    }
    const id = `desktop-${++this.requestSequence}`;
    const frame: HostToolsRequest = { id, ...request };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CapabilityProtocolError(
          'host_timeout',
          `Local capability host did not answer ${request.type} within ${timeoutMs}ms`,
        ));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new CapabilityProtocolError(
          'host_transport_lost',
          `Lost the local capability-host transport while writing: ${error.message}`,
        ));
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_LINE_BYTES) {
      const error = new CapabilityProtocolError(
        'host_protocol_error',
        `Local capability host emitted a line larger than ${MAX_LINE_BYTES} bytes`,
      );
      const child = this.child;
      if (child) {
        this.handleExit(child, error);
        void this.terminateDetachedChild(child);
      }
      return;
    }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit('protocol-error', new Error('host-tools emitted malformed JSON'));
      return;
    }
    if (frame.type === 'event') {
      this.emit('event', frame);
      return;
    }
    if (frame.type !== 'response' || typeof frame.id !== 'string') {
      this.emit('protocol-error', new Error('host-tools emitted an unknown frame'));
      return;
    }
    const response = frame as unknown as HostToolsResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }
    pending.reject(new CapabilityProtocolError(
      response.error?.code ?? 'host_error',
      response.error?.message ?? 'Local capability host returned an error',
      response.error?.data,
    ));
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    const transportError = error instanceof CapabilityProtocolError &&
      error.code === 'host_transport_lost'
      ? error
      : new CapabilityProtocolError('host_transport_lost', error.message);
    this.rejectPending(transportError);
    if (!this.stopping) this.emit('exit', transportError);
  }

  private async terminateDetachedChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode == null) child.kill('SIGTERM');
    if (!await this.waitForChildClose(child, TERMINATE_EXIT_TIMEOUT_MS)) {
      if (child.exitCode == null) child.kill('SIGKILL');
      await this.waitForChildClose(child, FORCE_EXIT_TIMEOUT_MS);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function verifyPackagedExecutable(
  executable: string,
  resourcesPath: string,
  manifestPath?: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return 'Packaged host-tools checksum manifest is missing';
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      version?: number;
      host_tools_version?: string;
      bundles?: Record<string, {
        executable?: string;
        size?: number;
        sha256?: string;
        host_tools_version?: string;
        bundle_manifest?: string;
        bundle_manifest_sha256?: string;
        file_count?: number;
      }>;
    };
    if (manifest.version !== 2 || !manifest.host_tools_version || !manifest.bundles) {
      return 'Packaged host-tools checksum manifest is invalid';
    }
    const key = `${platform}-${arch}`;
    const entry = manifest.bundles[key];
    const relative = path.relative(path.join(resourcesPath, 'host-tools'), executable)
      .split(path.sep).join('/');
    if (
      !entry ||
      entry.executable !== relative ||
      entry.bundle_manifest !== `${key}/bundle-manifest.json` ||
      entry.host_tools_version !== manifest.host_tools_version ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size ?? -1) < 0 ||
      !Number.isSafeInteger(entry.file_count) ||
      (entry.file_count ?? 0) < 1 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(entry.bundle_manifest_sha256 ?? '')
    ) {
      return `Packaged host-tools is not pinned for ${key}`;
    }
    const executableStat = fs.statSync(executable);
    const actual = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    if (executableStat.size !== entry.size || actual !== entry.sha256) {
      return 'Packaged host-tools failed its executable integrity check';
    }

    // The signed app manifest pins the host project's complete checksum
    // manifest. The frozen host verifies every sidecar/asset listed inside it
    // before use; checking its digest here prevents manifest substitution.
    const bundleManifestPath = path.join(resourcesPath, 'host-tools', key, 'bundle-manifest.json');
    const bundleBytes = fs.readFileSync(bundleManifestPath);
    const bundleDigest = createHash('sha256').update(bundleBytes).digest('hex');
    if (bundleDigest !== entry.bundle_manifest_sha256) {
      return 'Packaged host-tools failed its bundle-manifest integrity check';
    }
    const bundle = JSON.parse(bundleBytes.toString('utf8')) as {
      manifest_version?: number;
      version?: string;
      platform?: string;
      files?: Record<string, { size?: number; sha256?: string }>;
    };
    const executableName = platform === 'win32' ? 'openagent-host-tools.exe' : 'openagent-host-tools';
    const pinnedExecutable = bundle.files?.[executableName];
    if (
      bundle.manifest_version !== 1 ||
      bundle.version !== manifest.host_tools_version ||
      bundle.platform !== key ||
      !bundle.files ||
      Object.keys(bundle.files).length !== entry.file_count ||
      pinnedExecutable?.size !== entry.size ||
      pinnedExecutable?.sha256 !== entry.sha256
    ) {
      return 'Packaged host-tools bundle manifest does not match the signed app manifest';
    }
    return null;
  } catch (error) {
    return `Could not verify packaged host-tools: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function requestTimeout(deadlineMs?: number): number {
  if (deadlineMs == null || !Number.isFinite(deadlineMs)) return 120_000;
  // Accept both an absolute epoch deadline and a relative duration. The wire
  // currently uses a duration; supporting epoch values makes skewed peers fail
  // closed instead of hanging forever.
  const remaining = deadlineMs > 1_000_000_000_000
    ? deadlineMs - Date.now()
    : deadlineMs;
  return Math.max(1, Math.min(remaining, 24 * 60 * 60 * 1000));
}
