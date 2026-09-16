/**
 * Catch-all for unmatched routes.
 *
 * Anything that fails to match a real route — a stale deep-link, a removed
 * screen, or an internal navigator anchor that leaked into the URL (e.g. the
 * historical ``/chat/__main__``) — lands here instead of expo-router's
 * dead-end "Unmatched Route" page. Redirect to the authenticated home rather
 * than stranding the user on a 404.
 */

import { Redirect } from 'expo-router';

export default function NotFound() {
  return <Redirect href="/(tabs)/chat" />;
}
