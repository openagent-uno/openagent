/**
 * UI preferences — small, persisted client-side toggles that aren't tied to
 * a session or the server. Currently just the context-window panel's
 * visibility, controlled from the chat header's overflow menu and the
 * scheduled-run screen. Persisted to localStorage on web (native keeps it in
 * memory, which is fine for a session-scoped toggle).
 */

import { create } from 'zustand';

const STORAGE_KEY = 'oa.ui.prefs';

interface UiPrefs {
  /** Whether the always-visible context-window panel is shown. Default on. */
  contextPanelVisible: boolean;
}

const DEFAULTS: UiPrefs = { contextPanelVisible: true };

function loadPrefs(): UiPrefs {
  if (typeof window === 'undefined' || !window.localStorage) return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function savePrefs(prefs: UiPrefs): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // quota exceeded / private mode — ignore
  }
}

interface UiState extends UiPrefs {
  toggleContextPanel: () => void;
  setContextPanelVisible: (visible: boolean) => void;
}

export const useUI = create<UiState>((set, get) => ({
  ...loadPrefs(),
  toggleContextPanel: () => {
    const next = !get().contextPanelVisible;
    set({ contextPanelVisible: next });
    savePrefs({ contextPanelVisible: next });
  },
  setContextPanelVisible: (visible) => {
    set({ contextPanelVisible: visible });
    savePrefs({ contextPanelVisible: visible });
  },
}));
