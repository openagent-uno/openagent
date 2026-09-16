Stand-alone OpenAgent host-tool bundles are staged here at build time from:

  openagent-host-tools/dist/<platform>-<arch>/

Every source bundle must include its complete bundle-manifest.json. Packaged
builds set OPENAGENT_REQUIRE_HOST_TOOLS=1 and fail when the native target,
version lock, file sizes, or SHA-256 checksums do not match.
