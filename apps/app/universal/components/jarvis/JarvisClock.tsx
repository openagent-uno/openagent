import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, font } from '../../theme';

interface Props {
  /** Big or small variant. Default 'lg'. */
  size?: 'sm' | 'md' | 'lg';
  /** Show the date subline. Default true. */
  showDate?: boolean;
  /** Center align (false = left). Default true. */
  center?: boolean;
}

/**
 * Big mono clock + date subline. Used as a banner on the chat home
 * (matches the "00:41 — SUNDAY 26 APRIL" frame from the reference)
 * and as a corner ornament on other screens.
 */
export default function JarvisClock({ size = 'lg', showDate = true, center = true }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [colonOn, setColonOn] = useState(true);

  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date();
      setNow(d);
      setColonOn((c) => !c);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dateStr = formatDate(now);

  const fontSize = size === 'sm' ? 18 : size === 'md' ? 36 : 64;
  const dateSize = size === 'sm' ? 9 : size === 'md' ? 11 : 13;

  return (
    <View style={[styles.root, center && styles.center]}>
      <View style={styles.row}>
        <Text style={[styles.digits, { fontSize }]}>{hh}</Text>
        <Text
          style={[
            styles.digits,
            { fontSize, opacity: colonOn ? 1 : 0.18 },
          ]}
        >:</Text>
        <Text style={[styles.digits, { fontSize }]}>{mm}</Text>
      </View>
      {showDate && (
        <Text style={[styles.date, { fontSize: dateSize }]}>{dateStr}</Text>
      )}
    </View>
  );
}

function formatDate(d: Date): string {
  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const months = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
  ];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

const styles = StyleSheet.create({
  root: { flexDirection: 'column', alignItems: 'flex-start' },
  center: { alignItems: 'center' },
  row: { flexDirection: 'row' },
  digits: {
    color: colors.text,
    fontFamily: font.display,
    fontWeight: '500',
    letterSpacing: 6,
    lineHeight: undefined,
  },
  date: {
    color: colors.textSecondary,
    fontFamily: font.sans,
    fontWeight: '500',
    letterSpacing: 4,
    marginTop: 6,
    textTransform: 'uppercase',
  },
});
