import type { EventCause, SearchTarget } from '../../../common/unified-history';
import type { SearchOpenMetadata } from '../../../common/search-navigation';
import GlobalSearchOverlayShared from './GlobalSearchOverlay.shared';

export default function GlobalSearchOverlay({ onOpenTarget }: {
  onOpenTarget: (
    target: SearchTarget,
    causedBy?: EventCause | null,
    metadata?: SearchOpenMetadata,
  ) => void;
}) {
  return <GlobalSearchOverlayShared platform="web" onOpenTarget={onOpenTarget} />;
}
