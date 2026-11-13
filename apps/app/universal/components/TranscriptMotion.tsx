import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useReducedMotion } from '../hooks/useDrawerMotion';

export function TranscriptEntrance({ recent, outgoing, reduced, children }: {
  recent: boolean; outgoing: boolean; reduced: boolean; children: ReactNode;
}) {
  const entrance = useRef(recent && !reduced).current;
  const value = useRef(new Animated.Value(entrance ? 0 : 1)).current;
  useEffect(() => {
    if (Platform.OS === 'web' || !entrance) return;
    if (reduced) { value.setValue(1); return; }
    const animation = Animated.timing(value, {
      toValue: 1, duration: outgoing ? 270 : 190,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [entrance, outgoing, reduced, value]);
  if (Platform.OS === 'web') {
    // ``data-oa-row`` lets the transcript window find a stable on-screen row
    // to keep in place while rows are added or trimmed above the viewport.
    return <div data-oa-row="" className={entrance && !reduced ? outgoing ? 'oa-outgoing-in' : 'oa-transcript-in' : undefined}
      style={{ minWidth: 0 }}>{children}</div>;
  }
  return <Animated.View style={{
    opacity: value,
    transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [outgoing ? 18 : 5, 0] }) }],
  }}>{children}</Animated.View>;
}

export function ToolShine() {
  const reduced = useReducedMotion();
  const offset = useRef(new Animated.Value(0)).current;
  const width = useRef(0);
  const nativeLoop = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => () => nativeLoop.current?.stop(), []);
  useEffect(() => {
    if (reduced) { nativeLoop.current?.stop(); width.current = 0; }
  }, [reduced]);
  if (reduced) return null;
  if (Platform.OS === 'web') return <div aria-hidden="true" className="oa-tool-shine" data-testid="running-tool-shine" />;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { overflow: 'hidden' }]}
      onLayout={({ nativeEvent }) => {
        const next = nativeEvent.layout.width;
        if (!next || next === width.current) return;
        width.current = next;
        nativeLoop.current?.stop();
        offset.setValue(-90);
        const sweep = Animated.timing(offset, {
          toValue: next, duration: 1450, delay: 450, easing: Easing.linear, useNativeDriver: true,
        });
        nativeLoop.current = Animated.loop(sweep);
        nativeLoop.current.start();
      }}>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 90, transform: [{ translateX: offset }] }}>
        <LinearGradient colors={['transparent', 'rgba(130,155,190,0.14)', 'transparent']}
          start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
      </Animated.View>
    </View>
  );
}
