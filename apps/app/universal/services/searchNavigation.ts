import type { EventCause, SearchTarget } from '../../common/unified-history';
import {
  isChatSearchTarget,
  searchNavigationIntent,
  type SearchOpenMetadata,
} from '../../common/search-navigation';
import { useChat } from '../stores/chat';
import { useSearch } from '../stores/search';

interface RouterLike {
  // Expo Router's generated href type is intentionally stricter than the
  // serializable intent returned by common/. Keep this boundary structural:
  // this service only needs a push-capable router and owns the single cast.
  push: (...args: any[]) => void;
}

/**
 * Open one authorized search destination. Chat activation happens before the
 * route change so selecting a result while already on /chat cannot be lost by
 * React Navigation's same-route de-duplication. The Chat screen still owns the
 * authorized message-window/tool-detail fetch driven by the route params.
 */
export function openSearchTarget(
  router: RouterLike,
  target: SearchTarget,
  causedBy?: EventCause | null,
  metadata?: SearchOpenMetadata,
): void {
  const intent = searchNavigationIntent(target, causedBy);
  if (isChatSearchTarget(target)) {
    if (metadata?.title) {
      const occurredAt = Date.parse(metadata.occurredAt);
      useChat.getState().hydrateFromServer([{
        session_id: target.session_id,
        client_id: '',
        title: metadata.title,
        model: null,
        framework: null,
        created_at: null,
        last_active_at: Number.isFinite(occurredAt) ? Math.floor(occurredAt / 1000) : null,
        origin: metadata.rootKind === 'delegated_session' ? 'delegation' : 'chat',
        kind: metadata.rootKind,
      }]);
    }
    useSearch.getState().setChatDestination(target);
    useChat.getState().setActiveSession(target.session_id);
    // PUSH is intentional. The outer right-hand Drawer names its permanent
    // workspace route ``__workspace__``; REPLACE can target that navigator and
    // leak the internal name into the URL. Same-route PUSH may discard params,
    // which is harmless because the account-scoped destination above carries
    // the exact in-app anchor, while cross-screen PUSH still opens Chat.
    router.push(intent);
    return;
  }
  router.push(intent);
}
