/**
 * Workflows tab — Expo Router Stack.
 *
 * Opens on the list dashboard (``index``). The visual editor pushes
 * onto this stack as ``[id]``.
 *
 * Mirrors ``mcps/_layout.tsx`` one-to-one — same pattern, same
 * transitions; the navigator owns the headers (the list + run history),
 * while the visual editor screen manages its own full-canvas chrome.
 *
 * Both screens are declared explicitly. Expo Router will still discover
 * ``[id]`` from the file system without this line, but being explicit
 * keeps the route order deterministic and matches ``mcps/_layout.tsx``.
 */

import { Stack } from 'expo-router';
import { themedHeader, HeaderMenu, HeaderMenuAndBack } from '../../../components/screenHeader';

// Anchor the stack at ``index`` so the editor / run-history sub-screens
// always have the list beneath them — back pops to the list in-section
// instead of bubbling to the Drawer. See app/(tabs)/_layout.tsx.
export const unstable_settings = { initialRouteName: 'index' };

export default function WorkflowsStackLayout() {
  return (
    <Stack
      screenOptions={{
        ...themedHeader,
        // Section fallback: a cold-loaded (reloaded/deep-linked) sub-screen
        // with no trail history backs out to the section dashboard, not chat.
        headerLeft: () => <HeaderMenuAndBack fallback="/(tabs)/workflows" />,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Workflows', headerLeft: () => <HeaderMenu /> }} />
      {/* The visual editor is a full-canvas screen with its own toolbar
          (Back / Save / Run) — it manages its own chrome, no nav header. */}
      <Stack.Screen name="[id]" options={{ headerShown: false }} />
      <Stack.Screen name="runs/[id]" options={{ title: 'Workflow runs' }} />
    </Stack>
  );
}
