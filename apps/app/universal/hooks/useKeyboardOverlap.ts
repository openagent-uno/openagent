/**
 * How many points the iOS software keyboard covers at the bottom of the
 * window, or 0 when it is hidden.
 *
 * Android (Expo's default ``softwareKeyboardLayoutMode: 'resize'``) and the
 * web already shrink the viewport, so they always report 0. A bottom-docked
 * view pads itself by this value to stay above the keyboard; the overlap is
 * measured from the keyboard frame, so a floating or undocked iPad keyboard
 * that does not reach the bottom edge yields 0.
 */
import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform, type KeyboardEvent } from 'react-native';

export function keyboardOverlap(screenY: number, windowHeight: number): number {
  return Math.max(0, Math.round(windowHeight - screenY));
}

export function useKeyboardOverlap(): number {
  const [overlap, setOverlap] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const animate = (e: KeyboardEvent) => {
      if (e.duration > 0) {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
    };
    const onFrame = (e: KeyboardEvent) => {
      animate(e);
      setOverlap(keyboardOverlap(e.endCoordinates.screenY, Dimensions.get('window').height));
    };
    const onHide = (e: KeyboardEvent) => {
      animate(e);
      setOverlap(0);
    };
    const subs = [
      Keyboard.addListener('keyboardWillShow', onFrame),
      Keyboard.addListener('keyboardWillChangeFrame', onFrame),
      Keyboard.addListener('keyboardWillHide', onHide),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  return overlap;
}
