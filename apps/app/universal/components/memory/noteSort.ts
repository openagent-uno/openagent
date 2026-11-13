/** Pure note-ordering helpers for the native Memory list (Node-testable). */
import type { VaultNote } from '../../../common/types';

/** ``modified`` is typed as a string, but servers send ISO strings or epoch
 *  numbers (seconds or milliseconds); normalise to milliseconds. */
export function modifiedMillis(modified: unknown): number {
  if (typeof modified === 'number' && Number.isFinite(modified)) {
    return modified < 1e12 ? modified * 1000 : modified;
  }
  if (typeof modified === 'string') {
    const n = Number(modified);
    if (modified.trim() !== '' && Number.isFinite(n)) return modifiedMillis(n);
    const t = Date.parse(modified);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

export function sortNotesByModified(notes: VaultNote[]): VaultNote[] {
  return [...notes].sort((a, b) => modifiedMillis(b.modified) - modifiedMillis(a.modified));
}
