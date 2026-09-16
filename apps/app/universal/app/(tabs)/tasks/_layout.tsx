/**
 * Scheduled-tasks tab — Expo Router Stack.
 *
 * Opens on the list dashboard (``index``). The task editor (``[id]``,
 * also used for create via the ``new`` sentinel) and run history
 * (``runs/[id]``) push onto this stack on web / native, and open as
 * separate desktop windows via ``openDetached``.
 *
 * Mirrors ``workflows/_layout.tsx`` — the navigator owns every header:
 * the list gets the drawer toggle, the editor and run history get a back
 * button + title (the editor adds a Save action via setOptions).
 */

import { Stack } from 'expo-router';
import { themedHeader, HeaderMenu, HeaderMenuAndBack } from '../../../components/screenHeader';

// Anchor the stack at ``index`` so the task editor / run-history sub-screens
// always have the list beneath them — back pops to the list in-section
// instead of bubbling to the Drawer. See app/(tabs)/_layout.tsx.
export const unstable_settings = { initialRouteName: 'index' };

export default function TasksStackLayout() {
  return (
    <Stack
      screenOptions={{
        ...themedHeader,
        // Section fallback: a cold-loaded (reloaded/deep-linked) sub-screen
        // with no trail history backs out to the section dashboard, not chat.
        headerLeft: () => <HeaderMenuAndBack fallback="/(tabs)/tasks" />,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Scheduled tasks', headerLeft: () => <HeaderMenu /> }} />
      {/* Editor sets its own title ("Scheduled task" / "New scheduled task"). */}
      <Stack.Screen name="[id]" options={{ title: 'Scheduled task' }} />
      <Stack.Screen name="runs/[id]" options={{ title: 'Scheduled runs' }} />
    </Stack>
  );
}
