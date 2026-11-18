# Loading and responsiveness qualification — 17 November 2026

Profiling covers Core, standalone server transport and the app. Results below
are scoped measurements; no universal 3× improvement is claimed.

| Path | Before | After | Evidence boundary |
| --- | ---: | ---: | --- |
| Provider first card, delayed quota fixture | 4929 ms | 129 ms | Electron navigation/network/render |
| Settings configuration load | 300 ms, 4 reads for two callers | 180 ms, 2 reads | Deterministic real store, mocked network |
| Coordinator authorization, 8 serial RPC | 460 ms, 8 dials | 141 ms, 1 dial | Controlled latency, real CBOR client |
| Coordinator authorization, 8 concurrent RPC | 202 ms | 61 ms | Same harness, 8 fresh roster checks |
| Provider budget checks, 100k ledger rows | 706 ms | 117 ms | Real Core SQLite, 24 concurrent checks |
| Context report event-loop heartbeat delay | 460 ms | 7.6 ms | Complete 2000-run report, identical digest |
| Repeated unchanged idle collaboration | 9 reads | 3 reads | Actual client/store with deterministic API |
| Turn rail, 20k prompts / 119 deltas | 489 ms CPU | 0.22 ms CPU | Pure extracted derivations, identical result |
| Tool placement, 6000-row transcript / 119 deltas | 2113 ms CPU | 240 ms CPU | Pure extracted derivations, identical result |
| Graph cold layout, 5000 nodes | 6108 ms | 3142 ms | 168 exact ticks, identical layout hash |

Provider loading no longer waits for account quota or usage enrichment. Active
GET reads share work without retaining responses, and response deadlines cover
body parsing. Settings drafts retain unsaved changes across refreshes and reset
when switching account. Idle collaboration does not reload unchanged history;
failed recovery stays dirty and retries. Turn-rail derivations retain complete
indexed navigation while avoiding reconstruction on every assistant delta.

Core owns the subscription/catalog/budget contracts and asynchronous context
report. The report still accounts for the full history; its work moves off the
host event loop through the shared persistence worker. Authorization must be
rechecked after awaited report reads. No permission-result cache is introduced.

Real Iroh coordinator/member/device HTTP checks passed: a pooled connection
serves independent live checks, revocation denies access, regrant works and a
coordinator outage fails closed. A separate real Electron enrollment/tool-loop
flow passed with the exact public native host bundle. These are local wire
qualification, not measurements of a remote deployment or physical phone.

Cold model-catalog JSON decoding remains a separate cost: about 2 ms for
1.24 MB and 17 ms for 12.4 MB in the controlled fixture. The graph case has
not met 3×. Timing below a millisecond for Core session list/read and model
catalog does not justify speculative caching or changes to history semantics.

An earlier 6000-message Electron performance fixture opened the rename dialog
by clicking an already selected session. Its frame timings do not qualify the
visible transcript path. The corrected App beta64 Electron fixture passed twice;
the separate pure derivation benchmark above remains valid.

A real tool-heavy session returned a 2.08 MB compressed response and took
7.16 seconds cold, about 3.77 seconds on a repeated read. Most decoded text was
linked tool output duplicated in message parts. App beta64 requests the opt-in
`tool_details=deferred` projection from Server beta85/Core beta135: collapsed
linked tool messages retain attachment bindings, invocation identity and summaries;
full content is fetched through the existing authorized detail endpoint on each
opening. Default/older clients retain full messages. Stored history is unchanged.
The real before/after remote timing still requires live qualification.

A separate operator-only read benchmark used three private snapshot sessions
with legacy envelopes of 12–31 MB. The isolated transcript projection measured
roughly 40–175 ms in the candidate. This excludes authorization transport and
client rendering and does not establish a 3× improvement in initial session
opening. Complete projection and input decoding remain measured follow-up work;
streaming gains above must not be presented as initial-opening speedups.

## Installed remote history qualification — 18 November

The official, signed macOS arm64 App beta67 was installed with the existing
profile and connected to a live Server beta87/Core beta137 host. Six renderer
reloads of the same canonical conversation retained three assistant messages
and 55 linked tool invocations, without reading legacy runs. Tool detail opening,
closing and reopening passed; a separate bounded chat returned the expected
answer with no tool invocation. The named subscription connection probe passed
twice. No stored message or tool result is included in these measurements.

Three alternating paired trials measured navigation to the first visible
assistant after the complete expected message/tool projection was present.
The baseline removed only `tool_details=deferred` from the same read request;
host, installed client, profile, authorization and conversation stayed the same.
The probe was installed before navigation and removed after every trial.

| Trial | Full linked output | Deferred linked output |
| --- | ---: | ---: |
| 1 | 4,347 ms | 888 ms |
| 2 | 11,969 ms | 987 ms |
| 3 | 18,781 ms | 1,031 ms |

The medians were 11,969 ms and 987 ms, a 12.1× improvement for this remote,
tool-heavy history. Network time dominated and varied substantially: the full
message response transferred about 2.08 MB, while deferred reads transferred
about 22 KB plus an 8.9 KB anchor page. These field measurements qualify this
history path. They do not establish that initial enrollment, settings, graph
layout, every session or every client improved by at least 3×.
