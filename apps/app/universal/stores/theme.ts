/**
 * Theme mode store — light / dark.
 *
 * Thin reactive wrapper over `setTheme`/`getThemeMode` in
 * `universal/theme.ts`. The actual palette swap (CSS custom-property
 * rewrite on web, in-place `colors` mutation on native) lives in the
 * theme module; this store only mirrors the current mode into React so
 * the Settings toggle — and any component that wants to re-render on a
 * theme change — stays in sync. The choice is persisted to
 * localStorage by `setTheme`.
 */

import { create } from 'zustand';
import { getThemeMode, setTheme, type ThemeMode } from '../theme';

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  mode: getThemeMode(),
  setMode: (mode) => {
    setTheme(mode);
    set({ mode });
  },
  toggle: () => {
    const next: ThemeMode = get().mode === 'dark' ? 'light' : 'dark';
    setTheme(next);
    set({ mode: next });
  },
}));
