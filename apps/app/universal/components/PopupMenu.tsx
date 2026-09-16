/**
 * Reusable overflow ("⋯") menu: a trigger button that opens a small popup
 * of actions anchored to it. Built on a transparent `Modal` so it overlays
 * everything — including the react-navigation header — and dismisses on an
 * outside tap. The menu is positioned from the trigger's measured window
 * rect, so the same component works in a compact sidebar row and in the
 * header without per-call positioning code.
 *
 * Items can be `destructive` (rendered in the error colour) — e.g. Delete.
 */

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
  Modal,
  Dimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, font, radius, glassSurface } from '../theme';

type IconName = keyof typeof Feather.glyphMap;

export interface PopupMenuItem {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  onPress: () => void;
}

interface Anchor { x: number; y: number; w: number; h: number; point?: boolean; }

export interface PopupMenuHandle {
  /** Open the same menu at a viewport point, e.g. a mouse context click. */
  openAt: (x: number, y: number) => void;
}

const DEFAULT_MENU_WIDTH = 184;
// Rough per-row height (padding + line) used only to decide whether to flip
// the menu above the trigger when it would overflow the bottom edge.
const ROW_H = 38;

const PopupMenu = forwardRef<PopupMenuHandle, {
  /** Action rows — each closes the menu then runs ``onPress``. Omit when
   *  passing ``children`` for fully custom content (e.g. multi-select
   *  toggles that stay open). */
  items?: PopupMenuItem[];
  /** Custom popup content. Receives ``close`` so content can dismiss the
   *  menu itself (multi-select toggles simply don't call it). Takes
   *  precedence over ``items``. */
  children?: (close: () => void) => ReactNode;
  triggerIcon?: IconName;
  triggerSize?: number;
  triggerColor?: string;
  triggerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** Which edge of the menu lines up with the trigger. Default 'right'. */
  align?: 'left' | 'right';
  /** Popup width in px. Default 184. */
  menuWidth?: number;
  /** Stop the open-press from bubbling to a parent Pressable (e.g. a list
   *  row that would otherwise navigate). Default true. */
  stopPropagation?: boolean;
  /** Optional web interaction class. Defaults to the shared row hover; list
   *  rows can supply a child-control class when their parent owns the hover. */
  triggerClassName?: string;
}>(function PopupMenu({
  items,
  children,
  triggerIcon = 'more-horizontal',
  triggerSize = 18,
  triggerColor = colors.textSecondary,
  triggerStyle,
  accessibilityLabel = 'More options',
  align = 'right',
  menuWidth = DEFAULT_MENU_WIDTH,
  stopPropagation = true,
  triggerClassName,
}, ref) {
  const triggerRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const open = () => {
    const node: any = triggerRef.current;
    if (node && typeof node.measureInWindow === 'function') {
      node.measureInWindow((x: number, y: number, w: number, h: number) =>
        setAnchor({ x, y, w, h }),
      );
    } else {
      setAnchor({ x: 0, y: 0, w: 0, h: 0 });
    }
  };
  const close = () => setAnchor(null);

  useImperativeHandle(ref, () => ({
    openAt: (x, y) => setAnchor({ x, y, w: 0, h: 0, point: true }),
  }), []);

  let menuPos: ViewStyle | null = null;
  if (anchor) {
    const screen = Dimensions.get('window');
    const left = anchor.point
      ? Math.max(8, Math.min(anchor.x, screen.width - menuWidth - 8))
      : align === 'left'
        ? Math.min(anchor.x, screen.width - menuWidth - 8)
        : Math.max(8, anchor.x + anchor.w - menuWidth);
    // Row count is only known for the ``items`` form; for custom children fall
    // back to a small estimate. Used solely to decide the flip-above-on-overflow.
    const rows = items ? items.length : 4;
    const estHeight = rows * ROW_H + 8;
    const below = anchor.point ? anchor.y : anchor.y + anchor.h + 4;
    // Flip above the trigger when it would run off the bottom of the screen.
    const top = below + estHeight > screen.height - 8
      ? Math.max(8, anchor.y - estHeight - 4)
      : below;
    menuPos = { position: 'absolute', top, left, width: menuWidth };
  }

  return (
    <>
      <Pressable
        ref={triggerRef as any}
        onPress={(e) => { if (stopPropagation) (e as any)?.stopPropagation?.(); open(); }}
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        // @ts-ignore web hover
        {...(Platform.OS === 'web'
          ? { className: triggerClassName || 'oa-side-row' }
          : {})}
      >
        <Feather name={triggerIcon} size={triggerSize} color={triggerColor} />
      </Pressable>

      <Modal visible={!!anchor} transparent animationType="none" onRequestClose={close}>
        <Pressable
          style={styles.scrim}
          onPress={close}
          accessibilityLabel="Dismiss menu"
          {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
        />
        {menuPos && (
          <View style={[styles.menu, menuPos, glassStyle]}>
            {children
              ? children(close)
              : (items ?? []).map((it, i) => (
                <Pressable
                  key={`${it.label}-${i}`}
                  onPress={() => { close(); it.onPress(); }}
                  style={styles.item}
                  accessibilityRole="button"
                  accessibilityLabel={it.label}
                  // @ts-ignore web hover
                  {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
                >
                  {it.icon ? (
                    <Feather
                      name={it.icon}
                      size={14}
                      color={it.destructive ? colors.error : colors.textSecondary}
                    />
                  ) : null}
                  <Text style={[styles.itemText, it.destructive && styles.itemTextDestructive]}>
                    {it.label}
                  </Text>
                </Pressable>
              ))}
          </View>
        )}
      </Modal>
    </>
  );
});

export default PopupMenu;

const glassStyle: any = {
  backgroundColor: glassSurface.backgroundColor,
  ...(Platform.OS === 'web'
    ? { backdropFilter: glassSurface.webFilter, WebkitBackdropFilter: glassSurface.webFilter }
    : {}),
};

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject },
  menu: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    overflow: 'hidden',
    // Float above the scene on native; the Modal already stacks it above the
    // app, this just lifts it off the scrim with a soft shadow.
    shadowColor: 'rgba(0,0,0,0.25)',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 1,
    shadowRadius: 28,
    elevation: 12,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radius.sm,
    marginHorizontal: 4,
  },
  itemText: { flex: 1, fontFamily: font.sans, fontSize: 13, color: colors.text },
  itemTextDestructive: { color: colors.error },
});
