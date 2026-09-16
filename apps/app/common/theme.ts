/**
 * Re-export from universal/theme.ts — the canonical source.
 * This file exists for consumers outside the Metro bundler (desktop/).
 */
export {
  colors,
  lightColors,
  darkColors,
  primaryGradient,
  primaryGradientStops,
  spacing,
  radius,
  font,
  setTheme,
  getThemeMode,
} from '../universal/theme';
export type { ThemeMode } from '../universal/theme';
