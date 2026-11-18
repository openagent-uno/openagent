# Operational history maintenance

The standalone gateway starts and cancels Core's public
`maintain_operational_storage` worker. The product adapter maps its status to
REST readiness; reconciliation, backfill, incremental indexing and retry policy
belong to Core. Canonical read authorization and journal freshness checks remain
in force while derived search is warming or degraded.

Ready, unchanged stores use indexed change probes between periodic integrity
audits. Idle instances do not scan their whole history and FTS index every half
second. New durable changes and changed or deleted index files trigger normal
maintenance. Explicit search status still performs its normal validation.

Upgrade through a complete compatible, versioned release cohort. Retain a
consistent database/WAL snapshot and private identity/configuration backup;
verify the copied database before cutover. Never clear canonical tables or
replace an installed Core module to address resource pressure.
