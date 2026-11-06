import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ComputerAction, ComputerFrame } from '../../common/devices';
import { screenCoordinate } from '../../common/devices';

type Input = { coordinate?: [number, number]; text?: string };
export interface ComputerSurfaceProps { children?: ReactNode; frame: ComputerFrame; width: number; label: string; send: (action: ComputerAction, input?: Input) => Promise<boolean> }

/** Native pointer/keyboard events over the image. No visible input controls. */
export default function ComputerSurface({ frame, width, label, send, children }: ComputerSurfaceProps) {
  const surface = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const focusClaimUntil = useRef(0);
  useLayoutEffect(() => {
    const element = surface.current;
    // A newly opened Modal may complete its initial focus restoration just
    // after the user's first click. Keep that click's keyboard claim through
    // the opening transition, without trapping deliberate outside interaction.
    const reclaim = (event: FocusEvent) => {
      if (performance.now() < focusClaimUntil.current && !element?.contains(event.target as Node))
        keyboard.current?.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      if (!element?.contains(event.target as Node)) focusClaimUntil.current = 0;
    };
    const release = () => { focusClaimUntil.current = 0; };
    document.addEventListener('focusin', reclaim);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', release);
    return () => {
      focusClaimUntil.current = 0;
      document.removeEventListener('focusin', reclaim);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', release);
    };
  }, []);
  const down = useRef<{ x: number; y: number; at: number; button: number } | null>(null);
  const click = useRef<{ timer: ReturnType<typeof setTimeout>; xy: [number, number]; at: number } | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverPoint = useRef<[number, number]>([0, 0]);
  const sendRef = useRef(send); sendRef.current = send;
  const frameRef = useRef(frame); frameRef.current = frame;
  const coordinate = (event: { clientX: number; clientY: number }) => {
    const rect = surface.current!.getBoundingClientRect();
    return screenCoordinate(event.clientX - rect.left, event.clientY - rect.top, rect.width, frameRef.current);
  };
  useEffect(() => {
    const element = surface.current;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    let deltaX = 0, deltaY = 0, xy: [number, number] = [0, 0];
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const rect = element!.getBoundingClientRect();
      xy = screenCoordinate(event.clientX - rect.left, event.clientY - rect.top, rect.width, frameRef.current);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      deltaX += event.deltaX * unit; deltaY += event.deltaY * unit;
      if (wheelTimer) return;
      wheelTimer = setTimeout(() => {
        const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
        const delta = horizontal ? deltaX : deltaY;
        const direction = horizontal ? delta > 0 ? 'right' : 'left' : delta > 0 ? 'down' : 'up';
        void sendRef.current('scroll', { coordinate: xy, text: `${direction}:${Math.max(1, Math.min(3000, Math.round(Math.abs(delta))))}` });
        deltaX = 0; deltaY = 0; wheelTimer = undefined;
      }, 80);
    };
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => { element?.removeEventListener('wheel', wheel); clearTimeout(wheelTimer); clearTimeout(hover.current); if (click.current) clearTimeout(click.current.timer); };
  }, []);
  const flushClick = () => {
    const pending = click.current;
    if (pending) { clearTimeout(pending.timer); click.current = null; void sendRef.current('left_click', { coordinate: pending.xy }); }
  };
  return <div ref={surface} role="application" aria-label={`Control ${label}. Click and type on the desktop.`} tabIndex={0}
    style={{ position: 'relative', width, height: width * frame.height / frame.width, outline: 'none', overflow: 'hidden', touchAction: 'none', cursor: 'default', userSelect: 'none' }}
    onContextMenu={event => event.preventDefault()}
    onPointerDown={event => {
      clearTimeout(hover.current); hover.current = undefined;
      focusClaimUntil.current = performance.now() + 500;
      event.preventDefault(); keyboard.current?.focus({ preventScroll: true });
      const [x, y] = coordinate(event);
      down.current = { x, y, at: Date.now(), button: event.button };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { down.current = null; }}
    onPointerMove={event => {
      if (down.current || event.pointerType !== 'mouse') return;
      hoverPoint.current = coordinate(event);
      if (hover.current) return;
      hover.current = setTimeout(() => { hover.current = undefined; void sendRef.current('mouse_move', { coordinate: hoverPoint.current }); }, 100);
    }}
    onPointerUp={event => {
      const start = down.current; down.current = null;
      if (!start) return;
      const xy = coordinate(event);
      if (Math.hypot(xy[0] - start.x, xy[1] - start.y) * width / frame.width > 5 && start.button === 0) {
        flushClick();
        void send('mouse_move', { coordinate: [start.x, start.y] });
        void send('left_click_drag', { coordinate: xy });
      } else if (start.button === 2 || event.pointerType === 'touch' && Date.now() - start.at > 600) {
        flushClick(); void send('right_click', { coordinate: xy });
      } else if (start.button === 1) {
        flushClick(); void send('middle_click', { coordinate: xy });
      } else {
        const pending = click.current;
        if (pending && Date.now() - pending.at < 350 && Math.hypot(xy[0] - pending.xy[0], xy[1] - pending.xy[1]) < 8) {
          clearTimeout(pending.timer); click.current = null; void send('double_click', { coordinate: xy });
        } else {
          flushClick();
          click.current = { xy, at: Date.now(), timer: setTimeout(flushClick, 300) };
        }
      }
    }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      flushClick();
      // Let the local browser produce its paste event with clipboard text.
      // Sending Ctrl/Command+V to the remote OS uses that OS's unrelated clipboard.
      if (((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v')
          || (event.shiftKey && event.key === 'Insert')) {
        event.stopPropagation(); return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.target !== keyboard.current) { event.preventDefault(); void send('type', { text: event.key }); }
        event.stopPropagation(); return;
      }
      event.preventDefault(); event.stopPropagation();
      const keys: Record<string, string> = { Enter: 'Return', Backspace: 'BackSpace', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'space' };
      // The modifier already carries Shift. Sending an uppercase Unicode key
      // as well can make the remote keyboard synthesize a different chord.
      const key = /^[A-Z]$/.test(event.key) ? event.key.toLowerCase() : keys[event.key] || event.key;
      void send('key', { text: [event.ctrlKey && 'ctrl', event.metaKey && 'super', event.altKey && 'alt', event.shiftKey && 'shift', key].filter(Boolean).join('+') });
    }}
    onKeyUp={event => {
      // React Native Web dismisses Modals from a document keyup listener.
      // Escape belongs to the focused remote desktop, just like keydown.
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
    }}
    onPaste={event => { event.preventDefault(); flushClick(); const text = event.clipboardData.getData('text/plain'); if (text) void send('type', { text }); }}>
    {children || <img src={frame.uri} alt="" draggable={false} style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none' }} />}
    <textarea ref={keyboard} tabIndex={-1} aria-label="Remote keyboard capture" autoCapitalize="off" autoCorrect="off" spellCheck={false}
      style={{ position: 'absolute', width: 1, height: 1, padding: 0, border: 0, opacity: 0, pointerEvents: 'none', left: 0, top: 0 }}
      onInput={event => { if ((event.nativeEvent as InputEvent).isComposing) return; const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) void send('type', { text }); }}
      onCompositionEnd={event => { const text = event.currentTarget.value; event.currentTarget.value = ''; if (text) void send('type', { text }); }} />
  </div>;
}
