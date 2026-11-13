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
    // @electron/osx-sign signs files of equal depth in directory-listing
    // order, so a helper beside the main executable in Contents/MacOS can be
    // reached after it ("subcomponent ... not signed at all"). Sign the
    // declared additional binaries first; the full pass then re-signs them.
    if (options.identity) {
      for (const binary of options.binaries || []) {
        const fileOptions = (await Promise.resolve(options.optionsForFile?.(binary))) || {};
        const args = ['--sign', options.identity, '--force'];
        if (options.keychain) args.push('--keychain', options.keychain);
        args.push('--timestamp');
        if (fileOptions.hardenedRuntime !== false) args.push('--options', 'runtime');
        if (typeof fileOptions.entitlements === 'string') args.push('--entitlements', fileOptions.entitlements);
        await signUtil.execFileAsync('codesign', [...args, binary]);
      }
    }
    await signAsync(options);
  } finally {
    signUtil.execFileAsync = execute;
  }
};
