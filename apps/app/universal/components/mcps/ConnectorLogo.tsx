import { useId, useMemo } from 'react';
import { Image, View, type ImageSourcePropType } from 'react-native';
import { SvgXml } from 'react-native-svg';
import Feather from '@expo/vector-icons/Feather';
import { colors } from '../../theme';
import { connectorVectors } from './connector-vectors';

// Bundled provider marks shared by connector cards; no remote fetches.
const images: Readonly<Record<string, ImageSourcePropType>> = {
  replio: require('../../assets/connectors/replio.png'),
  billingbear: require('../../assets/connectors/billingbear.png'),
  pipeboard: require('../../assets/connectors/pipeboard.png'),
  github: require('../../assets/connectors/github.png'),
  atlassian: require('../../assets/connectors/atlassian.png'),
  notion: require('../../assets/connectors/notion.png'),
  'slack-import': require('../../assets/connectors/slack-import.png'),
  shopify: require('../../assets/connectors/shopify.png'),
};

function scaleAndScope(xml: string, prefix: string) {
  const open = xml.match(/<svg\b[^>]*>/i);
  if (open && !/\bviewBox\s*=/i.test(open[0])) {
    const width = open[0].match(/\bwidth\s*=\s*"([0-9.]+)(?:px)?"/i)?.[1];
    const height = open[0].match(/\bheight\s*=\s*"([0-9.]+)(?:px)?"/i)?.[1];
    if (width && height) xml = xml.replace(open[0], open[0].replace(/<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`));
  }
  return xml.replace(/id="([^"]+)"/g, `id="${prefix}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`).replace(/(href=")#([^"]+)"/g, `$1#${prefix}-$2"`);
}

export default function ConnectorLogo({ id, size = 32 }: { id: string; size?: number }) {
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const vector = useMemo(() => connectorVectors[id] ? scaleAndScope(connectorVectors[id], prefix) : undefined, [id, prefix]);
  return <View accessible={false} style={{ width: size + 12, height: size + 12, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: id === 'postiz' ? '#1A1A1A' : colors.sidebar }}>
    {vector ? <SvgXml xml={vector} width={size} height={size} /> : images[id] ? <Image source={images[id]} resizeMode="contain" style={{ width: size, height: size }} /> : <Feather name={id === 'imap_smtp' ? 'mail' : 'link-2'} color={colors.primary} size={size * 0.65} />}
  </View>;
}
