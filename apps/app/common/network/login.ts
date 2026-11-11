/**
 * Coordinator login orchestrator — portable edition.
 *
 * The single platform-specific dependency (converting an iroh NodeId
 * string to raw ed25519 pubkey bytes) is injected via
 * ``LoginParams.coordinatorPubkey`` — the caller resolves it using
 * either ``@number0/iroh`` (desktop) or pure hex parsing (iOS, where
 * iroh NodeIds are plain 64-char lowercase hex of the 32-byte pubkey).
 */
import {
  startLogin,
  respondLogin,
  verifyServer,
  makeRegistrationPayload,
  SrpError,
} from './srp-client';
import { rpcCall, COORDINATOR_ALPN, RpcError } from './coordinator-rpc';
import { dialWithTimeout, DialTimeoutError } from './dial-helpers';
import { verifyCert, CertVerificationError } from './device-cert';
import type { DeviceCert } from './device-cert';
import type { TransportEndpoint, TransportNodeAddr } from './transport-types';

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

export interface LoginParams {
  endpoint: TransportEndpoint;
  coordinatorNodeId: string;
  coordinatorPubkey: Uint8Array;
  handle: string;
  password: string;
  devicePubkey: Uint8Array;
  networkId?: string;
  inviteCode?: string;
  label?: string;
  coordinatorAddr?: TransportNodeAddr;
}

export interface RegisterParams extends LoginParams {
  inviteCode: string;
}

export interface LoginResult {
  certWire: Uint8Array;
  cert: DeviceCert;
}

function coordinatorAddr(params: { coordinatorNodeId: string; coordinatorAddr?: TransportNodeAddr }): TransportNodeAddr {
  return params.coordinatorAddr ?? { nodeId: params.coordinatorNodeId };
}

async function dialCoordinator(
  endpoint: TransportEndpoint,
  addr: TransportNodeAddr,
  step: string,
) {
  try {
    return await dialWithTimeout(endpoint, addr, COORDINATOR_ALPN);
  } catch (e) {
    if (e instanceof DialTimeoutError) {
      throw new LoginError(
        `${step}: coordinator unreachable (timed out after ${e.timeoutMs}ms). ` +
        `If the server is on this same machine, allow Local Network access for ` +
        `OpenAgent in System Settings → Privacy & Security.`,
      );
    }
    throw e;
  }
}

export async function register(params: RegisterParams): Promise<LoginResult> {
  const { endpoint, handle, password, inviteCode } = params;
  const pakeRecord = await makeRegistrationPayload(handle, password);
  const conn = await dialCoordinator(endpoint, coordinatorAddr(params), 'register');
  try {
    await rpcCall(conn, 'register', {
      invite: inviteCode,
      handle,
      pake_record: pakeRecord,
    });
  } catch (e) {
    if (e instanceof RpcError) {
      throw new LoginError(`register failed: ${e.message}`);
    }
    throw e;
  }
  return await login(params);
}

export async function login(params: LoginParams): Promise<LoginResult> {
  const {
    endpoint,
    coordinatorPubkey,
    handle,
    password,
    devicePubkey,
    networkId,
    inviteCode,
    label,
  } = params;

  const client = await startLogin(handle, password);

  let initResult: Record<string, unknown>;
  try {
    const initConn = await dialCoordinator(endpoint, coordinatorAddr(params), 'login_init');
    initResult = await rpcCall(initConn, 'login_init', {
      handle,
      ke1: client.ke1,
    });
  } catch (e) {
    if (e instanceof RpcError) {
      throw new LoginError(`login_init failed: ${e.message}`);
    }
    throw e;
  }

  const stateId = initResult.state_id;
  const serverResponseAny = initResult.response;
  if (typeof stateId !== 'string') {
    throw new LoginError(`login_init: state_id is not a string (got ${typeof stateId})`);
  }
  if (!(serverResponseAny instanceof Uint8Array)) {
    throw new LoginError('login_init: response is not bytes');
  }
  const serverResponse = new Uint8Array(serverResponseAny);

  let M1: Uint8Array;
  try {
    M1 = await respondLogin(client, serverResponse);
  } catch (e) {
    if (e instanceof SrpError) {
      throw new LoginError(`SRP respond failed: ${e.message}`);
    }
    throw e;
  }

  const finishParams: Record<string, unknown> = {
    state_id: stateId,
    ke3: M1,
    device_pubkey: devicePubkey,
  };
  if (inviteCode) finishParams.invite = inviteCode;
  if (label) finishParams.label = label;

  let finishResult: Record<string, unknown>;
  try {
    const finishConn = await dialCoordinator(endpoint, coordinatorAddr(params), 'login_finish');
    finishResult = await rpcCall(finishConn, 'login_finish', finishParams);
  } catch (e) {
    if (e instanceof RpcError) {
      throw new LoginError(`login_finish failed: ${e.message}`);
    }
    throw e;
  }

  const certAny = finishResult.cert;
  const m2Any = finishResult.m2;
  if (!(certAny instanceof Uint8Array)) {
    throw new LoginError('login_finish: cert is not bytes');
  }
  if (!(m2Any instanceof Uint8Array)) {
    throw new LoginError('login_finish: m2 is not bytes');
  }
  const certWire = new Uint8Array(certAny);
  const m2 = new Uint8Array(m2Any);

  try {
    verifyServer(client, m2);
  } catch {
    // Non-fatal — cert signature check below is the actual security boundary.
  }

  let cert: DeviceCert;
  try {
    cert = await verifyCert(certWire, coordinatorPubkey, {
      expectedNetworkId: networkId,
    });
  } catch (e) {
    if (e instanceof CertVerificationError) {
      throw new LoginError(`coordinator returned malformed cert: ${e.message}`);
    }
    throw e;
  }

  const expectedHandle = handle.trim().toLowerCase();
  if (cert.handle !== expectedHandle) {
    throw new LoginError(
      `cert handle mismatch (got ${JSON.stringify(cert.handle)}, expected ${JSON.stringify(expectedHandle)})`,
    );
  }
  if (!bytesEqual(cert.devicePubkey, devicePubkey)) {
    throw new LoginError("cert device pubkey doesn't match this device");
  }

  return { certWire, cert };
}

export async function refreshCert(params: LoginParams): Promise<LoginResult> {
  return await login(params);
}

export async function fetchNetworkInfo(
  endpoint: TransportEndpoint,
  coordinatorNodeId: string,
  coordinatorAddr?: TransportNodeAddr,
): Promise<Record<string, unknown>> {
  const addr: TransportNodeAddr = coordinatorAddr ?? { nodeId: coordinatorNodeId };
  const conn = await dialCoordinator(endpoint, addr, 'network_info');
  return await rpcCall(conn, 'network_info', {});
}

/**
 * Iroh NodeIds are the lowercase hex encoding of the 32-byte ed25519
 * public key. This works on both platforms without any native library.
 */
export function nodeIdToPubkeyBytes(nodeId: string): Uint8Array {
  const cleaned = nodeId.trim().toLowerCase();
  if (cleaned.length !== 64) {
    throw new LoginError(`NodeId must be 64 hex chars, got ${cleaned.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
