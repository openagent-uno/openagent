/** Cold-start account screen. The account UI is the same component used by
 * the in-app switcher, placed beneath the clock. */
import { useEffect } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useConnection, directedAccountId } from '../stores/connection';
import AgentAccountPanel from '../components/AgentAccountPanel';
import BrandLogo from '../components/BrandLogo';
import DragRegion from '../components/DragRegion';
import WindowControls from '../components/WindowControls';
import { JarvisClock } from '../components/jarvis';
import { spacing } from '../theme';

export default function LoginScreen() {
  const router = useRouter();
  const connectId = directedAccountId();
  const isMacDesktop = typeof window !== 'undefined'
    && (window as any).desktop?.isDesktop === true
    && (window as any).desktop?.platform === 'darwin';
  const { activeAccountId, accounts, isLoading } = useConnection();
  useEffect(() => {
    if (!isLoading && accounts.length > 0) router.replace('/(tabs)/chat');
  }, [accounts.length, isLoading, router]);

  if (isLoading || accounts.length > 0) {
    return <View style={styles.container}><ActivityIndicator /></View>;
  }

  return (
    <View style={styles.screen}>
      {isMacDesktop && (
        <View style={styles.macStrip}>
          <DragRegion />
          <WindowControls />
        </View>
      )}
      <ScrollView contentContainerStyle={styles.container}>
        <View
          style={styles.inner}
          {...(Platform.OS === 'web' ? { className: 'oa-fade-in' } as any : {})}
        >
          <View style={styles.wakeScene}>
            <BrandLogo size={76} />
            <JarvisClock size="md" />
          </View>
          <AgentAccountPanel
            embedded
            mode="connect"
            preferredAccountId={connectId || activeAccountId}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  macStrip: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 36, zIndex: 100,
  },
  container: {
    flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  inner: { width: 460, maxWidth: '100%' },
  wakeScene: {
    alignItems: 'center', gap: spacing.md, marginBottom: spacing.xl, marginTop: spacing.sm,
  },
});
