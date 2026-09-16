import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const EXPECTED_SECRET = 'desktop-e2e-plugin-secret-never-on-gateway';

const input = readline.createInterface({ input: process.stdin });

input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  if (request.id == null) return;

  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'e2e-local-plugin', version: '1.0.0' },
      instructions: 'Deterministic local-only plugin used by the Desktop release E2E.',
    });
    return;
  }

  if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [{
        name: 'local_probe',
        description: 'Proves that an explicitly configured MCP executes on the client.',
        inputSchema: {
          type: 'object',
          properties: { marker: { type: 'string' } },
          required: ['marker'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      }],
    });
    return;
  }

  if (request.method === 'tools/call' && request.params?.name === 'local_probe') {
    const envVerified = process.env.OPENAGENT_E2E_PLUGIN_SECRET === EXPECTED_SECRET;
    const markerPath = process.env.OPENAGENT_E2E_PLUGIN_MARKER;
    if (markerPath) {
      appendFileSync(markerPath, `${JSON.stringify({
        envVerified,
        arguments: request.params.arguments,
        pid: process.pid,
      })}\n`, 'utf8');
    }
    respond(request.id, {
      content: [{ type: 'text', text: envVerified ? 'local-plugin-ok' : 'local-plugin-env-missing' }],
      structuredContent: { local: true, env_verified: envVerified },
      isError: !envVerified,
    });
    return;
  }

  respondError(request.id, -32601, `Unsupported method: ${String(request.method)}`);
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })}\n`);
}
