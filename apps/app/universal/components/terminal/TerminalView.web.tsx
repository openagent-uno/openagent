/**
 * Web / Electron terminal — a real xterm.js surface.
 *
 * xterm and its fit addon are loaded with a dynamic ``import()`` inside
 * the mount effect rather than a top-level import, so they never
 * evaluate on the native side even though the platform dispatcher
 * (``TerminalView.tsx``) references this module. The xterm stylesheet is
 * injected as an inline ``<style>`` (no CSS-file import) for the same
 * reason — Metro's native bundler must never have to resolve a ``.css``.
 *
 * All gateway plumbing lives in ``useTerminalSession``; this file is
 * purely "draw the PTY and forward keystrokes".
 */

import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTerminalSession } from './useTerminalSession';
import type { TerminalViewProps } from './types';

// JARVIS-dark palette tuned for legibility on the near-black canvas.
const XTERM_THEME = {
  background: '#050810',
  foreground: '#EEF4FB',
  cursor: '#3FC8FF',
  cursorAccent: '#050810',
  selectionBackground: 'rgba(63, 200, 255, 0.30)',
  black: '#1C2330',
  red: '#FF6B7A',
  green: '#3FE0A0',
  yellow: '#F7B254',
  blue: '#3FC8FF',
  magenta: '#A78BFF',
  cyan: '#5FD2FF',
  white: '#C8D3E0',
  brightBlack: '#5A6878',
  brightRed: '#FF8A96',
  brightGreen: '#6FF0B8',
  brightYellow: '#FFC97A',
  brightBlue: '#7FE0FF',
  brightMagenta: '#C4B0FF',
  brightCyan: '#8AE2FF',
  brightWhite: '#EEF4FB',
};

// The official xterm v5 stylesheet, inlined so we never import a .css
// file (which the native bundler can't parse).
const XTERM_CSS = `.xterm{cursor:text;position:relative;user-select:none;-ms-user-select:none;-webkit-user-select:none}.xterm.focus,.xterm:focus{outline:none}.xterm .xterm-helpers{position:absolute;top:0;z-index:5}.xterm .xterm-helper-textarea{padding:0;border:0;margin:0;position:absolute;opacity:0;left:-9999em;top:0;width:0;height:0;z-index:-5;white-space:nowrap;overflow:hidden;resize:none}.xterm .composition-view{background:#000;color:#FFF;display:none;position:absolute;white-space:nowrap;z-index:1}.xterm .composition-view.active{display:block}.xterm .xterm-viewport{background-color:#000;overflow-y:scroll;cursor:default;position:absolute;right:0;left:0;top:0;bottom:0}.xterm .xterm-screen{position:relative}.xterm .xterm-screen canvas{position:absolute;left:0;top:0}.xterm .xterm-scroll-area{visibility:hidden}.xterm-char-measure-element{display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;line-height:normal}.xterm.enable-mouse-events{user-select:none;-webkit-user-select:none;-ms-user-select:none}.xterm.xterm-cursor-pointer,.xterm .xterm-cursor-pointer{cursor:pointer}.xterm.column-select.focus{cursor:crosshair}.xterm .xterm-accessibility:not(.debug),.xterm .xterm-message{position:absolute;left:0;top:0;bottom:0;right:0;z-index:10;color:transparent;pointer-events:none}.xterm .xterm-accessibility-tree:not(.debug) *::selection{color:transparent}.xterm .xterm-accessibility-tree{user-select:text;white-space:pre}.xterm .live-region{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.xterm-dim{opacity:1!important}.xterm-underline-1{text-decoration:underline}.xterm-underline-2{text-decoration:double underline}.xterm-underline-3{text-decoration:wavy underline}.xterm-underline-4{text-decoration:dotted underline}.xterm-underline-5{text-decoration:dashed underline}.xterm-overline{text-decoration:overline}.xterm-overline.xterm-underline-1{text-decoration:overline underline}.xterm-overline.xterm-underline-2{text-decoration:overline double underline}.xterm-overline.xterm-underline-3{text-decoration:overline wavy underline}.xterm-overline.xterm-underline-4{text-decoration:overline dotted underline}.xterm-overline.xterm-underline-5{text-decoration:overline dashed underline}.xterm-strikethrough{text-decoration:line-through}.xterm-screen .xterm-decoration-container .xterm-decoration{z-index:6;position:absolute}.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer{z-index:7}.xterm-decoration-overview-ruler{z-index:8;position:absolute;top:0;right:0;pointer-events:none}.xterm-decoration-top{z-index:2;position:relative}`;

function injectCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('oa-xterm-css')) return;
  const style = document.createElement('style');
  style.id = 'oa-xterm-css';
  style.textContent = XTERM_CSS;
  document.head.appendChild(style);
}

export default function TerminalViewWeb({
  terminalId,
  cwd,
  shell,
  onStatusChange,
}: TerminalViewProps) {
  const containerRef = useRef<View>(null);
  const session = useTerminalSession(terminalId, { cwd, shell, onStatusChange });
  // The mount effect must reach the *latest* session senders without
  // re-running (which would re-create the xterm instance).
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = containerRef.current as unknown as HTMLElement | null;
    if (!el) return;

    let term: any = null;
    let fit: any = null;
    let ro: ResizeObserver | null = null;
    let disposed = false;

    injectCss();
    void (async () => {
      const [xtermMod, fitMod] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) return;

      // Metro resolves xterm to its CJS ``main`` (package-exports are off
      // repo-wide), so the constructor may land as a named export or under
      // ``default`` depending on interop — accept either.
      const xm = xtermMod as any;
      const fm = fitMod as any;
      const TerminalCtor = xm.Terminal || xm.default?.Terminal;
      const FitAddonCtor = fm.FitAddon || fm.default?.FitAddon;
      if (!TerminalCtor || !FitAddonCtor) {
        onStatusChange?.('error', 'failed to load terminal renderer');
        return;
      }

      term = new TerminalCtor({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.1,
        theme: XTERM_THEME,
        scrollback: 8000,
        macOptionIsMeta: true,
      });
      fit = new FitAddonCtor();
      term.loadAddon(fit);
      term.open(el);
      try {
        fit.fit();
      } catch {
        /* container not measured yet — defaults below cover it */
      }

      // Render output, then announce our geometry and open the PTY.
      sessionRef.current.onOutput((bytes) => {
        if (disposed) return;
        try {
          term.write(bytes);
        } catch {
          /* writes can race a dispose during teardown */
        }
      });
      sessionRef.current.open(term.cols || 80, term.rows || 24);
      term.onData((data: string) => sessionRef.current.input(data));
      term.focus();

      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
          if (disposed || !fit || !term) return;
          try {
            fit.fit();
            sessionRef.current.resize(term.cols, term.rows);
          } catch {
            /* ignore transient measure errors */
          }
        });
        ro.observe(el);
      }
    })();

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
      try {
        term?.dispose();
      } catch {
        /* ignore */
      }
    };
  }, [terminalId]);

  return <View ref={containerRef} style={styles.container} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050810',
    padding: 6,
    // @ts-ignore web-only — keeps the canvas from forcing page scroll.
    overflow: 'hidden',
  },
});
