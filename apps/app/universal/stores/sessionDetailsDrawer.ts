/**
 * Cross-navigator request bridge for the right session-details drawer.
 *
 * Chat/run headers are owned above their route content, while the details
 * drawer is nested inside that content. Keeping requests in a tiny store avoids
 * brittle parent/child navigator chains and lets every header use the same
 * symmetric button.
 */

import { create } from 'zustand';

export type SessionDetailsRunKind = 'workflow' | 'task' | 'event';

export interface SessionDetailsRunTarget {
  kind: SessionDetailsRunKind;
  runId: string;
  parentId?: string;
  name?: string;
  sessionId?: string;
}

interface SessionDetailsDrawerState {
  toggleRequested: number;
  closeRequested: number;
  isOpen: boolean;
  /** Present only while the shared /runs/[id] route is focused. Otherwise the
   *  drawer derives its content from the active chat session. */
  runTarget: SessionDetailsRunTarget | null;
  requestToggle: () => void;
  requestClose: () => void;
  setOpen: (open: boolean) => void;
  setRunTarget: (target: SessionDetailsRunTarget) => void;
  clearRunTarget: (runId: string) => void;
}

export const useSessionDetailsDrawer = create<SessionDetailsDrawerState>((set) => ({
  toggleRequested: 0,
  closeRequested: 0,
  isOpen: false,
  runTarget: null,
  requestToggle: () => set((state) => ({
    toggleRequested: state.toggleRequested + 1,
    // Optimistic so content mounts before the drawer's opening animation;
    // the navigator bridge reconciles this with the authoritative status.
    isOpen: !state.isOpen,
  })),
  requestClose: () => set((state) => (
    state.isOpen
      ? { closeRequested: state.closeRequested + 1, isOpen: false }
      : state
  )),
  setOpen: (isOpen) => set({ isOpen }),
  setRunTarget: (runTarget) => set({ runTarget }),
  clearRunTarget: (runId) => set((state) => (
    state.runTarget?.runId === runId ? { runTarget: null } : state
  )),
}));
