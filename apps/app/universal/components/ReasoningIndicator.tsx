import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { colors } from '../theme';
import { useReducedMotion } from '../hooks/useDrawerMotion';

export default function ReasoningIndicator() {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (reduced || Platform.OS === 'web') return;
    let id: number;
    let start: number | undefined;
    const tick = (time: number) => {
      start ??= time;
      setPhase(((time - start) % 1050) / 1050);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [reduced]);

  if (Platform.OS === 'web') return (
    <span className="oa-working-dots" role="status" aria-label="Agent is working">
      <i /><i /><i />
    </span>
  );
  return (
    <View style={styles.row} accessible accessibilityLabel="Agent is working">
      {[0, 1, 2].map((index) => {
        const cycle = (phase - index * 0.13 + 1) % 1;
        const strength = reduced || cycle > 0.43 ? 0 : Math.sin(Math.PI * cycle / 0.43);
        return <View key={index} style={[styles.dot, { opacity: 0.55 + strength * 0.45,
          transform: [{ translateY: -strength * 3 }] }]} />;
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 12 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.textSecondary },
});
