/**
 * Expo app config.
 *
 * `experiments.baseUrl` is parameterized so the same source tree can be
 * exported for different deploy targets without changing any code:
 *
 *   - Electron desktop build: no env → no baseUrl (root-relative paths,
 *     post-processed by build.sh sed step and served by the local
 *     HTTP server at 127.0.0.1:PORT/).
 *   - GitHub Pages under openagent.uno/app/: EXPO_BASE_URL=/app
 *   - Custom subdomain (e.g. app.openagent.uno): EXPO_BASE_URL unset.
 *
 * Note: a `baseUrl` key under `web` is a no-op in Expo SDK 50+; the
 * supported location is `experiments.baseUrl`.
 */
const baseUrl = process.env.EXPO_BASE_URL;

module.exports = ({ config }) => ({
  ...config,
  expo: {
    name: 'OpenAgent',
    description:
      'Persistent AI agent framework with MCP tools, long-term memory, and multi-channel support.',
    slug: 'openagent',
    version: '0.1.0',
    scheme: 'openagent',
    userInterfaceStyle: 'dark',
    icon: './assets/app-icon.png',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#050810',
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './assets/favicon.png',
      name: 'OpenAgent',
      shortName: 'OpenAgent',
      themeColor: '#050810',
      backgroundColor: '#050810',
    },
    plugins: ['expo-router'],
    experiments: baseUrl ? { baseUrl } : {},
  },
});
