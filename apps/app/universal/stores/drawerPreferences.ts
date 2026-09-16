/** Persisted, device-local widths for the two desktop app-shell drawers. */

import { create } from 'zustand';
import {
  NAVIGATION_DRAWER_DEFAULT_WIDTH,
  SESSION_DETAILS_DRAWER_DEFAULT_WIDTH,
  clampDrawerWidth,
  hardDrawerWidthBounds,
} from '../../common/drawer-resize';

const STORAGE_KEY = 'oa.drawer-widths.v1';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

interface DrawerPreferences {
  navigationWidth: number;
  sessionDetailsWidth: number;
}

interface DrawerPreferencesState extends DrawerPreferences {
  setNavigationWidth: (width: number) => void;
  setSessionDetailsWidth: (width: number) => void;
}

const DEFAULTS: DrawerPreferences = {
  navigationWidth: NAVIGATION_DRAWER_DEFAULT_WIDTH,
  sessionDetailsWidth: SESSION_DETAILS_DRAWER_DEFAULT_WIDTH,
};

function sanitize(raw?: Partial<DrawerPreferences> | null): DrawerPreferences {
  return {
    navigationWidth: clampDrawerWidth(
      Number(raw?.navigationWidth ?? DEFAULTS.navigationWidth),
      hardDrawerWidthBounds('navigation'),
    ),
    sessionDetailsWidth: clampDrawerWidth(
      Number(raw?.sessionDetailsWidth ?? DEFAULTS.sessionDetailsWidth),
      hardDrawerWidthBounds('session-details'),
    ),
  };
}

function loadPreferences(): DrawerPreferences {
  if (typeof window === 'undefined' || !window.localStorage) return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function savePreferences(preferences: DrawerPreferences): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Private mode / quota exhaustion should never make resizing fail.
  }
}

function scheduleSave(preferences: DrawerPreferences): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    savePreferences(preferences);
  }, 120);
}

export const useDrawerPreferences = create<DrawerPreferencesState>((set, get) => ({
  ...loadPreferences(),
  setNavigationWidth: (width) => {
    const navigationWidth = clampDrawerWidth(width, hardDrawerWidthBounds('navigation'));
    set({ navigationWidth });
    scheduleSave({ navigationWidth, sessionDetailsWidth: get().sessionDetailsWidth });
  },
  setSessionDetailsWidth: (width) => {
    const sessionDetailsWidth = clampDrawerWidth(width, hardDrawerWidthBounds('session-details'));
    set({ sessionDetailsWidth });
    scheduleSave({ navigationWidth: get().navigationWidth, sessionDetailsWidth });
  },
}));
