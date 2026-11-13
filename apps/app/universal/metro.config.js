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

// Files in ../common/ import npm packages installed in universal/node_modules.
// Metro's default resolution walks up from the source file, so it would miss
// them. Adding this ensures packages resolve correctly from both directories.
config.resolver.nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths || []),
  path.resolve(__dirname, 'node_modules'),
];

config.resolver.unstable_enablePackageExports = false;

const cryptoShimPath = path.resolve(__dirname, '..', 'common', 'network', 'crypto-shim');

// cbor2 is ESM-only with no ``main`` field — only ``exports``.  Metro's
// per-resolution ``unstable_enablePackageExports`` context override doesn't
// propagate in 0.83, so we map bare specifiers to their exports entrypoints.
const cbor2Dir = path.resolve(__dirname, 'node_modules', 'cbor2', 'lib');
const cbor2Exports = {
  'cbor2': path.join(cbor2Dir, 'index.js'),
  'cbor2/comment': path.join(cbor2Dir, 'comment.js'),
  'cbor2/decoder': path.join(cbor2Dir, 'decoder.js'),
  'cbor2/diagnostic': path.join(cbor2Dir, 'diagnostic.js'),
  'cbor2/encoder': path.join(cbor2Dir, 'encoder.js'),
  'cbor2/simple': path.join(cbor2Dir, 'simple.js'),
  'cbor2/sorts': path.join(cbor2Dir, 'sorts.js'),
  'cbor2/tag': path.join(cbor2Dir, 'tag.js'),
  'cbor2/types': path.join(cbor2Dir, 'types.js'),
  'cbor2/utils': path.join(cbor2Dir, 'utils.js'),
  'cbor2/writer': path.join(cbor2Dir, 'writer.js'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // xterm.js is DOM-only — stub it on native.
  if (
    platform !== 'web' &&
    (moduleName === '@xterm/xterm' || moduleName.startsWith('@xterm/'))
  ) {
    return { type: 'empty' };
  }
  // Node's ``crypto`` is unavailable on React Native. Redirect to our
  // minimal shim that implements only what @windwalker-io/srp needs.
  if (platform !== 'web' && moduleName === 'crypto') {
    return context.resolveRequest(context, cryptoShimPath, platform);
  }
  // cbor2 has no ``main`` field; resolve bare specifiers to the exports map.
  if (cbor2Exports[moduleName]) {
    return context.resolveRequest(context, cbor2Exports[moduleName], platform);
  }
  if (
    moduleName.startsWith('@openagent/desktop-tools/') ||
    moduleName === 'shiki' ||
    moduleName.startsWith('shiki/') ||
    moduleName.startsWith('@shikijs/') ||
    moduleName === 'rfc4648' ||
    moduleName.startsWith('rfc4648/')
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
