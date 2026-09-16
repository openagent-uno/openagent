/**
 * Custom window controls — cross-platform, Jarvis-themed.
 * Replaces native macOS traffic lights and adds controls on frameless Windows/Linux.
 */

import Feather from '@expo/vector-icons/Feather';
import { Platform, View, Pressable, StyleSheet } from 'react-native';
import { useState, useEffect } from 'react';

function desktop(): any {
  if (typeof window === 'undefined') return undefined;
  return (window as any).desktop;
}

export default function WindowControls() {
  const isDesktop = Platform.OS === 'web' && desktop()?.isDesktop === true;

  const [hovered, setHovered] = useState<number | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    const d = desktop();
    d?.isMaximized().then((v: boolean) => setIsMaximized(v));
  }, [isDesktop]);

  if (!isDesktop) return null;

  const d = desktop();

  const buttons = [
    {
      label: 'close',
      icon: 'x',
      onPress: () => d?.close?.(),
    },
    {
      label: 'minimize',
      icon: 'minus',
      onPress: () => d?.minimize?.(),
    },
    {
      label: 'maximize',
      icon: isMaximized ? 'maximize-2' : 'square',
      onPress: () => {
        d?.maximize?.();
        setIsMaximized(!isMaximized);
      },
    },
  ];

  const groupProps: any = {
    style: styles.container,
    onMouseEnter: () => {},
    onMouseLeave: () => setHovered(null),
  };

  return (
    <View {...groupProps}>
      {buttons.map((btn, i) => {
        const active = hovered === i;

        const itemProps: any = {
          onMouseEnter: () => setHovered(i),
          onMouseLeave: () => setHovered(null),
        };

        return (
          <View key={btn.label} {...itemProps}>
            <Pressable
              onPress={btn.onPress}
              style={[
                styles.btn,
                // @ts-ignore web CSS
                { WebkitAppRegion: 'no-drag' },
                { opacity: active ? 1 : 0.45 },
              ]}
            >
              <View style={styles.iconWrap}>
                <Feather
                  name={btn.icon as any}
                  size={7}
                  color="#0A0A0A"
                  style={{ opacity: active ? 1 : 0 }}
                />
              </View>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const SIZE = 11;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 14,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 300,
    // @ts-ignore web CSS
    WebkitAppRegion: 'no-drag',
  } as any,
  btn: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.80)',
  },
  iconWrap: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
