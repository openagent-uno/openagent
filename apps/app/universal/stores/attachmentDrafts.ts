import { create } from 'zustand';
import type { PendingFile } from '../components/MessageComposer';

const emptyFiles: PendingFile[] = [];
const useDrafts = create(() => new Map<string, PendingFile[]>());
let nextFile = 0;

export function newPendingFileId() {
  return `pf-${++nextFile}`;
}

export function attachmentDraftKey(accountId: string | null, sessionId: string | null) {
  return JSON.stringify([accountId, sessionId]);
}

export function useDraftFiles(key: string) {
  return useDrafts(drafts => drafts.get(key) ?? emptyFiles);
}

export function discardDraftFiles(accountId: string | null, sessionId?: string) {
  if (sessionId !== undefined) {
    updateDraftFiles(attachmentDraftKey(accountId, sessionId), () => []);
    return;
  }
  for (const key of useDrafts.getState().keys()) {
    if (JSON.parse(key)[0] === accountId) updateDraftFiles(key, () => []);
  }
}

export function updateDraftFiles(key: string, update: (files: PendingFile[]) => PendingFile[]) {
  useDrafts.setState(previous => {
    const files = previous.get(key) ?? emptyFiles;
    const next = update(files);
    if (next === files || (!next.length && !files.length)) return previous;
    const map = new Map(previous);
    if (next.length) map.set(key, next);
    else map.delete(key);
    const retained = new Set(next.map(file => file.id));
    for (const file of files) {
      if (!retained.has(file.id)) {
        file.abort?.();
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      }
    }
    return map;
  }, true);
}
