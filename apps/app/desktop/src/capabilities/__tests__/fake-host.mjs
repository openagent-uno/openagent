import readline from 'node:readline';
import fs from 'node:fs';

let enabled = process.env.OPENAGENT_FAKE_ENABLED === '1';
const sharedConsentPath = process.env.OPENAGENT_FAKE_CONSENT_PATH;
const failDisableOncePath = process.env.OPENAGENT_FAKE_FAIL_DISABLE_ONCE_PATH;
const exitOnCallOncePath = process.env.OPENAGENT_FAKE_EXIT_ON_CALL_ONCE_PATH;
const lifecyclePath = process.env.OPENAGENT_FAKE_LIFECYCLE_PATH;
const disableDelayMs = Number(process.env.OPENAGENT_FAKE_DISABLE_DELAY_MS || 0);

function lifecycle(event) {
  if (lifecyclePath) fs.appendFileSync(lifecyclePath, `${event}:${process.pid}\n`);
}

lifecycle('start');

function refreshSharedConsent() {
  if (!sharedConsentPath) return;
  try {
    enabled = fs.readFileSync(sharedConsentPath, 'utf8').trim() === '1';
  } catch {
    // Tests may atomically replace the file; retain the last canonical value
    // until the next status poll instead of inventing a grant.
  }
}
const servers = [{
  name: 'filesystem',
  version: 'test',
  instructions: 'fake filesystem',
  tools: [{ name: 'echo', description: 'echo', input_schema: { type: 'object' }, classification: 'read_only' }],
}];

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  const response = (result) => process.stdout.write(JSON.stringify({
    id: request.id, type: 'response', ok: true, result,
  }) + '\n');
  if (request.type === 'initialize' || request.type === 'status') {
    if (request.type === 'initialize') lifecycle('initialize');
    refreshSharedConsent();
    response({ consent: { enabled, version: 1, updated_at: 1 }, inventory: [] });
    if (request.type === 'initialize' && process.env.OPENAGENT_FAKE_REPLAY_PRINCIPAL) {
      const principal = process.env.OPENAGENT_FAKE_REPLAY_PRINCIPAL;
      setTimeout(() => process.stdout.write(JSON.stringify({
        type: 'event',
        event: {
          type: 'shell_completed', server: 'shell', shell_id: 'replayed-before-loopback',
          status: 'exited', exit_code: 0, principal,
        },
      }) + '\n'), 20);
    }
  } else if (request.type === 'set_consent') {
    if (!request.enabled && failDisableOncePath && fs.existsSync(failDisableOncePath)) {
      process.stdout.write(JSON.stringify({
        id: request.id, type: 'response', ok: false,
        error: { code: 'simulated_transport_failure', message: 'simulated emergency persistence failure' },
      }) + '\n');
      return;
    }
    const persist = () => {
      enabled = request.enabled;
      lifecycle(request.enabled ? 'enable' : 'disable');
      response({ consent: { enabled, version: 1, updated_at: 2 } });
    };
    if (!request.enabled && disableDelayMs > 0) setTimeout(persist, disableDelayMs);
    else persist();
  } else if (request.type === 'catalog') {
    refreshSharedConsent();
    response({ servers: enabled ? servers : [] });
  } else if (request.type === 'call') {
    refreshSharedConsent();
    if (exitOnCallOncePath && fs.existsSync(exitOnCallOncePath)) {
      fs.unlinkSync(exitOnCallOncePath);
      process.exit(70);
    }
    if (!enabled) {
      process.stdout.write(JSON.stringify({
        id: request.id, type: 'response', ok: false,
        error: { code: 'consent_required', message: 'disabled' },
      }) + '\n');
    } else {
      response({
        content: [{ type: 'text', text: String(request.args?.value ?? '') }],
        isError: false,
        _meta: { principal: request.principal },
      });
      if (request.args?.emit_event) {
        process.stdout.write(JSON.stringify({
          type: 'event',
          event: {
            type: 'shell_completed',
            server: 'shell',
            shell_id: 'desktop-background-shell',
            status: 'exited',
            exit_code: 0,
            principal: JSON.stringify(request.principal),
          },
        }) + '\n');
      }
    }
  } else if (request.type === 'cancel') {
    response({ cancelled: request.call_id });
  } else if (request.type === 'release_principal') {
    lifecycle('release');
    response({ released: request.principal });
  } else if (request.type === 'shutdown') {
    lifecycle('shutdown');
    response({ shutdown: true });
    setImmediate(() => process.exit(0));
  }
});
