/**
 * Metro bundler config.
 *
 * Package ``exports``-field resolution is OFF globally: several
 * transitive dependencies (zustand nested under @reactflow/*) ship an
 * ESM ``.mjs`` entrypoint that uses ``import.meta``. Metro can bundle
 * the file but the web runtime serves the result as a plain script, so
 * ``import.meta`` throws ``Cannot use 'import.meta' outside a module``.
 * The legacy ``main`` / ``module`` fields pick up the CJS builds, which
 * Metro handles correctly on both web and native.
 *   https://docs.expo.dev/guides/customizing-metro/#resolution
 *
 * Exception: ``shiki`` (syntax highlighting in Markdown) and its
 * ``@shikijs/*`` subpackages expose their themes/langs ONLY through the
 * ``exports`` field — with global resolution off Metro can't find
 * ``@shikijs/themes/<theme>`` and the web build fails. The custom
 * ``resolveRequest`` below re-enables ``exports`` resolution for just
 * those packages, leaving every other dependency on the legacy path.
 */
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// ``../common`` lives outside the universal projectRoot. TypeScript
// resolves it directly so type-only imports compile fine, but Metro
// only bundles files it's been told to watch. Without this, the first
// runtime-value import from ``../../common/types`` (e.g. ``toolPhase``)
// fails to resolve at bundle time even though TypeScript sees the file.
config.watchFolders = [
  ...(config.watchFolders || []),
  path.resolve(__dirname, '..', 'common'),
];

config.resolver.unstable_enablePackageExports = false;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // xterm.js is DOM-only — the terminal surface uses it on web/Electron
  // and a line-mode fallback on native. The web variant pulls xterm via
  // a dynamic ``import()`` that never executes on native, but Metro
  // would still bundle it; stub it to an empty module off-web so the
  // native bundle never has to resolve or carry browser-only code.
  if (
    platform !== 'web' &&
    (moduleName === '@xterm/xterm' || moduleName.startsWith('@xterm/'))
  ) {
    return { type: 'empty' };
  }
  if (
    moduleName === 'shiki' ||
    moduleName.startsWith('shiki/') ||
    moduleName.startsWith('@shikijs/')
  ) {
    return context.resolveRequest(
      { ...context, unstable_enablePackageExports: true },
      moduleName,
      platform,
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
