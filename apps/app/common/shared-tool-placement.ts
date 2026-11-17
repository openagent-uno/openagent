import type { ChatMessage } from './types';
import { placeSharedTools } from './shared-transcript';

/** Per-account/session render projection. Chat stores preserve the identity of
 * immutable prefix rows. Only an append to the unplaced streaming assistant
 * tail can reuse that prefix; all other changes use the original full pass.
 * Snapshots of the tail's scalar/shallow properties also handle an in-place
 * tail update without mistaking an edit or metadata change for an append.
 */
export function createSharedToolPlacement() {
  let previous: ChatMessage[] = [];
  let projection: readonly ChatMessage[] = [];
  let tailSnapshot: ChatMessage | undefined;
  let plain = true;
  let tailHasTools = false;
  return (messages: readonly ChatMessage[]): readonly ChatMessage[] => {
    const tailIndex = messages.length - 1;
    const tail = messages[tailIndex];
    let appendOnly = !!tailSnapshot && !!tail
      && messages.length === previous.length
      && tail.role === 'assistant' && tailSnapshot.role === 'assistant'
      && tail.streaming === true && tailSnapshot.streaming === true
      && !tailHasTools
      && !tail.toolPosition && !tailSnapshot.toolPosition
      && projection.at(-1) === previous.at(-1)
      && tail.text.startsWith(tailSnapshot.text);
    if (appendOnly) {
      const keys = Object.keys(tail) as (keyof ChatMessage)[];
      appendOnly = keys.length === Object.keys(tailSnapshot!).length
        && keys.every(key => key === 'text'
          || Object.prototype.hasOwnProperty.call(tailSnapshot, key) && Object.is(tail[key], tailSnapshot![key]));
    }
    if (appendOnly) {
      for (let i = 0; i < tailIndex; i++) {
        if (messages[i] !== previous[i]) { appendOnly = false; break; }
      }
    }
    if (appendOnly) {
      if (plain) projection = messages;
      else {
        const updated = [...projection];
        updated[updated.length - 1] = tail;
        projection = updated;
      }
      // The private reference snapshot makes in-place array slot replacement
      // detectable as well; no previous transcript content is mutated.
      previous[tailIndex] = tail;
    } else {
      projection = placeSharedTools(messages);
      plain = projection === messages;
      previous = [...messages];
      tailHasTools = !!tail && messages.some(message => message.role === 'tool' && message.toolPosition?.messageId === tail.id);
    }
    tailSnapshot = tail ? { ...tail } : undefined;
    return projection;
  };
}
