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
