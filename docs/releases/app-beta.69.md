# App beta69 — reliable settings refresh and faster large graphs

Section settings writes use the shared mutation lifecycle. A post-save read
cannot join an older pending GET, and the existing API error and response deadline
handling applies to the complete write. Regression coverage exercises the real
store race, independent connection scopes, error bodies and timeout handling.

Large graph simulations reuse numeric buffers and use smaller spatial cells,
while refreshing every position, velocity and pin on each tick. Exact interaction
tests cover dragging, pinning, replacement, reordering, resizing across the
algorithm boundary and independent graphs. Layout results match the reference.

Five alternating paired trials of the original and candidate 5,000-node layout
measured medians of 5,841 ms and 2,261 ms for 168 ticks: 2.58×, with an identical
layout hash. This is a CPU benchmark, excluding network and first paint. The 3×
goal for this graph workload remains unmet. Signed builds and installed UI
acceptance are separate qualification gates.

All six signed/platform package jobs and the verified publication workflow passed.
The public macOS arm64 ZIP passed SHA256, deep strict code-signature verification
and notarized Gatekeeper assessment. Two uninterrupted native-client repetitions
passed the named-account connection probe, scoped model settings/budget dialog
and return to the three-account grid, preserving the existing settings.

Two consecutive native chat repetitions also passed a real default-model reply,
navigation away and reopening the same conversation from history with its reply
and current calendar date intact. One earlier attempt exceeded a 15-second
model-response wait; the response subsequently arrived, and the repetitions used
a 60-second provider allowance. These are correctness checks, not a chat latency
or universal loading-speed qualification.

The previously rejected saved network login passed after authenticating with the
correct existing account. A complete normal client restart then reconnected
automatically and restored the conversation. Two consecutive 18-step native
provider/chat/history repetitions passed; session-identity readback confirmed
that each reopened conversation was the newly created session. Equal-title
history rows are scoped to the nearest entry after the Recent heading.

Initial provider loading experienced transient empty network responses and
recovered automatically. This observation is retained as a transport limitation;
successful authentication does not establish its cause or qualify loading speed.
