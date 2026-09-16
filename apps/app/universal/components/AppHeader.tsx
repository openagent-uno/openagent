/**
 * AppHeader — the phone-only top bar.
 *
 * On phones the sidebar lives behind a slide-in drawer, so the screen
 * needs a slim bar that opens it (menu), shows the brand, and offers a
 * one-tap "new session". Tablet / desktop don't mount this — the
 * permanent sidebar already carries all of it.
 */

import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useChat } from '../stores/chat';
import { chatSessionIntent } from '../../common/search-navigation';
import { colors, font, radius, spacing } from '../theme';

export default function AppHeader({ onMenu }: { onMenu: () => void }) {
  const router = useRouter();

  const newSession = () => {
    const id = useChat.getState().createSession();
    router.push(chatSessionIntent(id) as any);
  };

  return (
    <View style={styles.bar}>
      <Pressable
        onPress={onMenu}
        hitSlop={8}
        style={styles.iconBtn}
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        // @ts-ignore web hover
        {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
      >
        <Feather name="menu" size={18} color={colors.textSecondary} />
      </Pressable>

      <Text style={styles.word}>OPENAGENT</Text>

      <Pressable
        onPress={newSession}
        hitSlop={8}
        style={styles.iconBtn}
        accessibilityRole="button"
        accessibilityLabel="New session"
        // @ts-ignore web hover
        {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
      >
        <Feather name="edit-3" size={17} color={colors.accent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    backgroundColor: colors.sidebar,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  word: {
    fontFamily: font.display,
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: 2.5,
  },
});
