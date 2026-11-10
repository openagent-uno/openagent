import { Text } from 'react-native';
import { colors } from '../../theme';

export type InteractiveDashboardProps = {
  viewId: string;
  revision: number;
  source: string;
  assets: string[];
  title: string;
  height?: number;
  data: Record<string, unknown>;
  canRun: boolean;
  run: (action: string, input: unknown) => Promise<unknown> | undefined;
};

export default function InteractiveDashboard(_props: InteractiveDashboardProps) {
  return <Text style={{ color: colors.textMuted }}>Open this interactive dashboard in the desktop app.</Text>;
}
