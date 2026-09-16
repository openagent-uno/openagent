/**
 * Terminal registry — the list of PTY shells this device has open on the
 * gateway host, surfaced Termius-style in the System tab.
 *
 * Each shell's actual I/O happens inside its own ``TerminalView`` (its
 * own window on desktop), but the *list* is tracked here so the launcher
 * can show what's running, mark sessions exited, and re-open the picker.
 *
 * The store binds to the active WebSocket and watches ``terminal_ready``
 * / ``terminal_exit`` / ``terminal_error`` frames — in the Electron
 * multi-window setup those all flow over the primary window's socket, so
 * the System tab (which lives in the primary) sees every session's
 * lifecycle even though the shells render in detached windows. It also
 * seeds once from ``GET /api/terminals`` so a freshly-opened app shows
 * shells that were already running.
 */

import { create } from 'zustand';
import type { ServerMessage, TerminalInfo } from '../../common/types';
import { useConnection } from './connection';
import { getTerminals } from '../services/api';

function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).slice(0, 16);
}

interface TerminalsState {
  terminals: TerminalInfo[];
  unbind: (() => void) | null;
  boundWs: unknown;

  /** Bind the WS feed + seed from REST. Idempotent; rebinds on reconnect. */
  start: () => Promise<void>;
  /** Register a new shell and return its id (the caller opens the window). */
  create: (opts?: { cwd?: string; shell?: string; title?: string }) => string;
  /** Ask the gateway to kill a shell; it'll flip to ``exited`` via WS. */
  close: (id: string) => void;
  /** Drop a session row from the list (after it has exited). */
  remove: (id: string) => void;
  /** Drop every exited/errored row, keep the live ones. */
  clearDead: () => void;
}

function patch(list: TerminalInfo[], id: string, fields: Partial<TerminalInfo>): TerminalInfo[] {
  return list.map((t) => (t.id === id ? { ...t, ...fields } : t));
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  terminals: [],
  unbind: null,
  boundWs: null,

  start: async () => {
    const ws = useConnection.getState().ws;
    if (ws !== get().boundWs) {
      get().unbind?.();
      set({ unbind: null, boundWs: null });
    }

    if (ws && get().unbind == null) {
      const off = ws.onMessage((msg: ServerMessage) => {
        if (msg.type === 'terminal_ready') {
          const exists = get().terminals.some((t) => t.id === msg.terminal_id);
          if (exists) {
            set({
              terminals: patch(get().terminals, msg.terminal_id, {
                status: 'running',
                pid: msg.pid,
                shell: msg.shell,
                cwd: msg.cwd,
              }),
            });
          } else {
            // A shell opened by another window we hadn't registered yet.
            set({
              terminals: [
                ...get().terminals,
                {
                  id: msg.terminal_id,
                  title: shortTitle(msg.shell, get().terminals.length),
                  status: 'running',
                  pid: msg.pid,
                  shell: msg.shell,
                  cwd: msg.cwd,
                  createdAt: Date.now(),
                },
              ],
            });
          }
        } else if (msg.type === 'terminal_exit') {
          set({
            terminals: patch(get().terminals, msg.terminal_id, {
              status: 'exited',
              detail: msg.signal
                ? `exited (signal ${msg.signal})`
                : `exited (code ${msg.exit_code ?? 0})`,
            }),
          });
        } else if (msg.type === 'terminal_error') {
          set({
            terminals: patch(get().terminals, msg.terminal_id, {
              status: 'error',
              detail: msg.error,
            }),
          });
        }
      });
      set({ unbind: off, boundWs: ws });
    }

    // Seed from REST so already-running shells appear on first paint.
    try {
      const raw = await getTerminals();
      if (raw.length) {
        const known = new Set(get().terminals.map((t) => t.id));
        const seeded: TerminalInfo[] = raw
          .filter((r) => !known.has(r.terminal_id))
          .map((r, i) => ({
            id: r.terminal_id,
            title: shortTitle(r.shell, get().terminals.length + i),
            status: r.running ? 'running' : 'exited',
            pid: r.pid,
            shell: r.shell,
            cwd: r.cwd,
            createdAt: Date.now(),
          }));
        if (seeded.length) set({ terminals: [...get().terminals, ...seeded] });
      }
    } catch {
      /* gateway not serving yet — the WS feed will catch up */
    }
  },

  create: (opts) => {
    const id = genId();
    const entry: TerminalInfo = {
      id,
      title: opts?.title || shortTitle(opts?.shell, get().terminals.length),
      status: 'pending',
      shell: opts?.shell,
      cwd: opts?.cwd,
      createdAt: Date.now(),
    };
    set({ terminals: [...get().terminals, entry] });
    return id;
  },

  close: (id) => {
    try {
      useConnection.getState().ws?.sendTerminalClose(id);
    } catch {
      /* ignore */
    }
    set({ terminals: patch(get().terminals, id, { status: 'exited' }) });
  },

  remove: (id) => {
    set({ terminals: get().terminals.filter((t) => t.id !== id) });
  },

  clearDead: () => {
    set({ terminals: get().terminals.filter((t) => t.status === 'running' || t.status === 'pending') });
  },
}));

function shortTitle(shell: string | undefined, index: number): string {
  const base = shell ? shell.split('/').pop() || 'shell' : 'shell';
  return `${base} ${index + 1}`;
}
