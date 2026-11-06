import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { ComputerAction, ComputerFrame, ComputerTarget } from '../../common/devices';
import ComputerSurface from './ComputerSurface';
import ComputerMedia from './ComputerMedia';
import { computerFrame } from '../../common/devices';
import { interactWithComputer } from '../services/api';
import { colors, radius } from '../theme';

type QueuedInput = {
  action: ComputerAction;
  input: { coordinate?: [number, number]; text?: string };
  started: boolean;
  promise: Promise<boolean>;
};

/** One exact computer per mounted view. Closing aborts reads and stops polling. */
export default function ComputerView({ sessionId, target, onClose }: { sessionId: string; target: ComputerTarget; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const live = Platform.OS === 'web' && target.live_media === 'openagent-video/1';
  const [frame, setFrame] = useState<ComputerFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const lock = useRef(false);
  const queue = useRef(Promise.resolve());
  const lastQueuedInput = useRef<QueuedInput | null>(null);
  const pending = useRef(0);
  const failed = useRef(false);
  const alive = useRef(true);
  const controller = useRef(new AbortController());
  const pausedRef = useRef(false);
  const perform = useCallback((action: ComputerAction, input: { coordinate?: [number, number]; text?: string } = {}): Promise<boolean> => {
    if (!alive.current || (action === 'get_screenshot' && (lock.current || pending.current > 0))) return Promise.resolve(false);
    const previous = lastQueuedInput.current;
    // Preserve every character while a slow exact-device call is in flight.
    // Merge only consecutive, not-yet-started text operations; pointer/key
    // operations keep their ordering and dispatched mutations are never replayed.
    if (action === 'type' && typeof input.text === 'string' && previous?.action === 'type'
        && !previous.started && (previous.input.text?.length || 0) + input.text.length <= 16384) {
      previous.input.text = (previous.input.text || '') + input.text;
      return previous.promise;
    }
    if (pending.current >= 64) return Promise.resolve(false);
    const task: QueuedInput = { action, input: { ...input }, started: false, promise: Promise.resolve(false) };
    pending.current++;
    const operation = async () => {
      task.started = true;
      if (!alive.current || (failed.current && action !== 'get_screenshot')) { pending.current--; return false; }
      lock.current = true; setBusy(true);
      try {
        const result = await interactWithComputer(sessionId, target.tool_ref, action, task.input, controller.current.signal);
        if (!alive.current) return false;
        const next = computerFrame(result);
        if (next) setFrame(next);
        setError(null);
        failed.current = false;
        if (!live && action !== 'get_screenshot' && action !== 'mouse_move' && pending.current === 1) {
          const refresh = await interactWithComputer(sessionId, target.tool_ref, 'get_screenshot', {}, controller.current.signal);
          if (alive.current) { const screenshot = computerFrame(refresh); if (screenshot) setFrame(screenshot); }
        }
        return true;
      } catch (e) {
        if (alive.current) {
          setError(e instanceof Error ? e.message : 'Computer unavailable');
          // Stop on failure; mutations are never retried and another device is never substituted.
          pausedRef.current = true; setPaused(true);
          failed.current = true;
        }
        return false;
      } finally { pending.current--; lock.current = false; if (alive.current) setBusy(false); }
    };
    const result = queue.current.then(operation);
    task.promise = result;
    lastQueuedInput.current = task;
    queue.current = result.then(() => {}, () => {});
    return result;
  }, [sessionId, target.tool_ref, live]);

  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!pausedRef.current && (Platform.OS !== 'web' || !document.hidden)) await perform('get_screenshot');
      if (alive.current) timer = setTimeout(refresh, 500);
    };
    if (!live) void refresh();
    return () => {
      alive.current = false; controller.current.abort(); clearTimeout(timer);
    };
  }, [perform, live]);

  const mediaError = useCallback((message:string) => {setError(message);setPaused(true);pausedRef.current=true;failed.current=true;},[]);
  const mediaFrame = useCallback((next:ComputerFrame) => {setFrame(next);setError(null);failed.current=false;},[]);
  const displayWidth = Math.max(1, Math.min(width - 56, 1040, frame ? Math.max(80, height - 160) * frame.width / frame.height : 800));
  const button = (label: string, action: () => void, disabled = false) => <Pressable key={label} onPress={action} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
    style={{ padding: 9, borderRadius: radius.sm, backgroundColor: colors.surface, opacity: disabled ? 0.45 : 1 }}><Text style={{ color: colors.text, fontSize: 12 }}>{label}</Text></Pressable>;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: width < 600 ? 8 : 20 }}>
      <View accessibilityViewIsModal style={{ width: '100%', maxWidth: 1100, maxHeight: '100%', borderRadius: radius.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Feather name="monitor" size={18} color={colors.accent} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontWeight: '600' }}>{target.label}</Text>
          {busy && <ActivityIndicator size="small" color={colors.accent} />}
          {button(paused ? 'Resume view' : 'Pause view', () => { pausedRef.current = !paused; setPaused(!paused); })}
          {button('Close', onClose)}
        </View>
        <ScrollView contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled">
          {error && <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text>}
          <View style={{ alignItems: 'center' }}>
            {live ? <ComputerMedia sessionId={sessionId} target={target} width={displayWidth} paused={paused} send={perform} onFrame={mediaFrame} onError={mediaError} />
              : frame ? <ComputerSurface frame={frame} width={displayWidth} label={target.label} send={perform} />
              : <Text style={{ color: colors.textMuted, padding: 32 }}>{busy ? 'Connecting to computer…' : 'Screen unavailable'}</Text>}
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 11 }}>Click the desktop to control it. Your keyboard and pointer operate this computer.</Text>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}
