import React from 'react';
import { View, Platform } from 'react-native';
import type { ViewProps } from 'react-native';
import { getThemeMode } from '../theme';

interface Props extends ViewProps {
  intensity?: number;
  children: React.ReactNode;
}

export default function BlurView({ intensity = 2, style, children, ...props }: Props) {
  if (Platform.OS === 'web') {
    return (
      <View
        style={[style, {
          backdropFilter: `blur(${intensity}px) saturate(140%)`,
          WebkitBackdropFilter: `blur(${intensity}px) saturate(140%)`,
        } as any]}
        {...props}
      >
        {children}
      </View>
    );
  }

  const { BlurView: ExpoBlurView } = require('expo-blur');
  const nativeIntensity = Math.min(100, Math.max(1, Math.round(intensity * 5)));
  const tint = getThemeMode() === 'light' ? 'light' : 'dark';
  return (
    <ExpoBlurView intensity={nativeIntensity} tint={tint} style={style as any} {...props}>
      {children}
    </ExpoBlurView>
  );
}
