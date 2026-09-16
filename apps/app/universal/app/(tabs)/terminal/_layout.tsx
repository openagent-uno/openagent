/**
 * Terminal stack — hosts the full-screen / detached terminal route.
 *
 * Opened from the System tab via ``openDetached(router, 'terminal/<id>')``
 * — a new OS window on desktop, a pushed full-screen route on web /
 * native. Mirrors ``workflows/_layout.tsx``; the screen renders its own
 * chrome so headers are suppressed here.
 */

import { Stack } from 'expo-router';
import { themedHeader } from '../../../components/screenHeader';

export default function TerminalStackLayout() {
  // The terminal screen sets its own title / back / status via
  // navigation.setOptions (its back closes the window, and the live status
  // badge rides in headerRight).
  return (
    <Stack screenOptions={{ ...themedHeader, animation: 'fade' }}>
      <Stack.Screen name="[id]" />
    </Stack>
  );
}
