# Local connector privacy candidate

The candidate server can explicitly install its public Core privacy services
during normal startup:

```json
{"connectors":{"privacy":{"enabled":true}}}
```

This installs the provenance publisher and canonical history, state, journal,
search and encrypted export adapters before runtime recovery and connector
registration. It requires compatible published Core, SQLite and connector SDK
packages. Missing APIs fail startup for an opted-in server rather than silently
omitting attribution. With no opt-in the existing startup remains unchanged.

This setting does not attest historical data, enable Shopify, approve external
writers or declare sink coverage. The normal bootstrap currently leaves coverage
empty and common Shopify enrollment disabled. Coverage comes from qualified host
assembly and baseline reconciliation, never model arguments or saved config.

Privacy exports are accessed through the authenticated product routes:

- `POST /api/connectors/privacy/{request_id}/export` returns a local bundle and
  delivery token only after current connection and every source session ACL pass.
- `POST /api/connectors/privacy/{request_id}/ack` with `delivery_token` records
  delivery after rechecking access and source revocation fences. Until this ACK,
  encrypted staging is not completed delivery.

The token is a local receipt, not a provider credential. The host retains the
encrypted staging file and its matching credential key; restoring one without
the other cannot recover plaintext. Another owner of the same store has no
implicit right to private sessions. Unknown copies or one denied bundle part
block the whole export rather than silently dropping data.

New bootstrap/provenance/ACL tests are written but have not run during the Mac
resource pause. Public dependency closure, actual provider acceptance and
two-server recovery remain release gates. This document does not mark those
gates complete or recommend activating Shopify on an unqualified server.
