import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

const SIZE = 512;
const MAX_PIXELS = 32_000_000;

export async function pickAgentThumbnail(): Promise<string | undefined> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
  if (result.canceled) return undefined;
  const { uri, width, height } = result.assets[0];
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('Choose a smaller image.');
  const edge = Math.min(width, height);
  if (Platform.OS === 'web') {
    const image = new window.Image();
    image.src = uri;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the thumbnail.');
    context.fillStyle = '#181b23';
    context.fillRect(0, 0, SIZE, SIZE);
    context.drawImage(image, (width - edge) / 2, (height - edge) / 2, edge, edge, 0, 0, SIZE, SIZE);
    return canvas.toDataURL('image/jpeg', 0.84);
  }
  const editor = ImageManipulator.manipulate(uri);
  editor.crop({
    originX: Math.floor((width - edge) / 2),
    originY: Math.floor((height - edge) / 2),
    width: edge,
    height: edge,
  }).resize({ width: SIZE, height: SIZE });
  const image = await editor.renderAsync();
  const normalized = await image.saveAsync({ compress: 0.84, format: SaveFormat.JPEG, base64: true });
  if (!normalized.base64) throw new Error('Could not prepare the thumbnail.');
  return `data:image/jpeg;base64,${normalized.base64}`;
}
