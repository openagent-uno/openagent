/**
 * Platform-independent transport contracts.
 *
 * Both the Electron desktop (via ``@number0/iroh`` Node addon) and the
 * React Native iOS/Android module (via ``iroh-ffi`` Swift/Kotlin
 * bindings) implement these interfaces so protocol-level code (SRP,
 * coordinator RPC, cert verification) stays in shared TypeScript.
 */

/** Writable half of a bi-directional stream. */
export interface TransportSendStream {
  writeAll(buf: Uint8Array): Promise<void>;
  finish?(): Promise<void>;
}

/** Readable half of a bi-directional stream. */
export interface TransportRecvStream {
  read(buf: Uint8Array): Promise<bigint | null>;
}

export interface TransportBiStream {
  send: TransportSendStream;
  recv: TransportRecvStream;
}

export interface TransportConnection {
  openBi(): Promise<TransportBiStream>;
  close(errorCode: bigint, reason: Uint8Array): void;
  remoteNodeId?(): string;
}

export interface TransportNodeAddr {
  nodeId: string;
  relayUrl?: string;
  addresses?: string[];
}

export interface TransportEndpoint {
  connect(nodeAddr: TransportNodeAddr, alpn: Uint8Array): Promise<TransportConnection>;
  nodeId(): string;
}

/** Full runtime: endpoint + peer-table + lifecycle. */
export interface TransportRuntime {
  endpoint: TransportEndpoint;
  addPeerAddr(addr: TransportNodeAddr): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Loopback proxy: a localhost TCP listener that bridges each accepted
 * socket to an authenticated iroh bi-stream. Both the Electron
 * ``LoopbackProxy`` and the iOS NWListener variant implement this.
 */
export interface LoopbackProxyHandle {
  port: number;
  baseUrl: string;
  wsUrl: string;
  stop(): Promise<void>;
}

/**
 * Platform-level transport provider exposed to the renderer/RN JS.
 *
 * On Electron this is the ``window.desktop`` preload bridge. On React
 * Native this is the ``NativeModules.OpenAgentTransport`` native module.
 * The connection store consumes this interface without knowing which
 * platform backs it.
 */
export interface PlatformTransport {
  readonly platform: 'desktop' | 'native';
  clientInstanceId?: string;

  startLoopback(args: {
    accountId: string;
    password: string;
    ticket?: string;
    handle?: string;
    network?: string;
    agent?: string;
    remember?: boolean;
    attemptToken?: number;
  }): Promise<{ port: number; target: PublicAccountTarget }>;

  startRememberedLoopback?(args: {
    accountId: string;
    ticket?: string;
    handle?: string;
    network?: string;
    agent?: string;
    attemptToken?: number;
  }): Promise<RememberedLoopbackResult>;

  stopLoopback(args: { accountId: string }): Promise<void>;
  getLoopbackPort(accountId: string): Promise<number | null>;

  credentialsAvailable?(): Promise<boolean>;
  forgetCredential?(accountId: string): Promise<void>;
  releaseLoopbackAttempt?(args: { accountId: string; attemptToken: number }): Promise<void>;

  /** Desktop-only: relay WS message to child windows. */
  setRelayAgent?(id: string | null): void;
  wsRelayBroadcast?(payload: string, id: string): void;
  /** Desktop-only: open an agent in a separate window. */
  openAgentWindow?(
    accountId: string,
    attemptToken?: number,
    sourceAccountId?: string,
  ): Promise<void>;
}

export interface PublicAccountTarget {
  network: string;
  handle: string;
  agentHandle: string;
}

export type RememberedLoopbackResult =
  | { status: 'started'; port: number; target: PublicAccountTarget }
  | { status: 'missing' }
  | { status: 'invalid'; error: string; target?: PublicAccountTarget }
  | { status: 'retryable_error'; error: string; target?: PublicAccountTarget };
