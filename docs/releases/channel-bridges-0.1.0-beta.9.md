# Channel bridges beta9: prompt acknowledgement and bounded provider checks

Quiet replies acknowledge after normal provider/host authorization, before
historical downloads and transcription. Dispatch does not acknowledge twice.
Full provider membership is checked at transfer boundaries and renewed during
slow files; every chunk still checks fresh host actor/binding/recipient access.
No host grants are cached and audience-epoch changes fail closed before ingest
or publication. Requested history failures are explicit, never empty input.
Safe closed CLI diagnostics expose only enums, counts and an exact-event hash.

Deterministic source qualification: 247 tests + 84 subcases and four standalone
fixtures; previously published beta8 reproduces three targeted regressions.
The 38-file fixture streams 304 chunks, preserves exact bytes and checks bounded
provider call counts, revocation and audience changes. No live provider/model,
App, native runtime or real business delegation is qualified by these fixtures.
The independent Core 28 and immutable prior SDK releases remain unchanged.
