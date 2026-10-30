import { Text, View } from 'react-native';
import type { McpAppSurfaceProps } from '../services/mcp-apps';
export default function McpAppSurface(_props: McpAppSurfaceProps) {
  return <View style={{ marginTop: 8 }}><Text>Open this interactive tool in the desktop or web app. Its text result remains available here.</Text></View>;
}
