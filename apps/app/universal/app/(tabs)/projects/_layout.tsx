import { Stack } from 'expo-router';
import { themedHeader, HeaderMenu, HeaderMenuAndBack } from '../../../components/screenHeader';

export const unstable_settings = { initialRouteName: 'index' };

export default function ProjectLayout() {
  return <Stack screenOptions={{ ...themedHeader, headerLeft: () => <HeaderMenuAndBack fallback="/(tabs)/projects" /> }}>
    <Stack.Screen name="index" options={{ title: 'Projects', headerLeft: () => <HeaderMenu /> }} />
    <Stack.Screen name="[id]" options={{ title: 'Project task' }} />
  </Stack>;
}
