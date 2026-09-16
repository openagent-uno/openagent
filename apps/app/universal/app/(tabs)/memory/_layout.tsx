/**
 * Memory tab — Expo Router Stack.
 *
 * Opens on the graph dashboard (``index``). Tapping a graph node pushes
 * the editor onto this stack as ``[...path]`` — catch-all so note paths
 * with folder segments (``docs/ideas.md``) work as-is.
 *
 * Mirrors ``mcps/_layout.tsx`` and ``workflows/_layout.tsx`` — same
 * pattern, same transitions; the navigator owns every header (the graph
 * gets the drawer toggle, sub-screens get a back button + title).
 */

import { Stack } from 'expo-router';
import { themedHeader, HeaderMenu, HeaderMenuAndBack } from '../../../components/screenHeader';

// Anchor the stack at ``index`` so a pushed/deep-linked sub-screen (a note,
// the vault history) always has the graph dashboard beneath it — its back
// chevron then pops to ``index`` in-section instead of bubbling out to the
// Drawer (which would jump to another section). See app/(tabs)/_layout.tsx.
export const unstable_settings = { initialRouteName: 'index' };

export default function MemoryStackLayout() {
  return (
    <Stack
      screenOptions={{
        ...themedHeader,
        // Section fallback: a cold-loaded (reloaded/deep-linked) sub-screen
        // with no trail history backs out to the section dashboard, not chat.
        headerLeft: () => <HeaderMenuAndBack fallback="/(tabs)/memory" />,
        animation: 'slide_from_right',
      }}
    >
      {/* Top-level: drawer toggle, not a back button. */}
      <Stack.Screen name="index" options={{ title: 'Memory', headerLeft: () => <HeaderMenu /> }} />
      {/* Sub-screens use these screen-name titles (no per-note names). */}
      <Stack.Screen name="[...path]" options={{ title: 'Memory file' }} />
      <Stack.Screen name="history" options={{ title: 'Memory history' }} />
      <Stack.Screen name="health" options={{ title: 'Memory health' }} />
      <Stack.Screen name="history/[...path]" options={{ title: 'Memory file history' }} />
    </Stack>
  );
}
