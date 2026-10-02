/** Preserve Developer ID signing while retrying transient Apple timestamp failures. */
const { signAsync } = require('@electron/osx-sign');
const signUtil = require('@electron/osx-sign/dist/cjs/util.js');

module.exports = async function signWithTimestampRetry(options) {
  const execute = signUtil.execFileAsync;
  signUtil.execFileAsync = async (file, args, settings) => {
    if (file !== 'codesign' || !args.some((arg) => arg.startsWith('--timestamp'))) {
      return execute(file, args, settings);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await execute(file, args, settings);
      } catch (error) {
        const detail = String(error?.message || '');
        if (attempt >= 4 || !/timestamp was expected but was not found|timestamp service is not available/i.test(detail)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  };
  try {
    await signAsync(options);
  } finally {
    signUtil.execFileAsync = execute;
  }
};
