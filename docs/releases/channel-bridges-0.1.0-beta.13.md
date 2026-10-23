# Channel bridges 0.1.0 beta13: native processing indicators

Source qualification is complete: 320 tests plus 86 subtests passed with no skips.
This includes 22 native-indicator/admission fixtures, ten of which compare the
actual public SDK12 WhatsApp handler with the new source. The public SDK12 wheel
reproduces the missing native Discord indicator in quiet delivery.

Normal SDK13 installed-wheel qualification, publication and anonymous public
readback remain pending. No live Slack, Discord or WhatsApp acceptance is claimed.
Core and standalone product qualification remain separate release artifacts.

Native indicators now run independently of quiet/live/final message delivery,
covering admitted intake, media/speech and execution. Discord uses the existing
channel's native typing primitive. Slack uses assistant status only for supported
existing assistant threads; main-channel and top-level DM replies keep their
placement and have no emulation. Green API uses its documented async native
method on an admitted personal route; the original inbound parser, allowlist,
authorization and execution context are unchanged. Group/unknown or mismatched
routes do not acquire a typing indicator.

Each pulse requires fresh host and delivery authorization. Cancellation, stop,
timeout, revocation and bounded rate-limit failure stop and join the owned task.
A finishing turn cannot clear another active turn's Slack status. No token
scopes, permissions, messages, reactions or threads are added to emulate typing.
Existing message history, final parts and media delivery are preserved.

See [provider capabilities, expiry and lifecycle limits](../site/guide/channel-native-typing.md).
The API/wire contract and conversation vectors are unchanged; the minimum Core
version remains beta24. The normal release route will additionally qualify the
published SDK with official Core30 before standalone61 adoption.
