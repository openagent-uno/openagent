/**
 * EmptyState — a simple, centered "nothing here yet" placeholder.
 *
 * Deliberately NOT a panel: just an icon, a title, a muted line, and an
 * optional primary action, centered in whatever space the parent gives
 * it (``flex: 1``). Use on list/dashboard screens (Workflows, Scheduled
 * tasks) when there are no rows to show.
 */

import Feather from '@expo/vector-icons/Feather';
import { View, Text, StyleSheet } from 'react-native';
import { colors, font } from '../theme';
import Button from './Button';

interface Props {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  message?: string;
  action?: { label: string; icon?: keyof typeof Feather.glyphMap; onPress: () => void };
}

export default function EmptyState({ icon, title, message, action }: Props) {
  return (
    <View style={styles.wrap}>
      <Feather name={icon} size={26} color={colors.textMuted} style={styles.icon} />
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {action ? (
        <View style={styles.action}>
          <Button
            variant="primary"
            size="sm"
            label={action.label}
            icon={action.icon}
            onPress={action.onPress}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
    paddingHorizontal: 24,
  },
  icon: { marginBottom: 14, opacity: 0.9 },
  title: {
    fontSize: 16,
    color: colors.text,
    fontFamily: font.display,
    fontWeight: '500',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  message: {
    fontSize: 12.5,
    color: colors.textMuted,
    textAlign: 'center',
    maxWidth: 380,
    lineHeight: 18,
    marginTop: 8,
  },
  action: { marginTop: 16 },
});
