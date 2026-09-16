/**
 * Header — desktop window chrome only.
 *
 * The frameless Electron window needs a draggable strip and custom
 * traffic-light controls; that is all this is. Navigation, the agent
 * switcher, and the screen title live in the Sidebar and the per-screen
 * react-navigation headers. Renders only on the desktop shell (see
 * app/_layout.tsx).
 */

import { View, StyleSheet } from 'react-native';
import WindowControls from './WindowControls';
import DragRegion from './DragRegion';

export default function Header() {
  return (
    <View style={styles.header}>
      {/* Drag layer sits BEHIND the controls (sibling, not parent) so the
          no-drag buttons never nest inside a drag region. See DragRegion. */}
      <DragRegion />
      <WindowControls />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
    zIndex: 200,
    paddingLeft: 64,
    paddingRight: 12,
  },
});
