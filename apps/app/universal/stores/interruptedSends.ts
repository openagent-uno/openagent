import { attachmentsForSend } from '../../common/attachments';
import { unconfirmedMessages } from '../../common/shared-transcript';
import type { ChatMessage, ChatSession } from '../../common/types';

// Keep only the user's interrupted input. The browser tab survives a reload;
// native runtimes, or browsers without session storage, keep it in memory.
type Entry = { sessionId: string; message: ChatMessage };
const memory = new Map<string, Entry[]>();
let account: string | null = null;
export function setOutboxAccount(id: string | null) { account = id; }
const key = (id: string) => 'oa.interrupted-turns.v1.' + id;

function entries(id: string): Entry[] {
  if (memory.has(id)) return memory.get(id)!;
  let rows: Entry[] = [];
  try {
    const saved = JSON.parse(globalThis.sessionStorage?.getItem(key(id)) ?? '[]');
    if (Array.isArray(saved)) rows = saved.flatMap(entry => {
      const message = entry?.message;
      if (typeof entry?.sessionId !== 'string' || typeof message?.id !== 'string' || !message.id
          || message.id !== message.providerRunId || message.role !== 'user' || typeof message.text !== 'string'
          || !Number.isFinite(message.timestamp) || !['failed', 'unconfirmed'].includes(message.delivery)) return [];
      return [{ sessionId: entry.sessionId, message: envelope(message) }];
    });
  } catch { /* Storage can be unavailable in a native or private window. */ }
  memory.set(id, rows);
  return rows;
}

function write(id: string, rows: Entry[]) {
  memory.set(id, rows);
  try {
    if (rows.length) globalThis.sessionStorage?.setItem(key(id), JSON.stringify(rows));
    else globalThis.sessionStorage?.removeItem(key(id));
  } catch { /* Keep this renderer's in-memory copy when storage is unavailable. */ }
}

export function clearInterruptedAccount(id: string) { write(id, []); }

export function forgetInterrupted(sessionId: string, requestId?: string, owner = account) {
  if (!owner) return;
  const rows = entries(owner);
  const remaining = rows.filter(row => row.sessionId !== sessionId || (requestId && row.message.id !== requestId));
  if (remaining.length !== rows.length) write(owner, remaining);
}

function envelope(row: ChatMessage): ChatMessage {
  const { id, text, timestamp, delivery, deliveryError, retryable } = row;
  return { id, providerRunId: id, role: 'user', text, timestamp, attachments: attachmentsForSend(row.attachments),
    delivery, deliveryError: typeof deliveryError === 'string' ? deliveryError : undefined,
    retryable: delivery === 'failed' && retryable === true };
}

export function rememberInterrupted(sessionId: string, row: ChatMessage) {
  if (!account) return;
  write(account, [...entries(account).filter(entry => entry.sessionId !== sessionId || entry.message.id !== row.id),
    { sessionId, message: envelope(row) }]);
}

/** Called only after an authorized transcript read or shared snapshot. */
export function reconcileInterrupted(session: ChatSession, messages: ChatMessage[], snapshot = session.sharedSnapshot) {
  const stored = account ? entries(account).filter(row => row.sessionId === session.id) : [];
  const live = session.outbound;
  if (!stored.length) return unconfirmedMessages(live, messages, snapshot);
  const restored = stored.map(row => row.message).filter(row => !live?.some(item => item.id === row.id));
  const remaining = unconfirmedMessages([...(live ?? []), ...restored], messages, snapshot);
  for (const { message } of stored) {
    if (!remaining?.some(row => row.id === message.id)) forgetInterrupted(session.id, message.id);
  }
  return remaining;
}
