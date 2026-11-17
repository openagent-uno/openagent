import Feather from '@expo/vector-icons/Feather';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { providerMarks } from './providerMarks';
import { colors } from '../../theme';
/** Uses the app's icon library for adapters without a bundled brand mark. */
export default function ProviderMark({ vendor, access }: { vendor: string; access: string }) {
  const key = access === "subscription" && vendor === "anthropic" ? "claude" : vendor === "local" ? "ollama" : vendor;
  const vector = providerMarks[key];
  return <View accessible={false} style={{ width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: '#F5F5F5' }}>
    <>{vector ? <SvgXml xml={vector} width={27} height={27} color="#111111" /> : <Feather name={access === 'local' ? 'server' : access === 'subscription' ? 'user' : 'cpu'} size={23} color={colors.primary} />}</>
  </View>;
}
