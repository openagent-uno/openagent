# OpenAgent App v1.1.0-beta.31

A new chat now exposes its participants, sharing controls and authorized
computers as soon as the server accepts its first shared run. The session can
stay open throughout: users no longer need to reopen it to retire the local
draft placeholder. Empty observations still leave the placeholder intact.

Escape is delivered to the focused remote desktop without closing its modal.
The normal Close control remains available. Direct pointer input, typing,
shortcuts, exact-target stream renewal and bounded playback recovery continue
to use the same public desktop contracts.

The release contains six qualified native targets. Remote qualification passed
136 desktop tests, 152 shared tests and four responsive UI scenarios, each run
twice. Physical macOS acceptance verified the first-run sidebar transition,
network-user sharing modal, exact connected-device shell execution, session
device history, complete remote desktop and focused Escape behavior.

The App retains Host Tools 1.0.0b15 and Desktop SDK 0.1.0; installing it does not
change a server's independently versioned runtime or its host access policy.
See the [release qualification](../qualification/app31-native-release-2026-11-07.json)
for immutable source, build, publication and verification limits.
