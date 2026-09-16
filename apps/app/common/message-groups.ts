import type { ChatMessage } from './types';

export interface MessageTurnTimelineEntry {
  /** Normalized epoch milliseconds for the visible speaker turn. */
  timestamp?: number;
  /** True only on the first timestamped turn rendered for a local day. */
  showDayDivider: boolean;
}

// Modern epoch seconds are ~1e9 and milliseconds are ~1e12. Keep legacy
// /runs payloads (seconds) compatible with canonical v2 messages (ISO -> ms)
// without ever turning a missing timestamp into "now".
const MILLISECOND_THRESHOLD = 1e11;

export function messageTimestampMs(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value < MILLISECOND_THRESHOLD ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? milliseconds : undefined;
}

function localDayKey(milliseconds: number): string {
  const date = new Date(milliseconds);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * A transcript group is a contiguous stretch owned by the same visible
 * speaker. Tool rows belong to the agent's stretch even though they do not
 * render an author header themselves; compaction is a system boundary. This
 * lets a response flow as assistant text -> tool card -> assistant text
 * without repeating the agent name, while still showing the name when a
 * response begins with a tool call.
 */
function groupKey(message: Pick<ChatMessage, 'role' | 'author'>): string {
  if (message.role === 'assistant' || message.role === 'tool') {
    return 'agent';
  }
  if (message.role === 'compaction') return 'system';
  if (message.author?.kind === 'agent') {
    // Agent-authored seed prompts are missions, not part of the reply group.
    return 'mission';
  }
  const human = message.author?.handle?.trim().toLowerCase()
    || message.author?.display?.trim().toLowerCase()
    || 'current-user';
  return `human:${human}`;
}

function rendersAuthorHeader(message: Pick<ChatMessage, 'role' | 'author'>): boolean {
  return message.role === 'assistant'
    || (message.role === 'user' && message.author?.kind !== 'agent');
}

/**
 * Return one flag per message. A flag is true only for the first header-bearing
 * message in a contiguous speaker group. The calculation intentionally runs
 * over the rendered window: if pagination starts halfway through a group, its
 * first visible message still identifies the speaker.
 */
export function messageHeaderVisibility(
  messages: readonly Pick<ChatMessage, 'role' | 'author'>[],
): boolean[] {
  let activeGroup: string | undefined;
  let headerShown = false;

  return messages.map((message) => {
    const nextGroup = groupKey(message);
    if (nextGroup !== activeGroup) {
      activeGroup = nextGroup;
      headerShown = false;
    }
    if (!rendersAuthorHeader(message) || headerShown) return false;
    headerShown = true;
    return true;
  });
}

/**
 * Return timeline metadata for the same visible turns that own author
 * headers. Consecutive assistant/tool rows remain one agent turn, and
 * consecutive messages from the same human remain one human turn. Agent
 * mission seeds are also visible turns even though they use their own Mission
 * block instead of an author header.
 *
 * The first visible timestamped turn always receives a day divider. This is
 * intentional for paginated transcripts: a window opened halfway through a
 * day still tells the reader which day they are looking at.
 */
export function messageTurnTimeline(
  messages: readonly (
    Pick<ChatMessage, 'role' | 'author'> & { timestamp?: number | null }
  )[],
): MessageTurnTimelineEntry[] {
  const headers = messageHeaderVisibility(messages);
  let previousDay: string | undefined;

  return messages.map((message, index) => {
    const isMission = message.role === 'user' && message.author?.kind === 'agent';
    const isSpeakerMessage = message.role === 'assistant' || message.role === 'user';
    if (!isSpeakerMessage) return { showDayDivider: false };

    const timestamp = messageTimestampMs(message.timestamp);
    if (timestamp == null) return { showDayDivider: false };

    const day = localDayKey(timestamp);
    const showDayDivider = day !== previousDay;
    previousDay = day;
    // A calendar boundary always starts a new visible turn, even when two
    // consecutive rows have the same author (for example, a follow-up sent
    // the next morning before the agent answered the previous one).
    if (!headers[index] && !isMission && !showDayDivider) {
      return { showDayDivider: false };
    }
    return { timestamp, showDayDivider };
  });
}
