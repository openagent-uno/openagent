# Channel bridges beta11: complete Slack audio renditions

Slack may retain the original file size in its API metadata while serving a
smaller MP4-container rendition of an M4A voice file. The bridge now stages
that representation only for provider-attested `audio/mp4` files named `.m4a`,
with an MP4 HTTP MIME type, a positive complete HTTP Content-Length and an
MP4 container signature. Canonical size and SHA describe the actual bytes.
Original metadata still bounds admission; the ordinary per-chunk and final
provider/host authorization, file budget and actual byte limits remain intact.
Generic files, missing HTTP length, truncation, unexpected growing bodies,
invalid MIME/container and changed or revoked audiences remain denied.
Deleted or inaccessible files remain explicitly unavailable.

Six source regressions reproduce three observed metadata/served-size pairs
with synthetic bodies in current and historical input. They fail on beta10.
Eleven negative cases and the complete 279-test/84-subcase suite pass after
the fix. Canonical reader hashes and cleanup are verified. Fixtures do not
make provider/model calls or establish live business delegation success.
Installed/public qualification is recorded separately.
