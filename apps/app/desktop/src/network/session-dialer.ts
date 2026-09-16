/**
 * Authenticated dialer: opens cert-prefixed iroh streams to a target NodeId.
 *
 * Mirrors ``openagent/network/client/session.py:SessionDialer``. Each
 * ``openGatewayStream`` call writes ``u32(BE) cert_len || cert_wire``
 * to the new bi-stream's send half; the gateway side reads that prefix
 * before handing the stream to its HTTP/WS server.
 *
 * Connections are pooled per NodeId so multiple concurrent HTTP/WS
 * requests share one iroh connection. The cache stores the Promise,
 * not the resolved connection, so two simultaneous callers don't race
 * to open two connections.
 */
import { GATEWAY_ALPN } from './coordinator-rpc.js';
import { dialWithTimeout } from './dial-helpers.js';
import type {
  IrohConnection,
  IrohBiStream,
  IrohEndpoint,
  IrohNodeAddr,
  IrohSendStream,
  IrohRecvStream,
} from './iroh-types.js';

export interface GatewayStream {
  send: IrohSendStream;
  recv: IrohRecvStream;
  targetNodeId: string;
  /** Half-close the send half — caller still drains recv. */
  closeSend(): Promise<void>;
}

export class SessionDialer {
  private readonly endpoint: IrohEndpoint;
  private certWire: Uint8Array;
  private readonly connections: Map<string, Promise<IrohConnection>> = new Map();
  /** Per-target hint addresses (relay/UDP) seeded from tickets or the
   *  cert store. Lets ``endpoint.connect`` skip discovery for known peers. */
  private readonly addrHints: Map<string, IrohNodeAddr> = new Map();

  constructor(endpoint: IrohEndpoint, certWire: Uint8Array) {
    this.endpoint = endpoint;
    this.certWire = certWire;
  }

  /** Seed an address hint for a target. Subsequent dials to ``nodeId``
   *  use the supplied relay URL + direct addresses instead of relying
   *  on iroh discovery. Idempotent — last write wins. */
  setAddrHint(addr: IrohNodeAddr): void {
    this.addrHints.set(addr.nodeId, addr);
  }

  get cert(): Uint8Array {
    return this.certWire;
  }

  /**
   * Swap in a freshly-refreshed cert. In-flight streams keep using the
   * cert that was current when their connection was established; new
   * streams pick up the new cert immediately.
   */
  updateCert(newCertWire: Uint8Array): void {
    this.certWire = newCertWire;
  }

  /** Open one bi-stream to ``targetNodeId`` with the cert prefix attached.
   *
   *  A pooled connection can die with nobody telling us: the agent restarts,
   *  the relay drops the path, the laptop sleeps. iroh reports that only when
   *  the connection is next used, so ``openBi`` (or the cert write behind it)
   *  is where we find out. Until this retry existed the pool kept handing out
   *  the corpse: every stream failed instantly, the loopback proxy reset every
   *  local socket, and the app sat on "Reconnecting…" until it was restarted —
   *  even though a fresh dial would have worked, the iroh endpoint and the
   *  cert both being alive in this process. So: evict the dead entry and dial
   *  once more. One retry, not a loop — if the fresh connection fails too, the
   *  agent really is unreachable and the caller must hear about it. */
  async openGatewayStream(targetNodeId: string): Promise<GatewayStream> {
    let cached = await this.getOrOpenConnection(targetNodeId);
    try {
      return await this.openStreamOn(cached.connection, targetNodeId);
    } catch {
      // A successfully-dialled QUIC connection can die later. Keeping that
      // resolved Promise in the pool makes every WebSocket reconnect reuse the
      // same dead connection forever. Evict only the entry this attempt used
      // (another concurrent caller may already have installed a replacement),
      // then make one bounded redial attempt. This also covers a connection
      // that dies between a fresh dial and its first stream.
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
    conn: IrohConnection,
    targetNodeId: string,
  ): Promise<GatewayStream> {
    const bi: IrohBiStream = await conn.openBi();
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
          try {
            await bi.send.finish();
          } catch {
            // ignore
          }
        }
      },
    };
  }

  private async getOrOpenConnection(
    nodeId: string,
  ): Promise<{ connection: IrohConnection; entry: Promise<IrohConnection> }> {
    let p = this.connections.get(nodeId);
    if (p === undefined) {
      const hint = this.addrHints.get(nodeId);
      const addr: IrohNodeAddr = hint ?? { nodeId };
      p = dialWithTimeout(this.endpoint, addr, GATEWAY_ALPN);
      this.connections.set(nodeId, p);
      p.catch(() => {
        // Whether the failure is a timeout or a real dial error, evict
        // so the next caller retries with a fresh attempt — a hung
        // promise that later resolves is closed by dialWithTimeout's
        // late-cleanup path.
        if (this.connections.get(nodeId) === p) {
          this.connections.delete(nodeId);
        }
      });
    }
    return { connection: await p, entry: p };
  }

  private evictConnection(
    nodeId: string,
    cached: { connection: IrohConnection; entry: Promise<IrohConnection> },
  ): void {
    if (this.connections.get(nodeId) === cached.entry) {
      this.connections.delete(nodeId);
    }
    try {
      cached.connection.close(0n, new Uint8Array());
    } catch {
      // The failed openBi commonly means the connection is already closed.
    }
  }

  async close(): Promise<void> {
    const all = Array.from(this.connections.values());
    this.connections.clear();
    for (const cp of all) {
      try {
        const c = await cp;
        c.close(0n, new Uint8Array());
      } catch {
        // ignore — already closed or never opened
      }
    }
  }
}
