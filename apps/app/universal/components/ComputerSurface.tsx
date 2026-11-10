import type { ReactNode } from 'react';
import { useMemo, useRef } from 'react';
import { Image, PanResponder, TextInput, View } from 'react-native';
import type { ComputerAction, ComputerFrame } from '../../common/devices';
import { screenCoordinate } from '../../common/devices';

type Input = { coordinate?: [number, number]; text?: string };
export interface ComputerSurfaceProps { children?: ReactNode; frame: ComputerFrame; width: number; label: string; readOnly?: boolean; send: (action: ComputerAction, input?: Input) => Promise<boolean> }

/** Native input capture stays invisible; the screen itself owns all gestures. */
function InteractiveComputerSurface({ frame, width, label, send, children }: ComputerSurfaceProps) {
  const keyboard = useRef<TextInput>(null);
  const start = useRef({ x: 0, y: 0, at: 0 });
  const current = useRef({ frame, width, send }); current.current = { frame, width, send };
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: event => { start.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY, at: Date.now() }; },
    onPanResponderRelease: (_event, gesture) => {
      const { frame: image, width: displayed, send: input } = current.current;
      const from = screenCoordinate(start.current.x, start.current.y, displayed, image);
      const to = screenCoordinate(start.current.x + gesture.dx, start.current.y + gesture.dy, displayed, image);
      if (Math.hypot(gesture.dx, gesture.dy) > 5) {
        void input('mouse_move', { coordinate: from }); void input('left_click_drag', { coordinate: to });
      } else { void input(Date.now() - start.current.at > 600 ? 'right_click' : 'left_click', { coordinate: to }); keyboard.current?.focus(); }
    },
  }), []);
  return <View accessibilityLabel={`Control ${label}. Click and type on the desktop.`} {...responder.panHandlers} style={{ width, height: width * frame.height / frame.width }}>
    {children || <Image source={{ uri: frame.uri }} style={{ width: '100%', height: '100%' }} />}
    <TextInput ref={keyboard} value="" autoCorrect={false} autoCapitalize="none" caretHidden
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
      onChangeText={text => { if (text) void current.current.send('type', { text }); }}
      onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === 'Backspace' || nativeEvent.key === 'Enter') void current.current.send('key', { text: nativeEvent.key === 'Enter' ? 'Return' : 'BackSpace' }); }} />
  </View>;
}

export default function ComputerSurface(props: ComputerSurfaceProps) {
  if (!props.readOnly) return <InteractiveComputerSurface {...props} />;
  const { frame, width, label, children } = props;
  return <View accessible accessibilityRole="image" accessibilityLabel={`View ${label}`}
    style={{ width, height: width * frame.height / frame.width }}>
    {children || <Image source={{ uri: frame.uri }} style={{ width: '100%', height: '100%' }} />}
  </View>;
}
