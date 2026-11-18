# App beta 64 — deferred tool details and declared account failover

Conversation pages request deferred tool bodies from supporting servers. Cards
keep their status and attachment references; opening a card loads its separately
authorized detail. Reopening rechecks access and does not retain a revoked
result. Legacy servers retain their existing transcript response.

Migrated account connections expose Core's automatic account-fallback policy
without changing account or model enablement. New independent connections keep
exact-account routing.

TypeScript and 257 common tests passed; provider management, delayed
enrichment/focus and tool detail inspection each passed twice in Electron.
Signed native builds, publication and real host acceptance remain separate gates.
