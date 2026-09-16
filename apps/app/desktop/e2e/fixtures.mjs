import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

/**
 * Static-only origin for Electron E2Es whose remote endpoint is the real
 * Gateway over Iroh.  Keeping this separate from DeterministicGateway makes
 * accidental fake HTTP/WebSocket routing impossible: every upgrade and API
 * request against this origin is rejected, while the exported SPA assets are
 * still available to the unpackaged Electron process.
 */
export class StaticRendererServer {
  constructor({ webRoot }) {
    this.webRoot = resolve(webRoot);
    this.server = null;
    this.baseUrl = '';
    this.requests = [];
  }

  async start() {
    if (!existsSync(join(this.webRoot, 'index.html'))) {
      throw new Error(`Universal web export is missing: ${this.webRoot}`);
    }
    this.server = http.createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.server.on('upgrade', (_request, socket) => socket.destroy());
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolvePromise());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Static renderer server did not bind TCP');
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }

  async handleHttp(request, response) {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    this.requests.push({ method: request.method, path: url.pathname });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404).end('real Gateway APIs must use the Iroh loopback');
      return;
    }
    await serveRenderer(this.webRoot, url.pathname, response, request.method === 'HEAD');
  }
}

/**
 * Deterministic Gateway boundary for the Desktop release E2E.
 *
 * Electron main, preload, the exported renderer, capability manager/socket,
 * stand-alone host executable, filesystem/editor/shell modules and their
 * durable broker are all production code and real processes. This fixture
 * replaces only the remote Gateway/Iroh endpoint so the release test has no
 * network, relay or model-provider dependency.
 */
export class DeterministicGateway {
  constructor({ webRoot, accountId, networkId, deviceId, agentNodeId }) {
    this.webRoot = resolve(webRoot);
    this.accountId = accountId;
    this.networkId = networkId;
    this.deviceId = deviceId;
    this.agentNodeId = agentNodeId;
    this.httpRequests = [];
    this.chatFrames = [];
    this.capabilityFrames = [];
    this.capabilityEvents = [];
    this.rejectedCapabilityConnections = 0;
    this.runMessages = [];
    this.capabilitySocket = null;
    this.capabilityHello = null;
    this.acceptCapabilities = true;
    this.pendingResults = new Map();
    this.pendingHello = [];
    this.pendingEvents = [];
    this.server = null;
    this.chatServer = new WebSocketServer({ noServer: true });
    this.capabilityServer = new WebSocketServer({ noServer: true });
    this.baseUrl = '';
  }

  async start() {
    if (!existsSync(join(this.webRoot, 'index.html'))) {
      throw new Error(`Universal web export is missing: ${this.webRoot}`);
    }
    this.server = http.createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      if (pathname === '/ws/capabilities') {
        if (!this.acceptCapabilities) {
          this.rejectedCapabilityConnections += 1;
          socket.destroy();
          return;
        }
        this.capabilityServer.handleUpgrade(request, socket, head, (ws) => {
          this.capabilityServer.emit('connection', ws, request);
        });
        return;
      }
      if (pathname === '/ws') {
        this.chatServer.handleUpgrade(request, socket, head, (ws) => {
          this.chatServer.emit('connection', ws, request);
        });
        return;
      }
      socket.destroy();
    });
    this.chatServer.on('connection', (socket) => this.handleChatSocket(socket));
    this.capabilityServer.on('connection', (socket) => this.handleCapabilitySocket(socket));
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolvePromise());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Gateway did not bind TCP');
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  loopbackConfig() {
    return {
      account_id: this.accountId,
      base_url: this.baseUrl,
      network_name: 'desktop-e2e',
      network_id: this.networkId,
      device_id: this.deviceId,
      handle: 'e2e-user',
      coordinator_node_id: 'coordinator-node-e2e',
      agent_node_id: this.agentNodeId,
      agent_handle: 'e2e-agent',
    };
  }

  async waitForCapabilityHello(timeoutMs = 15_000) {
    if (this.capabilityHello) return this.capabilityHello;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pendingHello = this.pendingHello.filter((entry) => entry.resolve !== resolvePromise);
        reject(new Error('Timed out waiting for capability_hello'));
      }, timeoutMs);
      this.pendingHello.push({
        resolve: (hello) => {
          clearTimeout(timer);
          resolvePromise(hello);
        },
      });
    });
  }

  async call(server, tool, args, options = {}) {
    const socket = this.capabilitySocket;
    const hello = this.capabilityHello;
    if (!socket || socket.readyState !== WebSocket.OPEN || !hello) {
      throw new Error(`No registered client capability host for ${server}.${tool}`);
    }
    const callId = options.callId || `e2e-${randomUUID()}`;
    const argumentsSha256 = canonicalArgumentsSha256(args);
    const frame = {
      type: 'client_tool_call',
      call_id: callId,
      generation: hello.generation,
      server,
      tool,
      args,
      deadline_ms: Date.now() + (options.timeoutMs || 30_000),
      session_id: 'e2e-session',
      account_id: this.networkId,
      idempotency_key: options.idempotencyKey || callId,
      arguments_sha256: argumentsSha256,
    };
    const result = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(callId);
        reject(new Error(`Timed out waiting for ${server}.${tool} (${callId})`));
      }, (options.timeoutMs || 30_000) + 5_000);
      this.pendingResults.set(callId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    socket.send(JSON.stringify(frame));
    const value = await result;
    return { callId, argumentsSha256, ...value };
  }

  async waitForEvent(predicate, timeoutMs = 15_000) {
    const existing = this.capabilityEvents.find(predicate);
    if (existing) return existing;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pendingEvents = this.pendingEvents.filter((entry) => entry.resolve !== resolvePromise);
        reject(new Error('Timed out waiting for client_tool_event'));
      }, timeoutMs);
      this.pendingEvents.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolvePromise(event);
        },
      });
    });
  }

  setRunMessages(messages) {
    this.runMessages = messages;
  }

  sendChatFrame(frame) {
    const payload = JSON.stringify(frame);
    for (const socket of this.chatServer.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  disconnectCapabilities() {
    this.acceptCapabilities = false;
    const socket = this.capabilitySocket;
    this.capabilitySocket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.terminate();
  }

  async close() {
    this.acceptCapabilities = false;
    for (const socket of this.chatServer.clients) socket.terminate();
    for (const socket of this.capabilityServer.clients) socket.terminate();
    for (const pending of this.pendingResults.values()) {
      pending.reject(new Error('Gateway fixture closed'));
    }
    this.pendingResults.clear();
    await Promise.all([
      closeWebSocketServer(this.chatServer),
      closeWebSocketServer(this.capabilityServer),
    ]);
    if (this.server) {
      await new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
      this.server = null;
    }
  }

  handleChatSocket(socket) {
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      this.chatFrames.push(frame);
      if (frame.type === 'auth') {
        socket.send(JSON.stringify({
          type: 'auth_ok',
          agent_name: 'Deterministic E2E Agent',
          version: 'e2e',
          network: 'desktop-e2e',
          handle: 'e2e-user',
        }));
      }
    });
  }

  handleCapabilitySocket(socket) {
    this.capabilitySocket = socket;
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      this.capabilityFrames.push(frame);
      if (frame.type === 'capability_hello') {
        this.capabilityHello = frame;
        socket.send(JSON.stringify({
          type: 'capability_hello_ack',
          protocol: 'client-capabilities/1',
          device_id: this.deviceId,
          account_id: this.networkId,
          client_instance_id: frame.client_instance_id,
          generation: frame.generation,
          accepted: true,
        }));
        for (const waiter of this.pendingHello.splice(0)) waiter.resolve(frame);
        return;
      }
      if (frame.type === 'capability_heartbeat') {
        socket.send(JSON.stringify({
          type: 'capability_heartbeat_ack',
          generation: frame.generation,
          ts_ms: frame.ts_ms,
        }));
        return;
      }
      if (frame.type === 'client_tool_result') {
        const pending = this.pendingResults.get(frame.call_id);
        if (!pending) return;
        this.pendingResults.delete(frame.call_id);
        if (frame.error) {
          const error = new Error(`${frame.error.code}: ${frame.error.message}`);
          error.frame = frame;
          pending.reject(error);
        } else {
          pending.resolve({ frame, result: frame.result });
        }
        return;
      }
      if (frame.type === 'client_tool_event') {
        const event = frame.event || {};
        this.capabilityEvents.push(event);
        if (event.type === 'shell_completed' && event.shell_id) {
          socket.send(JSON.stringify({
            type: 'client_tool_event_ack',
            generation: frame.generation,
            shell_id: event.shell_id,
            accepted: true,
          }));
        }
        const keep = [];
        for (const waiter of this.pendingEvents) {
          if (waiter.predicate(event)) waiter.resolve(event);
          else keep.push(waiter);
        }
        this.pendingEvents = keep;
      }
    });
    socket.on('close', () => {
      if (this.capabilitySocket === socket) this.capabilitySocket = null;
    });
  }

  async handleHttp(request, response) {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    this.httpRequests.push({ method: request.method, path: url.pathname });
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/api/health') {
      sendJson(response, { ok: true, fixture: 'deterministic-gateway' });
      return;
    }
    if (url.pathname === '/api/capabilities') {
      // This fixture deliberately exercises the released-client/legacy-server
      // compatibility path.  An older Gateway has no unified-history
      // capability route and answers 404; returning an invalid successful `{}`
      // response would violate the wire contract and crash discovery before
      // the legacy `/api/sessions` fallback can run.
      sendJson(response, { error: 'unsupported by deterministic legacy fixture' }, 404);
      return;
    }
    if (url.pathname === '/api/sessions') {
      sendJson(response, {
        sessions: [{
          session_id: 'e2e-session',
          client_id: 'desktop-e2e',
          title: 'Local capability E2E',
          model: 'deterministic:e2e',
          framework: 'fixture',
          created_at: 1_700_000_000,
          last_active_at: 1_700_000_100,
          origin: 'chat',
          kind: 'chat',
          _live: false,
        }],
      });
      return;
    }
    if (url.pathname === '/api/sessions/e2e-session/runs') {
      sendJson(response, { session_id: 'e2e-session', messages: this.runMessages });
      return;
    }
    if (url.pathname === '/api/sessions/e2e-session/context') {
      sendJson(response, {
        session_id: 'e2e-session',
        model: 'deterministic:e2e',
        context_window: 8_192,
        used_tokens: 0,
        free_tokens: 8_192,
        used_pct: 0,
        sections: [{ key: 'free', label: 'Free', tokens: 8_192, pct: 100 }],
      });
      return;
    }
    if (url.pathname === '/api/config') {
      sendJson(response, {
        name: 'Deterministic E2E Agent',
        system_prompt: '',
        channels: {},
        dream_mode: { enabled: false, time: '3:00' },
        auto_update: { enabled: false, mode: 'manual', check_interval: '' },
      });
      return;
    }
    if (url.pathname === '/api/models') {
      sendJson(response, { models: [] });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      // Sidebar/activity/config calls are not under test. Returning an empty
      // object keeps this deterministic boundary explicit without masking a
      // request to the session endpoints asserted above.
      sendJson(response, {});
      return;
    }
    await this.serveRenderer(url.pathname, response);
  }

  async serveRenderer(pathname, response) {
    await serveRenderer(this.webRoot, pathname, response, false);
  }
}

async function serveRenderer(webRoot, pathname, response, headOnly) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { decoded = '/'; }
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  let candidate = resolve(webRoot, relative || 'index.html');
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    if (!(await stat(candidate)).isFile()) throw new Error('not a file');
  } catch {
    candidate = join(webRoot, 'index.html');
  }
  const body = await readFile(candidate);
  response.setHeader('Content-Type', CONTENT_TYPES.get(extname(candidate)) || 'application/octet-stream');
  response.setHeader('Cache-Control', 'no-store');
  response.writeHead(200).end(headOnly ? undefined : body);
}

export function canonicalArgumentsSha256(value) {
  const canonical = JSON.stringify(sortJson(value));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function resolveHostToolsBinary(desktopRoot) {
  const executable = process.platform === 'win32'
    ? 'openagent-host-tools.exe'
    : 'openagent-host-tools';
  const override = process.env.OPENAGENT_E2E_HOST_TOOLS_BIN?.trim();
  const repo = resolve(desktopRoot, '..', '..', 'openagent-host-tools');
  const candidates = [
    override,
    join(repo, 'dist', `${process.platform}-${process.arch}`, executable),
    process.platform === 'win32'
      ? join(repo, '.venv', 'Scripts', executable)
      : join(repo, '.venv', 'bin', executable),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No real host-tools executable found. Build openagent-host-tools or set ` +
      `OPENAGENT_E2E_HOST_TOOLS_BIN. Checked: ${candidates.join(', ')}`,
    );
  }
  return found;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function sendJson(response, value, status = 200) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.writeHead(status).end(JSON.stringify(value));
}

function closeWebSocketServer(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}
