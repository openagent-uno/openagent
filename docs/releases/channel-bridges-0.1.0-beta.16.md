# Channel bridges beta16 — shared chat commands, local candidate

Official bridges inherit the Core command catalogue. Host-reported failed or
unsupported outcomes never announce completion; Telegram confirms reset only
when the host reports completed. Core beta42 is the minimum supported version.
The package metadata and runtime describe version both advance to 0.1.0b16.

The standalone consumer also needs the updated gateway/transport status path;
the candidate server is 1.1.6 because stable 1.1.5 is already public. No immutable
1.1.5 wheel is overwritten. See [the protocol](../../packages/channel-bridges/PROTOCOL.md).

This is local preparation. Installed candidate and public-byte manifests are
recorded under shared-chat-commands-release-r2 for review. Provider registration,
real models/channels, publication and deployment remain separate qualifications.
