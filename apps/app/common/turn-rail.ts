import type { ChatMessage } from './types';

export interface RailTurn {
  id: string;
  ordinal?: number;
  own: boolean;
  author?: string;
  preview: string;
  timestamp?: number;
}

interface PromptSnapshot {
  id: string;
  ordinal?: number;
  text: string;
  handle?: string;
  display?: string;
  timestamp: number;
}

/** Per-mounted-rail cache: streaming assistant text cannot change human turns.
 * Base identity covers refreshed author/ACL/index data; prompt field snapshots
 * also detect edits even if a transport reuses a message object. Never shared
 * across accounts, sessions or mounted clients. No transcript rows are capped.
 */
export function createTurnRailMerge() {
  let base: readonly RailTurn[] | undefined;
  let known = new Set<string>();
  let prompts: PromptSnapshot[] = [];
  let handle: string | undefined;
  let output: readonly RailTurn[] | undefined;
  return (
    indexed: readonly RailTurn[],
    recent: readonly ChatMessage[],
    currentUserHandle?: string,
  ): readonly RailTurn[] => {
    const sameBase = base === indexed;
    const samePrompts = recent.length === prompts.length && recent.every((message, i) => {
      const previous = prompts[i];
      return message.id === previous.id && message.ordinal === previous.ordinal
        && message.text === previous.text && message.author?.handle === previous.handle
        && message.author?.display === previous.display && message.timestamp === previous.timestamp;
    });
    if (sameBase && samePrompts && handle === currentUserHandle && output) return output;
    if (!sameBase) {
      base = indexed;
      known = new Set(indexed.map(turn => turn.id));
    }
    handle = currentUserHandle;
    prompts = recent.map(message => ({
      id: message.id, ordinal: message.ordinal, text: message.text,
      handle: message.author?.handle, display: message.author?.display,
      timestamp: message.timestamp,
    }));
    const extra: RailTurn[] = [];
    for (const message of recent) {
      if (known.has(message.id)) continue;
      const authorHandle = message.author?.handle;
      extra.push({
        id: message.id,
        ordinal: message.ordinal,
        own: !authorHandle || !currentUserHandle || authorHandle === currentUserHandle,
        author: message.author?.display || authorHandle,
        preview: message.text.replace(/\s+/g, ' ').trim(),
        timestamp: message.timestamp || undefined,
      });
    }
    output = extra.length ? [...indexed, ...extra] : indexed;
    return output;
  };
}
