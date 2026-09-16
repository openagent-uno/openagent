/**
 * The WebSocket plumbing behind a single terminal, shared by the web
 * (xterm.js) and native render variants.
 *
 * It binds to the active gateway WebSocket, filters ``terminal_*``
 * frames down to one ``terminalId``, decodes output bytes, and exposes
 * imperative ``open`` / ``input`` / ``resize`` / ``signal`` senders. The
 * actual renderer registers an output sink via ``onOutput`` and calls
 * ``open(cols, rows)`` once it knows its geometry.
 *
 * In the Electron multi-window setup the detached terminal window's ws
 * is an IPC relay through the primary window — these frames travel the
 * exact same path as chat, so nothing here needs to know whether it's
 * the primary or a child.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '../../../common/types';
import { useConnection } from '../../stores/connection';
import { base64ToBytes, stringToBase64 } from './encoding';
import type { TerminalStatus } from './types';

export interface TerminalSession {
  status: TerminalStatus;
  /** Send the open frame with the measured geometry. Idempotent. */
  open: (cols: number, rows: number) => void;
  /** Forward a keystroke string (UTF-8) to the PTY. */
  input: (data: string) => void;
  /** Reflow after a resize. */
  resize: (cols: number, rows: number) => void;
  /** Deliver a signal (e.g. INT for Ctrl-C from a toolbar button). */
  signal: (name?: 'INT' | 'TERM' | 'HUP' | 'QUIT' | 'KILL') => void;
  /** Register the sink that receives decoded output bytes. */
  onOutput: (cb: (bytes: Uint8Array) => void) => void;
  /** True once the gateway ws exists and we can send. */
  ready: boolean;
}

export function useTerminalSession(
  terminalId: string,
  opts: { cwd?: string; shell?: string; onStatusChange?: (s: TerminalStatus, detail?: string) => void } = {},
): TerminalSession {
  const ws = useConnection((s) => s.ws);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const outputRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const openedRef = useRef(false);
  // Buffer output that arrives before the renderer has registered its
  // sink (xterm needs a tick to mount) so the first prompt is never lost.
  const pendingRef = useRef<Uint8Array[]>([]);
  const statusCbRef = useRef(opts.onStatusChange);
  statusCbRef.current = opts.onStatusChange;

  const setStatusBoth = useCallback((s: TerminalStatus, detail?: string) => {
    setStatus(s);
    statusCbRef.current?.(s, detail);
  }, []);

  useEffect(() => {
    if (!ws) {
      setStatus('connecting');
      return;
    }
    const off = ws.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'terminal_output':
          if (msg.terminal_id !== terminalId) return;
          {
            const bytes = base64ToBytes(msg.data);
            if (outputRef.current) outputRef.current(bytes);
            else pendingRef.current.push(bytes);
          }
          return;
        case 'terminal_ready':
          if (msg.terminal_id !== terminalId) return;
          setStatusBoth('open');
          return;
        case 'terminal_exit':
          if (msg.terminal_id !== terminalId) return;
          setStatusBoth(
            'exited',
            msg.signal
              ? `exited (signal ${msg.signal})`
              : `exited (code ${msg.exit_code ?? 0})`,
          );
          return;
        case 'terminal_error':
          if (msg.terminal_id !== terminalId) return;
          setStatusBoth('error', msg.error);
          return;
        default:
          return;
      }
    });
    return off;
  }, [ws, terminalId, setStatusBoth]);

  // The renderer (xterm) and the gateway ws can become ready in either
  // order. Stash the measured geometry and fire the open frame as soon
  // as *both* exist — exactly once.
  const geomRef = useRef<{ cols: number; rows: number } | null>(null);

  const tryOpen = useCallback(() => {
    if (openedRef.current || !ws || !geomRef.current) return;
    openedRef.current = true;
    ws.sendTerminalOpen(terminalId, {
      cols: geomRef.current.cols,
      rows: geomRef.current.rows,
      cwd: opts.cwd,
      shell: opts.shell,
    });
  }, [ws, terminalId, opts.cwd, opts.shell]);

  const open = useCallback(
    (cols: number, rows: number) => {
      geomRef.current = { cols, rows };
      tryOpen();
    },
    [tryOpen],
  );

  // Retry once the ws appears (e.g. a detached window still resuming its
  // connection when xterm already mounted).
  useEffect(() => {
    tryOpen();
  }, [tryOpen]);

  const input = useCallback(
    (data: string) => {
      ws?.sendTerminalInput(terminalId, stringToBase64(data));
    },
    [ws, terminalId],
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      ws?.sendTerminalResize(terminalId, cols, rows);
    },
    [ws, terminalId],
  );

  const signal = useCallback(
    (name: 'INT' | 'TERM' | 'HUP' | 'QUIT' | 'KILL' = 'INT') => {
      ws?.sendTerminalSignal(terminalId, name);
    },
    [ws, terminalId],
  );

  const onOutput = useCallback((cb: (bytes: Uint8Array) => void) => {
    outputRef.current = cb;
    // Flush anything buffered before the sink existed.
    if (pendingRef.current.length) {
      const queued = pendingRef.current;
      pendingRef.current = [];
      for (const b of queued) cb(b);
    }
  }, []);

  // Close the PTY when the view unmounts (window closed / navigated away).
  // The gateway also reaps on disconnect, but an explicit close frees the
  // shell immediately instead of waiting for the socket to drop.
  useEffect(() => {
    return () => {
      try {
        useConnection.getState().ws?.sendTerminalClose(terminalId);
      } catch {
        /* ignore */
      }
    };
  }, [terminalId]);

  return { status, open, input, resize, signal, onOutput, ready: !!ws };
}
