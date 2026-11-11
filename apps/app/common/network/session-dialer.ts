/**
 * Authenticated session dialer — portable edition.
 *
 * Opens cert-prefixed iroh streams to a target NodeId. Uses abstract
 * transport types so the same pooling logic works on both desktop
 * (Node.js iroh addon) and iOS (Swift iroh-ffi bridge).
 */
import { GATEWAY_ALPN } from './coordinator-rpc';
import { dialWithTimeout } from './dial-helpers';
import type {
  TransportConnection,
  TransportBiStream,
  TransportEndpoint,
  TransportNodeAddr,
  TransportSendStream,
  TransportRecvStream,
} from './transport-types';

export interface GatewayStream {
  send: TransportSendStream;
  recv: TransportRecvStream;
  targetNodeId: string;
  closeSend(): Promise<void>;
}

export class SessionDialer {
  private readonly endpoint: TransportEndpoint;
  private certWire: Uint8Array;
  private readonly connections: Map<string, Promise<TransportConnection>> = new Map();
  private readonly addrHints: Map<string, TransportNodeAddr> = new Map();

  constructor(endpoint: TransportEndpoint, certWire: Uint8Array) {
    this.endpoint = endpoint;
    this.certWire = certWire;
  }

  setAddrHint(addr: TransportNodeAddr): void {
    this.addrHints.set(addr.nodeId, addr);
  }

  get cert(): Uint8Array {
    return this.certWire;
  }

  updateCert(newCertWire: Uint8Array): void {
    this.certWire = newCertWire;
  }

  async openGatewayStream(targetNodeId: string): Promise<GatewayStream> {
    let cached = await this.getOrOpenConnection(targetNodeId);
    try {
      return await this.openStreamOn(cached.connection, targetNodeId);
    } catch {
      this.evictConnection(targetNodeId, cached);
      cached = await this.getOrOpenConnection(targetNodeId);
      try {
        return await this.openStreamOn(cached.connection, targetNodeId);
      } catch (error) {
        this.evictConnection(targetNodeId, cached);
        throw error;
      }
    }
  }

  private async openStreamOn(
    conn: TransportConnection,
    targetNodeId: string,
  ): Promise<GatewayStream> {
    const bi: TransportBiStream = await conn.openBi();
    const cert = this.certWire;
    const prefix = new Uint8Array(4 + cert.length);
    new DataView(prefix.buffer).setUint32(0, cert.length, false);
    prefix.set(cert, 4);
    await bi.send.writeAll(prefix);
    return {
      send: bi.send,
      recv: bi.recv,
      targetNodeId,
      closeSend: async () => {
        if (typeof bi.send.finish === 'function') {
          try { await bi.send.finish(); } catch { /* ignore */ }
        }
      },
    };
  }

  private async getOrOpenConnection(
    nodeId: string,
  ): Promise<{ connection: TransportConnection; entry: Promise<TransportConnection> }> {
    let p = this.connections.get(nodeId);
    if (p === undefined) {
      const hint = this.addrHints.get(nodeId);
      const addr: TransportNodeAddr = hint ?? { nodeId };
      p = dialWithTimeout(this.endpoint, addr, GATEWAY_ALPN);
      this.connections.set(nodeId, p);
      p.catch(() => {
        if (this.connections.get(nodeId) === p) {
          this.connections.delete(nodeId);
        }
      });
    }
    return { connection: await p, entry: p };
  }

  private evictConnection(
    nodeId: string,
    cached: { connection: TransportConnection; entry: Promise<TransportConnection> },
  ): void {
    if (this.connections.get(nodeId) === cached.entry) {
      this.connections.delete(nodeId);
    }
    try {
      cached.connection.close(0n, new Uint8Array());
    } catch { /* ignore */ }
  }

  async close(): Promise<void> {
    const all = Array.from(this.connections.values());
    this.connections.clear();
    for (const cp of all) {
      try {
        const c = await cp;
        c.close(0n, new Uint8Array());
      } catch { /* ignore */ }
    }
  }
}
