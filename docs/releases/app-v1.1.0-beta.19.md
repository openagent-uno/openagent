# OpenAgent App 1.1.0-beta.19

Published 17 October 2026 for macOS, Windows and Linux, each in x64 and ARM64 variants. This release adds the Exa and Firecrawl keyless connection controls to the existing shared marketplace cards. Use server/CLI beta 42 with connector SDK 0.1.5; installing the App alone does not update the server.

[Download release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.19) · [Native release receipt](../qualification/app19-native-release-2026-10-17.json)

The canonical App payload is `openagent-uno/openagent@f01b946105857c92fcf14d8f7a83bcbf2fdad11a`. Six native manifests, ten primary installers and four updater YAML files form the exact 36-asset release. macOS signing and notarization checks passed, as did the additional Intel ZIP/DMG launch gate.

The original run failed when Apple stapling lost its network connection on Mac ARM64. Its five successful native sets were reused byte for byte. The explicit recovery run rebuilt only Mac ARM64 and passed all five recovery gates; per-platform executor provenance is retained in the receipt and release body. The original failure has not been relabelled as success. No Actions artifact storage was used by these runs.

The later [packaged Linux x64 marketplace trial](../qualification/app19-server42-marketplace-2026-10-17.json) passed with server beta 42: 16 official adapters and 30 real registry results share one grid. Exa and Firecrawl connect, disable/enable and disconnect through the real UI without credential forms or OAuth. Four actual screenshots were reviewed; no provider API calls were made in that GUI trial. The real Exa/Firecrawl workflow, restart and disconnect receipt remains attributed to server beta 41; beta 42 has the same provider implementation. OAuth activation, all-tool parity and Mac/Windows marketplace GUI acceptance remain separate.
