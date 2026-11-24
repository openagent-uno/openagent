import { Image, Text } from 'react-native';
import type { ProjectPreviewFrame } from '../services/api';
import { colors } from '../theme';

export default function ProjectPreview({ frame }: { frame: ProjectPreviewFrame }) {
  if (frame.mime === 'image/png') return <Image accessibilityLabel="Project preview"
    source={{ uri: 'data:image/png;base64,' + frame.data }} resizeMode="contain" style={{ width: '100%', height: 320 }} />;
  return <Text style={{color: colors.textMuted}}>Open the HTML preview in the desktop or web app.</Text>;
}
