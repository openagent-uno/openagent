/**
 * Events tab — Expo Router Stack.
 *
 * Opens on the list dashboard (``index``). The event editor (``[id]``, also
 * used for create via the ``new`` sentinel) and the delivery history
 * (``runs/[id]``) push onto this stack. A single delivery opens on the shared
 * drawer-root ``/runs/{id}?kind=event`` screen, like every other run.
 *
 * Mirrors ``tasks/_layout.tsx`` — the navigator owns every header: the list
 * gets the drawer toggle, the editor and history get a back button + title.
 */

import { Stack } from 'expo-router';
import { themedHeader, HeaderMenu, HeaderMenuAndBack } from '../../../components/screenHeader';

export const unstable_settings = { initialRouteName: 'index' };

export default function EventsStackLayout() {
  return (
    <Stack
      screenOptions={{
        ...themedHeader,
        headerLeft: () => <HeaderMenuAndBack fallback="/(tabs)/events" />,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Events', headerLeft: () => <HeaderMenu /> }} />
      {/* Editor sets its own title ("Event" / "New event"). */}
      <Stack.Screen name="[id]" options={{ title: 'Event' }} />
      <Stack.Screen name="runs/[id]" options={{ title: 'Deliveries' }} />
    </Stack>
  );
}
