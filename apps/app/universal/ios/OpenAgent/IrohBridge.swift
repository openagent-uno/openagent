import Foundation
import Network

// MARK: - Hex helpers

private func dataToHex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

private func hexToData(_ hex: String) throws -> Data {
  let hex = hex.lowercased()
  guard hex.count % 2 == 0 else {
    throw NSError(domain: "IrohBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "Odd hex length"])
  }
  var data = Data(capacity: hex.count / 2)
  var idx = hex.startIndex
  for _ in 0..<hex.count / 2 {
    let next = hex.index(idx, offsetBy: 2)
    guard let byte = UInt8(hex[idx..<next], radix: 16) else {
      throw NSError(domain: "IrohBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid hex"])
    }
    data.append(byte)
    idx = next
  }
  return data
}

private func publicKeyFromHex(_ hex: String) throws -> PublicKey {
  return try PublicKey.fromBytes(bytes: hexToData(hex))
}

// MARK: - Endpoint wrapper
//
// Pinned to iroh-ffi 0.35, the same iroh wire protocol as the OpenAgent
// server, CLI and desktop (iroh 0.35). iroh >= 0.90 cannot handshake with
// those peers, so do not bump this independently of the server.

class IrohEndpoint {
  private let node: Iroh
  private let endpoint: Endpoint
  private let _nodeIdHex: String

  init(secretKey: Data) async throws {
    let opts = NodeOptions(secretKey: secretKey)
    self.node = try await Iroh.memoryWithOptions(options: opts)
    self.endpoint = node.node().endpoint()
    let display = try endpoint.nodeId()
    self._nodeIdHex = dataToHex(try PublicKey.fromString(s: display).toBytes())
  }

  func nodeId() -> String { _nodeIdHex }

  func connect(nodeId: String, alpn: Data, relayUrl: String? = nil, addresses: [String] = []) async throws -> IrohConnection {
    let peer = try publicKeyFromHex(nodeId)
    let addr = NodeAddr(nodeId: peer, derpUrl: relayUrl, addresses: addresses)
    let conn = try await endpoint.connect(nodeAddr: addr, alpn: alpn)
    return IrohConnection(connection: conn)
  }

  func shutdown() async {
    do {
      try await node.node().shutdown()
    } catch {
      // ignore — may already be shut down
    }
  }
}

// MARK: - Connection wrapper

class IrohConnection {
  private let connection: Connection

  init(connection: Connection) {
    self.connection = connection
  }

  func openBi() async throws -> IrohBiStream {
    let bi = try await connection.openBi()
    return IrohBiStream(
      send: IrohSendStream(stream: bi.send()),
      recv: IrohRecvStream(stream: bi.recv())
    )
  }

  func close(errorCode: Int64, reason: Data) {
    do {
      try connection.close(errorCode: UInt64(clamping: errorCode), reason: reason)
    } catch {
      // ignore
    }
  }
}

// MARK: - Streams

class IrohSendStream {
  private let stream: SendStream

  init(stream: SendStream) {
    self.stream = stream
  }

  func writeAll(_ data: Data) async throws {
    try await stream.writeAll(buf: data)
  }

  func finish() async throws {
    try await stream.finish()
  }
}

class IrohRecvStream {
  private let stream: RecvStream

  init(stream: RecvStream) {
    self.stream = stream
  }

  func read(maxBytes: Int) async throws -> Data? {
    let chunk = try await stream.read(sizeLimit: UInt32(clamping: maxBytes))
    if chunk.isEmpty { return nil }
    return chunk
  }
}

class IrohBiStream {
  let send: IrohSendStream
  let recv: IrohRecvStream

  init(send: IrohSendStream, recv: IrohRecvStream) {
    self.send = send
    self.recv = recv
  }
}

// MARK: - Loopback Proxy

/// Localhost TCP proxy bridging each accepted socket to a cert-prefixed
/// iroh gateway bi-stream — same pattern as the desktop ``LoopbackProxy``.
class LoopbackProxy {
  private let endpoint: IrohEndpoint
  private let agentNodeId: String
  private let certWire: Data
  private let relayUrl: String?
  private let addresses: [String]
  private var listener: NWListener?
  private(set) var port: Int = 0

  init(
    endpoint: IrohEndpoint,
    agentNodeId: String,
    certWire: Data,
    relayUrl: String?,
    addresses: [String]
  ) {
    self.endpoint = endpoint
    self.agentNodeId = agentNodeId
    self.certWire = certWire
    self.relayUrl = relayUrl
    self.addresses = addresses
  }

  func start() throws -> Int {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(
      host: .ipv4(.loopback),
      port: .any
    )
    let nwListener = try NWListener(using: params)

    let semaphore = DispatchSemaphore(value: 0)
    var startError: Error?
    var assignedPort: Int = 0

    nwListener.stateUpdateHandler = { state in
      switch state {
      case .ready:
        if let p = nwListener.port {
          assignedPort = Int(p.rawValue)
        }
        semaphore.signal()
      case .failed(let error):
        startError = error
        semaphore.signal()
      default:
        break
      }
    }

    nwListener.newConnectionHandler = { [weak self] nwConn in
      self?.handleConnection(nwConn)
    }

    nwListener.start(queue: DispatchQueue(label: "ai.openagent.proxy"))
    semaphore.wait()

    if let error = startError {
      throw error
    }

    self.listener = nwListener
    self.port = assignedPort
    return assignedPort
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  private func handleConnection(_ nwConn: NWConnection) {
    nwConn.start(queue: DispatchQueue(label: "ai.openagent.proxy.conn"))

    Task {
      do {
        let irohConn = try await endpoint.connect(
          nodeId: agentNodeId,
          alpn: Data("openagent/gateway/1".utf8),
          relayUrl: relayUrl,
          addresses: addresses
        )
        let stream = try await irohConn.openBi()

        // Cert prefix: u32(BE) cert_len || cert_wire
        var certLen = UInt32(certWire.count).bigEndian
        var prefix = Data(bytes: &certLen, count: 4)
        prefix.append(certWire)
        try await stream.send.writeAll(prefix)

        // Pump: local → iroh
        pumpLocalToIroh(nwConn: nwConn, send: stream.send)
        // Pump: iroh → local
        pumpIrohToLocal(nwConn: nwConn, recv: stream.recv)
      } catch {
        nwConn.cancel()
      }
    }
  }

  private func pumpLocalToIroh(nwConn: NWConnection, send: IrohSendStream) {
    func readNext() {
      nwConn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
        if let data = data, !data.isEmpty {
          Task {
            do {
              try await send.writeAll(data)
            } catch {
              nwConn.cancel()
              return
            }
            if isComplete || error != nil {
              try? await send.finish()
            } else {
              readNext()
            }
          }
          return
        }
        if isComplete || error != nil {
          Task { try? await send.finish() }
          return
        }
        readNext()
      }
    }
    readNext()
  }

  private func pumpIrohToLocal(nwConn: NWConnection, recv: IrohRecvStream) {
    Task {
      while true {
        do {
          guard let data = try await recv.read(maxBytes: 65536) else {
            nwConn.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
            break
          }
          await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            nwConn.send(content: data, completion: .contentProcessed { _ in
              cont.resume()
            })
          }
        } catch {
          nwConn.cancel()
          break
        }
      }
    }
  }
}
