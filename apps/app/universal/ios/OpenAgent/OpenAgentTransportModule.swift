import Foundation
import React

@objc(OpenAgentTransport)
class OpenAgentTransportModule: NSObject {

  // MARK: - State

  private var endpoint: IrohEndpoint?
  private var nodeIdHex: String?
  private var connections: [String: IrohConnection] = [:]
  private var streams: [String: IrohBiStream] = [:]
  private var proxies: [String: LoopbackProxy] = [:]
  private let queue = DispatchQueue(label: "ai.openagent.transport", qos: .userInitiated)

  // MARK: - Endpoint lifecycle

  @objc func createEndpoint(
    _ secretKeyHex: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      do {
        let secretBytes = try Self.hexToData(secretKeyHex)
        guard secretBytes.count == 32 else {
          reject("INVALID_KEY", "Secret key must be 32 bytes", nil)
          return
        }
        let ep = try await IrohEndpoint(secretKey: secretBytes)
        self.queue.sync {
          self.endpoint = ep
          self.nodeIdHex = ep.nodeId()
        }
        resolve(["nodeIdHex": ep.nodeId()])
      } catch {
        reject("ENDPOINT_ERROR", "Failed to create iroh endpoint: \(error.localizedDescription)", error)
      }
    }
  }

  @objc func addPeerAddr(
    _ nodeIdHex: String,
    relayUrl: String?,
    addresses: [String],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(nil)
  }

  // MARK: - Connection

  @objc func connect(
    _ nodeIdHex: String,
    alpnHex: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      guard let ep = self.queue.sync(execute: { self.endpoint }) else {
        reject("NO_ENDPOINT", "Endpoint not created", nil)
        return
      }
      do {
        let alpnBytes = try Self.hexToData(alpnHex)
        let conn = try await ep.connect(nodeId: nodeIdHex, alpn: alpnBytes)
        let connId = UUID().uuidString
        self.queue.sync { self.connections[connId] = conn }
        resolve(["connectionId": connId])
      } catch {
        reject("CONNECT_ERROR", "iroh connect failed: \(error.localizedDescription)", error)
      }
    }
  }

  @objc func openBi(
    _ connectionId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      guard let conn = self.queue.sync(execute: { self.connections[connectionId] }) else {
        reject("NO_CONNECTION", "Connection not found: \(connectionId)", nil)
        return
      }
      do {
        let stream = try await conn.openBi()
        let streamId = UUID().uuidString
        self.queue.sync { self.streams[streamId] = stream }
        resolve(["streamId": streamId])
      } catch {
        reject("STREAM_ERROR", "openBi failed: \(error.localizedDescription)", error)
      }
    }
  }

  @objc func streamWrite(
    _ streamId: String,
    dataBase64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      guard let stream = self.queue.sync(execute: { self.streams[streamId] }) else {
        reject("NO_STREAM", "Stream not found: \(streamId)", nil)
        return
      }
      guard let data = Data(base64Encoded: dataBase64) else {
        reject("INVALID_DATA", "Invalid base64 data", nil)
        return
      }
      do {
        try await stream.send.writeAll(data)
        resolve(nil)
      } catch {
        reject("WRITE_ERROR", "Stream write failed: \(error.localizedDescription)", error)
      }
    }
  }

  @objc func streamRead(
    _ streamId: String,
    maxBytes: Int,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      guard let stream = self.queue.sync(execute: { self.streams[streamId] }) else {
        reject("NO_STREAM", "Stream not found: \(streamId)", nil)
        return
      }
      do {
        let data = try await stream.recv.read(maxBytes: maxBytes)
        if let data = data {
          resolve(["dataBase64": data.base64EncodedString()])
        } else {
          resolve(["dataBase64": NSNull()])
        }
      } catch {
        reject("READ_ERROR", "Stream read failed: \(error.localizedDescription)", error)
      }
    }
  }

  @objc func streamFinish(
    _ streamId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      guard let stream = self.queue.sync(execute: { self.streams[streamId] }) else {
        reject("NO_STREAM", "Stream not found: \(streamId)", nil)
        return
      }
      do {
        try await stream.send.finish()
        resolve(nil)
      } catch {
        reject("FINISH_ERROR", "Stream finish failed: \(error.localizedDescription)", error)
      }
    }
  }

  @objc func closeConnection(
    _ connectionId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.sync {
      if let conn = connections.removeValue(forKey: connectionId) {
        conn.close(errorCode: Int64(0), reason: Data())
      }
    }
    resolve(nil)
  }

  // MARK: - Loopback proxy

  @objc func startProxy(
    _ agentNodeIdHex: String,
    certWireBase64: String,
    relayUrl: String?,
    addresses: [String],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self = self, let ep = self.endpoint else {
        reject("NO_ENDPOINT", "Endpoint not created", nil)
        return
      }
      guard let certWire = Data(base64Encoded: certWireBase64) else {
        reject("INVALID_CERT", "Invalid base64 cert wire", nil)
        return
      }
      do {
        let proxy = LoopbackProxy(
          endpoint: ep,
          agentNodeId: agentNodeIdHex,
          certWire: certWire,
          relayUrl: relayUrl,
          addresses: addresses
        )
        let port = try proxy.start()
        self.proxies[agentNodeIdHex] = proxy
        resolve(["port": port])
      } catch {
        reject("PROXY_ERROR", "Failed to start proxy: \(error.localizedDescription)", error)
      }
    }
  }

  @objc func stopProxy(
    _ accountId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      self?.proxies.values.forEach { $0.stop() }
      self?.proxies.removeAll()
      resolve(nil)
    }
  }

  @objc func getProxyPort(
    _ accountId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      if let proxy = self?.proxies.values.first {
        resolve(["port": proxy.port])
      } else {
        resolve(["port": NSNull()])
      }
    }
  }

  @objc func shutdown(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      self.queue.sync {
        self.proxies.values.forEach { $0.stop() }
        self.proxies.removeAll()
        self.streams.removeAll()
        self.connections.values.forEach { $0.close(errorCode: Int64(0), reason: Data()) }
        self.connections.removeAll()
      }
      await self.queue.sync(execute: { self.endpoint })?.shutdown()
      self.queue.sync { self.endpoint = nil }
      resolve(nil)
    }
  }

  // MARK: - Utilities

  private static func hexToData(_ hex: String) throws -> Data {
    let hex = hex.lowercased()
    guard hex.count % 2 == 0 else {
      throw NSError(domain: "OpenAgentTransport", code: 1, userInfo: [NSLocalizedDescriptionKey: "Odd hex length"])
    }
    var data = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    for _ in 0..<hex.count / 2 {
      let nextIndex = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<nextIndex], radix: 16) else {
        throw NSError(domain: "OpenAgentTransport", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid hex"])
      }
      data.append(byte)
      index = nextIndex
    }
    return data
  }

  // MARK: - React Native module config

  @objc static func requiresMainQueueSetup() -> Bool { false }
}
