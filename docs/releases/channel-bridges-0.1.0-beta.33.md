# Channel bridges 0.1.0 beta 33

Each sub-agent’s Telegram message updates with the sub-agent’s own text and
tool progress. The completed message retains its reply and outcome. The
parent’s message continues to update independently.

Telegram’s rate-limit cooldown applies to the parent and child messages in
the same turn. The bridge keeps one message per child and preserves quiet
delivery for installations configured to send only the final reply.

Standalone deployments must select the beta 33 bridge wheel when resolving
their public dependencies. Core 1.1.0 beta 42 remains the minimum supported
version. The installed-wheel workflow qualifies the package with Core beta
45 and publishes its manifest and test receipt with the wheel.

[Channel bridge protocol](../../packages/channel-bridges/PROTOCOL.md)
