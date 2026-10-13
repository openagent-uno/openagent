# Local connector privacy candidate

The server can explicitly install its public Core privacy services during normal
startup:

```json
{"connectors":{"privacy":{"enabled":true}}}
```

Services are installed before recovery and connector registration. Without this
opt-in the normal startup is unchanged. Missing public APIs fail opted-in startup;
installation never mutates or overlays Core source.

Coverage is computed from the known canonical text assembly, shipped native
providers, empty engine extensions and a durable new-history baseline. Existing
unknown history or backups remain blocked and preserved. A config field cannot
claim coverage. Custom providers/extensions and unqualified copies require their
own reviewed host integration.

This first opt-in assembly delivers authorized text through the ordinary app/CLI
sender and retains canonical history for reconnect. It tracks pending output,
checks delivery attempts, purges exact revoked frames and preserves human and
other-customer frames. Mixed or in-flight copies block completion. Unattested live
replay-cache copies and TTS copies are not produced for this text cohort; protected
media, Vault/files/attachments and unqualified MCP writers are fenced. Custom MCPs
remain available for normal unprotected runs.

A token rotation preserves existing opaque tool references only for the same
verified grant, issuer, store and permissions. Credential persistence compares the
previous encrypted credential and exact local identity/config/permission snapshot.
New consent, disconnection or permission edits during renewal cannot be overwritten
or cause a revoked source to make provider calls.

Privacy exports use authenticated product routes:

- `POST /api/connectors/privacy/{request_id}/export` returns an encrypted-local
  bundle and delivery token only after current connection and every source
  session ACL pass.
- `POST /api/connectors/privacy/{request_id}/ack` records delivery after checking
  the token, current access and source revocation again.

Staging is not delivery. The product receipt stays pending until all selected
local actions and export delivery succeed. Another owner of the same store has no
implicit right to private sessions. The local receipt is not a provider token;
restoring encrypted data without its original matching key cannot recover it.

Source fixtures qualify actual public catalog/read/same-customer update paths and
two isolated product export/redaction routes. They do not qualify live provider
consent or two real Shopify recipients. Installed beta 22/beta 39 package closure,
provider approvals and real multi-server acceptance remain release gates.
Common Shopify enrollment is still disabled; this document does not authorize
activation on an unqualified server.
