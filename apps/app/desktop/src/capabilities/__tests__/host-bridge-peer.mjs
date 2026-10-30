import fs from 'node:fs';
import readline from 'node:readline';

const journal = process.env.OPENAGENT_TEST_BRIDGE_JOURNAL;
if (process.env.OPENAGENT_TEST_BRIDGE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
const record = (value) => {
  if (journal) fs.appendFileSync(journal, `${JSON.stringify({ ...value, pid: process.pid })}\n`);
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  record({ type: request.type, callId: request.call_id });
  const respond = (result) => process.stdout.write(`${JSON.stringify({
    id: request.id, type: 'response', ok: true, result,
  })}\n`);
  if (request.type === 'initialize') {
    if (process.env.OPENAGENT_TEST_BRIDGE_REJECT_INITIALIZE === '1') {
      process.stdout.write(`${JSON.stringify({
        id: request.id, type: 'response', ok: false,
        error: { code: 'initialize_rejected', message: 'test handshake failed' },
      })}\n`);
    } else {
      setTimeout(() => respond({ pid: process.pid }), 20);
    }
  } else if (request.type === 'provider_control') {
    if (!request.args.hold) respond({ request });
  } else if (request.type === 'call') {
    if (request.args.invalidFrame !== undefined) {
      const raw = request.args.invalidFrame === 'non-json'
        ? 'invalid-json'
        : JSON.stringify(request.args.invalidFrame === 'invalid-ok'
          ? { id: request.id, type: 'response', ok: 'true', result: 'must not succeed' }
          : request.args.invalidFrame);
      process.stdout.write(`${raw}\n`);
    } else if (request.args.hold) {
      // Keep the request outstanding until cancellation or the peer is stopped.
    } else {
      respond({ pid: process.pid });
    }
  } else if (request.type === 'cancel') {
    respond({ cancelled: true });
  } else if (request.type === 'shutdown') {
    respond({ shutdown: true });
    setImmediate(() => process.exit(0));
  } else {
    respond({ pid: process.pid });
  }
});
