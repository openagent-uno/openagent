/**
 * Native transport implementation for React Native (iOS / Android).
 *
 * Bridges the Swift/Kotlin ``OpenAgentTransport`` native module for
 * iroh QUIC networking and runs the shared TypeScript protocol code
 * (SRP-6a, CBOR coordinator RPC, cert verification) identically to
 * the Electron desktop transport — no protocol duplication.
 *
 * The native module exposes low-level iroh primitives (endpoint,
 * connect, stream, proxy). This layer orchestrates the full loopback
 * lifecycle and presents the same ``PlatformTransport`` surface the
 * connection store consumes.
 */
// Must stay first: installs globalThis.crypto on Hermes before the protocol modules use it.
import './crypto-shim';
import { NativeModules } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { generateIdentity, identityFromSecret, type Identity } from './identity';
import { IDENTITY_KEY, NETWORK_STORE_KEY, certKey, credentialKey } from './secure-store-keys';
import { bytesToHex, hexToBytes, bytesToBase64, base64ToBytes } from './encoding';
import {
  login as netLogin,
  register as netRegister,
  refreshCert,
  nodeIdToPubkeyBytes,
  LoginError,
  type LoginResult,
} from './login';
import { rpcCall, COORDINATOR_ALPN } from './coordinator-rpc';
import { dialWithTimeout, DialTimeoutError } from './dial-helpers';
import { SessionDialer } from './session-dialer';
import { decodeTicket, looksLikeTicket } from './ticket';
import { selectAgentForConnection, type DiscoverableAgent } from './agent-selection';
import type {
  PlatformTransport,
  PublicAccountTarget,
  RememberedLoopbackResult,
  TransportEndpoint,
  TransportConnection,
  TransportBiStream,
  TransportNodeAddr,
} from './transport-types';


interface NativeIrohModule {
  createEndpoint(secretKeyHex: string): Promise<{ nodeIdHex: string }>;
  addPeerAddr(nodeIdHex: string, relayUrl: string | null, addresses: string[]): Promise<void>;
  connect(nodeIdHex: string, alpnHex: string): Promise<{ connectionId: string }>;
  openBi(connectionId: string): Promise<{ streamId: string }>;
  streamWrite(streamId: string, dataBase64: string): Promise<void>;
  streamRead(streamId: string, maxBytes: number): Promise<{ dataBase64: string | null }>;
  streamFinish(streamId: string): Promise<void>;
  closeConnection(connectionId: string): Promise<void>;
  startProxy(
    agentNodeIdHex: string,
    certWireBase64: string,
    relayUrl: string | null,
    addresses: string[],
  ): Promise<{ port: number }>;
  stopProxy(accountId: string): Promise<void>;
  getProxyPort(accountId: string): Promise<{ port: number | null }>;
  shutdown(): Promise<void>;
}

function getNativeModule(): NativeIrohModule {
  const m = NativeModules.OpenAgentTransport;
  if (!m) throw new Error('OpenAgentTransport native module is not available');
  return m as NativeIrohModule;
}

interface StoredNetwork {
  name: string;
  networkId: string;
  coordinatorNodeId: string;
  coordinatorPubkeyHex: string;
  handle: string;
  coordinatorRelayUrl?: string;
  coordinatorAddresses?: string[];
}

interface NetworkStore {
  networks: StoredNetwork[];
}

// ── Async-safe network store (JSON in SecureStore) ───────────────────

async function loadNetworkStore(): Promise<NetworkStore> {
  try {
    const raw = await SecureStore.getItemAsync(NETWORK_STORE_KEY);
    if (raw) return JSON.parse(raw) as NetworkStore;
  } catch { /* ignore corrupt data */ }
  return { networks: [] };
}

async function saveNetworkStore(store: NetworkStore): Promise<void> {
  await SecureStore.setItemAsync(NETWORK_STORE_KEY, JSON.stringify(store));
}

function findNetwork(store: NetworkStore, network: string, handle?: string): StoredNetwork | null {
  const norm = network.trim().toLowerCase();
  const normHandle = handle?.trim().toLowerCase();
  return store.networks.find((n) => {
    const nameMatch = n.name.trim().toLowerCase() === norm || n.networkId.trim().toLowerCase() === norm;
    if (!nameMatch) return false;
    if (!normHandle) return true;
    return n.handle.trim().toLowerCase() === normHandle;
  }) ?? null;
}

// ── Identity persistence (Keychain via expo-secure-store) ────────────

async function loadOrCreateIdentity(): Promise<Identity> {
  try {
    const hex = await SecureStore.getItemAsync(IDENTITY_KEY);
    if (hex && hex.length === 64) {
      return await identityFromSecret(hexToBytes(hex));
    }
  } catch { /* corrupt or missing */ }

  const identity = await generateIdentity();
  await SecureStore.setItemAsync(IDENTITY_KEY, bytesToHex(identity.secret), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  return identity;
}

// ── Cert persistence ─────────────────────────────────────────────────

async function saveCert(networkId: string, certWire: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(
    certKey(networkId),
    bytesToBase64(certWire),
  );
}

// ── Credential persistence ───────────────────────────────────────────

interface RememberedCredential {
  version: 1;
  password: string;
  target: {
    accountId: string;
    networkName: string;
    networkId: string;
    handle: string;
    coordinatorNodeId: string;
    agentHandle: string;
    agentNodeId: string;
  };
}

async function saveCredential(accountId: string, password: string, target: RememberedCredential['target']): Promise<void> {
  const record: RememberedCredential = { version: 1, password, target };
  await SecureStore.setItemAsync(
    credentialKey(accountId),
    JSON.stringify(record),
    { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
  );
}

async function loadCredential(accountId: string): Promise<RememberedCredential | null> {
  try {
    const raw = await SecureStore.getItemAsync(credentialKey(accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedCredential;
    if (parsed.version !== 1 || !parsed.password || !parsed.target) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function removeCredential(accountId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(credentialKey(accountId));
  } catch { /* ignore */ }
}

// ── Native module → TransportEndpoint adapter ────────────────────────

class NativeEndpoint implements TransportEndpoint {
  private readonly mod: NativeIrohModule;
  private readonly _nodeIdHex: string;

  constructor(mod: NativeIrohModule, nodeIdHex: string) {
    this.mod = mod;
    this._nodeIdHex = nodeIdHex;
  }

  nodeId(): string {
    return this._nodeIdHex;
  }

  async connect(nodeAddr: TransportNodeAddr, alpn: Uint8Array): Promise<TransportConnection> {
    const alpnHex = bytesToHex(alpn);
    const { connectionId } = await this.mod.connect(nodeAddr.nodeId, alpnHex);
    return new NativeConnection(this.mod, connectionId);
  }
}

class NativeConnection implements TransportConnection {
  private readonly mod: NativeIrohModule;
  private readonly connId: string;

  constructor(mod: NativeIrohModule, connId: string) {
    this.mod = mod;
    this.connId = connId;
  }

  async openBi(): Promise<TransportBiStream> {
    const { streamId } = await this.mod.openBi(this.connId);
    return {
      send: {
        writeAll: async (buf: Uint8Array) => {
          await this.mod.streamWrite(streamId, bytesToBase64(buf));
        },
        finish: async () => {
          await this.mod.streamFinish(streamId);
        },
      },
      recv: {
        read: async (buf: Uint8Array): Promise<bigint | null> => {
          const { dataBase64 } = await this.mod.streamRead(streamId, buf.length);
          if (dataBase64 === null) return null;
          const data = base64ToBytes(dataBase64);
          buf.set(data.subarray(0, Math.min(data.length, buf.length)));
          return BigInt(Math.min(data.length, buf.length));
        },
      },
    };
  }

  close(_errorCode: bigint, _reason: Uint8Array): void {
    void this.mod.closeConnection(this.connId).catch(() => {});
  }
}

// ── Running loopback registry ────────────────────────────────────────

interface RunningLoopback {
  port: number;
  accountId: string;
  agentNodeId: string;
  agentHandle: string;
  networkId: string;
  verifiedTarget: VerifiedTarget;
}

interface VerifiedTarget {
  networkName: string;
  networkId: string;
  handle: string;
  coordinatorNodeId: string;
  agentHandle: string;
  agentNodeId: string;
}

const runningLoopbacks = new Map<string, RunningLoopback>();

type AgentRow = DiscoverableAgent & { label?: string };

async function listAgents(
  endpoint: TransportEndpoint,
  coordinatorNodeId: string,
  coordinatorAddr?: TransportNodeAddr,
): Promise<AgentRow[]> {
  const addr: TransportNodeAddr = coordinatorAddr ?? { nodeId: coordinatorNodeId };
  let conn;
  try {
    conn = await dialWithTimeout(endpoint, addr, COORDINATOR_ALPN);
  } catch (e) {
    if (e instanceof DialTimeoutError) {
      throw new LoginError(
        `list_agents: coordinator unreachable (timed out after ${e.timeoutMs}ms)`,
      );
    }
    throw e;
  }
  const result = await rpcCall(conn, 'list_agents', {});
  const raw = Array.isArray(result.agents) ? result.agents : [];
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') return {};
    const m = entry as Record<string, unknown>;
    return {
      handle: typeof m.handle === 'string' ? m.handle : undefined,
      nodeId: typeof m.node_id === 'string' ? m.node_id : undefined,
      label: typeof m.label === 'string' ? m.label : undefined,
    };
  });
}

function normalizedTargetValue(value: string): string {
  return value.trim().toLowerCase();
}

// ── PlatformTransport implementation ─────────────────────────────────

export function createNativeTransport(): PlatformTransport {
  return {
    platform: 'native' as const,

    async startLoopback(args) {
      const mod = getNativeModule();
      const { accountId, password, ticket, handle, network, agent, remember } = args;

      if (!password) throw new LoginError('password is required');

      let coordinatorNodeId: string | null = null;
      let inviteCode: string | null = null;
      let ticketRole: string | null = null;
      let bindTo = '';
      let networkName: string | undefined;
      let resolvedHandle: string | undefined;
      let coordinatorAddrHint: TransportNodeAddr | undefined;

      if (ticket) {
        if (!looksLikeTicket(ticket)) throw new LoginError('invalid ticket: missing oa1 prefix');
        const t = decodeTicket(ticket);
        coordinatorNodeId = t.coordinatorNodeId;
        inviteCode = t.code;
        ticketRole = t.role;
        bindTo = t.bindTo;
        networkName = t.networkName;
        resolvedHandle = bindTo || (handle ?? '').trim().toLowerCase();
        if (!resolvedHandle) throw new LoginError('user-role tickets need a handle');
        if (t.relayUrl || (t.addresses && t.addresses.length > 0)) {
          coordinatorAddrHint = {
            nodeId: t.coordinatorNodeId,
            relayUrl: t.relayUrl,
            addresses: t.addresses,
          };
        }
      } else {
        if (!handle || !network) throw new LoginError('pass either ticket, or handle + network');
        resolvedHandle = handle.trim().toLowerCase();
        networkName = network.trim().toLowerCase();
      }

      const store = await loadNetworkStore();
      let net: StoredNetwork | null = networkName ? findNetwork(store, networkName, resolvedHandle) : null;

      const identity = await loadOrCreateIdentity();
      await mod.createEndpoint(bytesToHex(identity.secret));

      if (coordinatorAddrHint) {
        await mod.addPeerAddr(
          coordinatorAddrHint.nodeId,
          coordinatorAddrHint.relayUrl ?? null,
          coordinatorAddrHint.addresses ?? [],
        );
      }

      const endpoint = new NativeEndpoint(mod, identity.nodeIdHex);
      let loginResult: LoginResult;
      let resolvedNet: StoredNetwork;

      if (net == null) {
        if (!coordinatorNodeId || !inviteCode) {
          throw new LoginError(
            `unknown network ${JSON.stringify(networkName)}; paste an oa1 ticket`,
          );
        }
        const coordPubkey = nodeIdToPubkeyBytes(coordinatorNodeId);
        if (ticketRole === 'device') {
          loginResult = await netLogin({
            endpoint,
            coordinatorNodeId,
            coordinatorPubkey: coordPubkey,
            handle: resolvedHandle!,
            password,
            devicePubkey: identity.publicKey,
            inviteCode,
            coordinatorAddr: coordinatorAddrHint,
          });
        } else {
          loginResult = await netRegister({
            endpoint,
            coordinatorNodeId,
            coordinatorPubkey: coordPubkey,
            handle: resolvedHandle!,
            password,
            devicePubkey: identity.publicKey,
            inviteCode,
            coordinatorAddr: coordinatorAddrHint,
          });
        }
        const cert = loginResult.cert;
        resolvedNet = {
          name: networkName ?? cert.networkId,
          networkId: cert.networkId,
          coordinatorNodeId,
          coordinatorPubkeyHex: bytesToHex(coordPubkey),
          handle: resolvedHandle!,
          coordinatorRelayUrl: coordinatorAddrHint?.relayUrl,
          coordinatorAddresses: coordinatorAddrHint?.addresses,
        };
        store.networks.push(resolvedNet);
        await saveCert(resolvedNet.networkId, loginResult.certWire);
        await saveNetworkStore(store);
      } else {
        const refreshAddr: TransportNodeAddr | undefined = net.coordinatorRelayUrl
          ? { nodeId: net.coordinatorNodeId, relayUrl: net.coordinatorRelayUrl, addresses: net.coordinatorAddresses }
          : undefined;
        if (refreshAddr) {
          await mod.addPeerAddr(
            refreshAddr.nodeId,
            refreshAddr.relayUrl ?? null,
            refreshAddr.addresses ?? [],
          );
          coordinatorAddrHint = refreshAddr;
        }
        loginResult = await refreshCert({
          endpoint,
          coordinatorNodeId: net.coordinatorNodeId,
          coordinatorPubkey: hexToBytes(net.coordinatorPubkeyHex),
          handle: resolvedHandle!,
          password,
          devicePubkey: identity.publicKey,
          networkId: net.networkId,
          coordinatorAddr: refreshAddr,
        });
        resolvedNet = net;
        await saveCert(resolvedNet.networkId, loginResult.certWire);
        await saveNetworkStore(store);
      }

      const agents = await listAgents(endpoint, resolvedNet.coordinatorNodeId, coordinatorAddrHint);
      if (agents.length === 0) throw new LoginError('no agents registered in network');

      const allowDefaultAgent = Boolean(ticket) || agents.length === 1;
      const chosen = selectAgentForConnection(agents, agent, { allowDefault: allowDefaultAgent });
      if (!chosen) {
        throw new LoginError(
          !agent && !allowDefaultAgent
            ? 'multiple agents are available; enter the agent handle'
            : `requested agent ${JSON.stringify(agent)} is no longer available`,
        );
      }
      if (!chosen.nodeId) throw new LoginError('agent record missing node_id');

      const agentAddr: TransportNodeAddr = { nodeId: chosen.nodeId };
      const { port } = await mod.startProxy(
        chosen.nodeId,
        bytesToBase64(loginResult.certWire),
        agentAddr.relayUrl ?? null,
        agentAddr.addresses ?? [],
      );

      const verifiedTarget: VerifiedTarget = {
        networkName: normalizedTargetValue(resolvedNet.name),
        networkId: normalizedTargetValue(resolvedNet.networkId),
        handle: normalizedTargetValue(resolvedNet.handle),
        coordinatorNodeId: normalizedTargetValue(resolvedNet.coordinatorNodeId),
        agentHandle: normalizedTargetValue(chosen.handle ?? ''),
        agentNodeId: normalizedTargetValue(chosen.nodeId),
      };

      runningLoopbacks.set(accountId, {
        port,
        accountId,
        agentNodeId: chosen.nodeId,
        agentHandle: chosen.handle ?? '',
        networkId: resolvedNet.networkId,
        verifiedTarget,
      });

      if (remember) {
        await saveCredential(accountId, password, {
          accountId,
          ...verifiedTarget,
        }).catch(() => {});
      }

      return {
        port,
        target: {
          network: verifiedTarget.networkName,
          handle: verifiedTarget.handle,
          agentHandle: verifiedTarget.agentHandle,
        },
      };
    },

    async startRememberedLoopback(args): Promise<RememberedLoopbackResult> {
      const cred = await loadCredential(args.accountId);
      if (!cred) return { status: 'missing' };

      try {
        const result = await this.startLoopback({
          accountId: args.accountId,
          password: cred.password,
          handle: cred.target.handle,
          network: cred.target.networkName,
          agent: cred.target.agentHandle,
        });
        return {
          status: 'started',
          port: result.port,
          target: result.target,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isAuthRejection = msg.toLowerCase().includes('unauthorized') ||
          msg.toLowerCase().includes('invalid_credentials') ||
          msg.toLowerCase().includes('wrong password');
        if (isAuthRejection) {
          await removeCredential(args.accountId);
          return {
            status: 'invalid',
            error: msg,
            target: {
              network: cred.target.networkName,
              handle: cred.target.handle,
              agentHandle: cred.target.agentHandle,
            },
          };
        }
        return {
          status: 'retryable_error',
          error: msg,
          target: {
            network: cred.target.networkName,
            handle: cred.target.handle,
            agentHandle: cred.target.agentHandle,
          },
        };
      }
    },

    async stopLoopback(args) {
      const mod = getNativeModule();
      runningLoopbacks.delete(args.accountId);
      await mod.stopProxy(args.accountId);
    },

    async getLoopbackPort(accountId) {
      const running = runningLoopbacks.get(accountId);
      if (running) return running.port;
      const mod = getNativeModule();
      const { port } = await mod.getProxyPort(accountId);
      return port;
    },

    async credentialsAvailable() {
      return await SecureStore.isAvailableAsync();
    },

    async forgetCredential(accountId) {
      await removeCredential(accountId);
    },
  };
}
