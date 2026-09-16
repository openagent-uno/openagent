/** Mouse/keyboard resize affordance shared by both permanent side drawers. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import {
  drawerKeyboardStep,
  resizedDrawerWidth,
  type DrawerWidthBounds,
  type ResizableDrawerSide,
} from '../../common/drawer-resize';
import { colors } from '../theme';

interface DrawerResizeHandleProps {
  side: ResizableDrawerSide;
  width: number;
  bounds: DrawerWidthBounds;
  label: string;
  onChange: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
}

export default function DrawerResizeHandle({
  side,
  width,
  bounds,
  label,
  onChange,
  onResizingChange,
}: DrawerResizeHandleProps) {
  const startWidth = useRef(width);
  const latestWidth = useRef(width);
  const [hovered, setHovered] = useState(false);
  const [resizing, setResizing] = useState(false);
  const bodyStyles = useRef<{ cursor: string; userSelect: string } | null>(null);
  const onResizingChangeRef = useRef(onResizingChange);

  latestWidth.current = width;
  onResizingChangeRef.current = onResizingChange;

  const setResizeState = useCallback((next: boolean) => {
    setResizing(next);
    onResizingChange?.(next);
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (next) {
      bodyStyles.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      return;
    }
    if (bodyStyles.current) {
      document.body.style.cursor = bodyStyles.current.cursor;
      document.body.style.userSelect = bodyStyles.current.userSelect;
      bodyStyles.current = null;
    }
  }, [onResizingChange]);

  useEffect(() => () => {
    if (Platform.OS === 'web' && typeof document !== 'undefined' && bodyStyles.current) {
      document.body.style.cursor = bodyStyles.current.cursor;
      document.body.style.userSelect = bodyStyles.current.userSelect;
    }
    onResizingChangeRef.current?.(false);
  }, []);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      startWidth.current = latestWidth.current;
      setResizeState(true);
    },
    onPanResponderMove: (_event, gesture) => {
      onChange(resizedDrawerWidth(startWidth.current, gesture.dx, side, bounds));
    },
    onPanResponderRelease: () => setResizeState(false),
    onPanResponderTerminate: () => setResizeState(false),
    onPanResponderTerminationRequest: () => false,
  }), [bounds, onChange, setResizeState, side]);

  const handleKeyDown = useCallback((event: { key?: string; preventDefault?: () => void }) => {
    const next = drawerKeyboardStep(width, event.key || '', side, bounds);
    if (next === null) return;
    event.preventDefault?.();
    onChange(next);
  }, [bounds, onChange, side, width]);

  const handleAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    const action = event.nativeEvent.actionName;
    const key = action === 'increment'
      ? (side === 'left' ? 'ArrowRight' : 'ArrowLeft')
      : (side === 'left' ? 'ArrowLeft' : 'ArrowRight');
    const next = drawerKeyboardStep(width, key, side, bounds);
    if (next !== null) onChange(next);
  }, [bounds, onChange, side, width]);

  const webProps = Platform.OS === 'web'
    ? ({
        role: 'separator',
        tabIndex: 0,
        'aria-label': label,
        'aria-orientation': 'vertical',
        'aria-valuemin': bounds.min,
        'aria-valuemax': bounds.max,
        'aria-valuenow': width,
        onKeyDown: handleKeyDown,
      } as any)
    : {};

  return (
    <View
      testID={`${side}-drawer-resize-handle`}
      {...panResponder.panHandlers}
      {...webProps}
      {...(Platform.OS !== 'web' ? {
        accessible: true,
        accessibilityRole: 'adjustable' as const,
        accessibilityLabel: label,
        accessibilityValue: { min: bounds.min, max: bounds.max, now: width },
        accessibilityActions: [{ name: 'increment' }, { name: 'decrement' }],
        onAccessibilityAction: handleAccessibilityAction,
      } : {})}
      onMouseEnter={Platform.OS === 'web' ? (() => setHovered(true)) as any : undefined}
      onMouseLeave={Platform.OS === 'web' ? (() => setHovered(false)) as any : undefined}
      style={[
        styles.handle,
        side === 'left' ? styles.leftBoundary : styles.rightBoundary,
        Platform.OS === 'web' ? styles.webHandle : null,
      ]}
    >
      <View
        style={[
          styles.rail,
          side === 'left' ? styles.leftRail : styles.rightRail,
          (hovered || resizing) && styles.railActive,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  handle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leftBoundary: { right: 0 },
  rightBoundary: { left: 0 },
  webHandle: {
    cursor: 'col-resize',
    userSelect: 'none',
    touchAction: 'none',
  } as any,
  rail: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: colors.borderLight,
  },
  leftRail: { right: 0 },
  rightRail: { left: 0 },
  railActive: {
    width: 2,
    backgroundColor: colors.accent,
  },
});
