# Channel bridges beta10: fresh audience proofs across speech callbacks

Historical media retains the freshly verified context returned at each file
boundary. Transcription and synthesis pass a newly verified provider audience
to the host immediately before the callback, then recheck provider membership,
actor access and the original audience epoch after the callback completes.
A long transcription cannot cause the next file to reuse its intake-time proof.
Authorization failures remain fatal; no freshness window or permission expands.
Original audio, history bounds, quiet acknowledgement and diagnostic schema
remain unchanged.

The source regression reproduces the observed beta9 failure with a simulated
43-second first transcription and a second file at 52 seconds. It fails before
the fix. Nine new cases cover the historical sequence and direct transcription
and synthesis with unchanged membership, revocation and audience changes.
The complete component suite passes 262 tests plus 84 subcases. These fixtures
make no provider/model requests and do not establish live delegation success.
Installed and anonymous public-wheel qualification are recorded separately.

The history count ceiling is now 200, with its default still 20. Slack main
channels use at most two cursor pages of 100 scoped to the same channel and
trigger boundary; threads retain the ten-page forward-scan limit. Missing or
repeated required cursors fail closed. Discord uses its normal SDK iterator
for the configured bounded window. Trigger events and duplicate message IDs
are excluded. Six additional fixtures cover the second-page oldest media,
foreign-channel records, cursor failure, duplicate/trigger IDs and revocation.
The 64-KiB attributed-history, 256-part, 64-file opt-in, 32-MiB per-file and
64-MiB aggregate input limits do not expand. A 200-record window does not
promise unbounded day coverage or override explicit media omissions.
