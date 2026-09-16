/**
 * MCPs tab — Expo Router Stack.
 *
 * The tab opens on the grid dashboard (``index``). Deeper screens push
 * onto this stack:
 *   - ``install``: secret-entry form for a marketplace server the user
 *     chose to install (params: name, version).
 *   - ``[name]``: edit screen for any installed MCP row.
 *
 * The "new custom MCP" form lives inline as the 4th tab on the dashboard,
 * not as a pushed route — so there is no ``new`` screen registered here.
 *
 * Expo Router is layered on react-navigation; the ``<Stack />`` below
 * is the same native stack navigator, so native back gestures and
 * screen transitions work out of the box. The navigator owns every
 * header: the dashboard gets the drawer toggle, sub-screens get a back
 * button + title (set per-screen via setOptions).
 */

import { Stack } from 'expo-router';
import { themedHeader, HeaderMenu, HeaderMenuAndBack } from '../../../components/screenHeader';

// Anchor the stack at ``index`` so the connector edit / install sub-screens
// always have the grid beneath them — back pops to the grid in-section
// instead of bubbling to the Drawer. See app/(tabs)/_layout.tsx.
export const unstable_settings = { initialRouteName: 'index' };

export default function MCPsStackLayout() {
  return (
    <Stack
      screenOptions={{
        ...themedHeader,
        // Section fallback: a cold-loaded (reloaded/deep-linked) sub-screen
        // with no trail history backs out to the section dashboard, not chat.
        headerLeft: () => <HeaderMenuAndBack fallback="/(tabs)/mcps" />,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Connectors', headerLeft: () => <HeaderMenu /> }} />
      {/* Sub-screens keep these screen-name titles (no per-item names). */}
      <Stack.Screen name="install" options={{ title: 'Install connector' }} />
      <Stack.Screen name="[name]" options={{ title: 'Connector' }} />
    </Stack>
  );
}
