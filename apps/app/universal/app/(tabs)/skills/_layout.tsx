/**
 * Skills tab — Expo Router Stack.
 *
 * Opens on the library (``index``); tapping a skill pushes ``[name]``, the
 * reader/editor. Mirrors ``mcps/_layout.tsx`` — same pattern, same
 * transitions, same section-fallback back button.
 */

import { Stack } from 'expo-router';
import { themedHeader, HeaderMenu, HeaderMenuAndBack } from '../../../components/screenHeader';

export const unstable_settings = { initialRouteName: 'index' };

export default function SkillsStackLayout() {
  return (
    <Stack
      screenOptions={{
        ...themedHeader,
        // Section fallback: a cold-loaded (reloaded/deep-linked) sub-screen
        // with no trail history backs out to the section dashboard, not chat.
        headerLeft: () => <HeaderMenuAndBack fallback="/(tabs)/skills" />,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Skills', headerLeft: () => <HeaderMenu /> }} />
      <Stack.Screen name="[name]" options={{ title: 'Skill' }} />
    </Stack>
  );
}
