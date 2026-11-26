import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { basename, isAbsolute, normalize } from 'node:path';
import { CapabilityProtocolError, type ClientToolCall } from './protocol';

type FileAccessRequest = { accountId: string; path: string; directory: boolean };
export type FileAccessPicker = (request: FileAccessRequest, signal: AbortSignal) => Promise<string | null>;

const PERMISSION_WAIT_MS = 60_000;
const TEXT_MAX_BYTES = 25 * 1024 * 1024;
const FILE_MAX_BYTES = 32 * 1024 * 1024;
const DIRECTORY_MAX_ENTRIES = 1000;

export function fileAccessRequest(
  accountId: string, call: ClientToolCall, outcome: unknown,
): FileAccessRequest | undefined {
  const directory = call.tool === 'list_directory';
  if (call.server !== 'filesystem' || !call.session_id ||
      !(directory || call.tool === 'attach_file' || call.tool === 'read_text_file')) return;
  const result = outcome as { isError?: boolean; _meta?: Record<string, unknown> } | null;
  const denial = outcome instanceof CapabilityProtocolError ? outcome
    : result?.isError === true ? result._meta?.['openagent/error'] : undefined;
  const error = denial as { code?: unknown; data?: { path?: unknown } } | undefined;
  const path = error?.data?.path;
  if (error?.code !== 'filesystem_access_denied' ||
      typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return;
  return { accountId, path: normalize(path), directory };
}

/** A user selection is scoped to the single operation receiving it. */
export async function offerFileAccess(
  pick: FileAccessPicker, request: FileAccessRequest, call: ClientToolCall,
  signal: AbortSignal, stillAuthorized: () => boolean,
  { timeoutMs = PERMISSION_WAIT_MS, useApplicationAccess = false } = {},
): Promise<unknown> {
  const { path, directory } = request;
  const attachment = call.tool === 'attach_file';
  const textSelection = call.tool === 'read_text_file' ? selectTextLines(call.args) : undefined;
  const expiry = AbortSignal.timeout(timeoutMs);
  const promptSignal = AbortSignal.any([signal, expiry]);
  const validate = () => {
    if (signal.aborted || !stillAuthorized()) {
      throw new CapabilityProtocolError('cancelled', 'The file access request is no longer active');
    }
    if (expiry.aborted) {
      throw new CapabilityProtocolError('file_permission_timeout', 'The file access request expired');
    }
  };
  validate();
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(expiry.aborted
      ? new CapabilityProtocolError('file_permission_timeout', 'The user did not respond to the file access request in time')
      : new CapabilityProtocolError('cancelled', 'The file access request is no longer active'));
    promptSignal.addEventListener('abort', onAbort, { once: true });
  });
  const read = (permission: 'application_access' | 'granted_once') =>
    readItem(path, directory, attachment, textSelection, permission, promptSignal);
  const approved = async () => {
    if (useApplicationAccess) {
      try {
        // A detached tool broker has its own OS identity. The Desktop app
        // can use any filesystem permission macOS granted directly to it.
        const result = await read('application_access');
        validate();
        return result;
      } catch (error) {
        if (!(error instanceof Error) || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) {
          throw error;
        }
      }
    }
    validate();
    const chosen = await pick(request, promptSignal);
    validate();
    if (chosen === null) {
      throw new CapabilityProtocolError('file_permission_denied', 'The user declined one-time access');
    }
    if (normalize(chosen) !== path) {
      throw new CapabilityProtocolError('file_permission_denied', 'The user did not select the exact requested item');
    }
    // The picker authorizes explicit selection in this process only.
    const result = await read('granted_once');
    validate();
    return result;
  };
  try {
    return await Promise.race([approved(), interrupted]);
  } catch (error) {
    if (error instanceof CapabilityProtocolError) throw error;
    throw new CapabilityProtocolError('file_permission_read_failed', 'The requested item could not be read');
  } finally {
    if (onAbort) promptSignal.removeEventListener('abort', onAbort);
  }
}

function selectTextLines(args: Record<string, unknown>) {
  const end = args.head !== undefined ? 'head' : args.tail !== undefined ? 'tail' : undefined;
  if (!end) return;
  const value = args[end];
  const count = typeof value === 'number' ? Math.trunc(value) :
    typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if ((args.head !== undefined && args.tail !== undefined) || !Number.isInteger(count) ||
      count < 1 || count > 1_000_000) {
    throw new CapabilityProtocolError('invalid_arguments', 'Expected a valid head or tail count');
  }
  return { end, count };
}

async function readItem(
  path: string, directory: boolean, attachment: boolean,
  selection: ReturnType<typeof selectTextLines>, permission: string, signal: AbortSignal,
) {
  const meta = {
    permission,
    'openagent/location': 'client',
    'openagent/pathSemantics': 'client-local',
  };
  if (await fs.realpath(path) !== path) {
    throw new CapabilityProtocolError('file_permission_denied', 'The selected item changed before it could be opened');
  }
  signal.throwIfAborted();
  if (directory) {
    const entries: string[] = [];
    let truncated = false;
    for await (const entry of await fs.opendir(path)) {
      signal.throwIfAborted();
      if (entries.length === DIRECTORY_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(`[${entry.isDirectory() ? 'DIR' : 'FILE'}] ${entry.name}`);
    }
    entries.sort((a, b) => a.slice(a.indexOf(' ') + 1).localeCompare(b.slice(b.indexOf(' ') + 1),
      undefined, { sensitivity: 'base' }));
    return textResult(entries.join('\n'), meta, { path, entries, ...(truncated ? { truncated } : {}) });
  }
  const bytes = await readPickedFile(path, attachment ? FILE_MAX_BYTES : TEXT_MAX_BYTES, signal);
  if (attachment) {
    return {
      content: [{
        type: 'resource',
        resource: { uri: `urn:openagent:file:${randomUUID()}`, blob: bytes.toString('base64') },
        _meta: { 'openagent/file-delivery': { filename: basename(path) } },
      }],
      _meta: meta,
    };
  }
  let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n?/g, '\n');
  if (selection) {
    const lines = text.split(/[\n\v\f\u001c-\u001e\u0085\u2028\u2029]/);
    if (lines.at(-1) === '') lines.pop();
    const { end, count } = selection;
    text = (end === 'head' ? lines.slice(0, count) : lines.slice(-count)).join('\n');
  }
  return textResult(text, { ...meta, path });
}

function textResult(text: string, meta: Record<string, string>, structuredContent?: object) {
  return { content: [{ type: 'text', text }], _meta: meta, ...(structuredContent ? { structuredContent } : {}) };
}

/** Open a user-picked regular file once and bound the read even if it grows. */
export async function readPickedFile(path: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile()) throw new CapabilityProtocolError('invalid_file', 'The selected item is not a regular file');
    if (stat.size > limit) throw new CapabilityProtocolError('file_too_large', `The selected file exceeds ${limit} bytes`);
    const size = Number(stat.size);
    const buffer = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const result = await file.read(buffer, offset, buffer.length - offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (offset !== size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) {
      throw new CapabilityProtocolError('file_changed', 'The selected file changed during the read');
    }
    signal?.throwIfAborted();
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}
