/**
 * Single-run stack — hosts the run-detail route opened from the sidebar's
 * Recent feed (``/runs/{id}?kind=…&parentId=…``).
 *
 * This lives at the drawer root (not inside the Scheduled / Workflows
 * stacks) on purpose: clicking a run in the Recent feed is like opening a
 * chat session — it swaps the content without selecting a workspace tab.
 * The screen is the stack's root, but it is always *reached by a push* —
 * from a Chat transcript's run-launch card or the sidebar's Recent feed —
 * so ``HeaderBackOrMenu`` shows a back chevron that returns to wherever it
 * was opened from (via expo-router history), degrading to the drawer
 * toggle only when opened cold from a deep link.
 */

import { Stack } from 'expo-router';
import { themedHeader, HeaderBackOrMenu } from '../../../components/screenHeader';

export default function RunsStackLayout() {
  return (
    <Stack
      screenOptions={{
        ...themedHeader,
        headerLeft: () => <HeaderBackOrMenu />,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="[id]" options={{ title: 'Run' }} />
    </Stack>
  );
}
