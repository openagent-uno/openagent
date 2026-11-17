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

A live Electron renderer profile with 6000 recovered plain-text messages and
120 streamed deltas passed twice. Both before and after had no long tasks or
renderer errors and about a 10 ms p95 frame gap. The fixed-rate input drives
its duration; that test does not establish an end-to-end speedup. The tool-heavy
pure derivation benchmark measures the separate placement improvement.
