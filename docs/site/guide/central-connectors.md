# Central connectors

The OpenAgent Tools SDK 0.1.13 adds an optional shared catalog and central execution profile. A host can discover connector contracts and invoke their operations through one generic client. Provider credentials remain in the service's encrypted vault; provider-specific adapters execute on that service.

The [SDK 0.1.14 release](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.14) and Go module `github.com/openagent-uno/openagent-tools/packages/connectors@v0.1.14` provide this profile. On 23 October 2026, the service at `https://auth.openagent.uno` serves catalog revision 4: 115 descriptors, with CoinGecko available. A normal public-module client completed a real CoinGecko read, metadata-only replay, recipient-isolation and disconnect checks on 21 October 2026. Other central entries remain unavailable; this does not change existing local or legacy OAuth connections.

## Two explicit execution profiles

| Profile | Credential custody and provider execution | Discovery |
| --- | --- | --- |
| Existing SDK 0.1.12 local path | The consuming host stores its authorized credentials and runs the pinned local connector runner. | The installed runner's compiled catalog, filtered by host authorization. |
| SDK 0.1.13 central opt-in | The shared service holds encrypted credentials and executes its reviewed adapters. The host receives opaque connection handles and authorized results. | A signed, versioned service catalog through the generic central client. |

The central profile does not replace existing local connections, import their tokens, change their OAuth issuer or silently switch their executor. Adopting it requires an explicit host integration and an authorized central connection flow. Existing own-app connections keep their own identity and scope contract.

A service can add a reviewed adapter behind the same protocol without adding provider API implementations to every consuming host. The host still owns its authenticated principals, tenant/project/session permissions, approvals, capability publication and local privacy obligations. A new protocol requirement or unsupported host policy remains a compatibility boundary.

## Catalog, availability and trust

`GET /v1/registry/catalog` returns a signed envelope with `key_id`, `payload` and `signature`. The payload contains:

- `protocol`: `openagent-connectors-central/v1`;
- a monotonic `revision`, `issued_at` and `expires_at`;
- connector descriptors containing `item`, `contract_sha256`, `operations` and `setup`.

The current catalog contains 115 entries. This count includes visible entries that cannot be enrolled through the central profile; it is not a claim of 115 enabled providers. Availability requires an explicit operator qualification list, an implemented supported operation set and, for OAuth, a configured official app. An empty qualification list leaves every entry unavailable.

Enabled setup currently supports `none` and `oauth`. Setup declares `mode: item.auth`, `credential_custody: service`, `execution: service` and `interaction`. Interaction is `none` for a credential-free connector and `hosted` for setup handled by the service. For available OAuth entries, the host opens the returned authorization URL and polls connection status rather than implementing provider-specific forms or handling provider tokens.

Hosted token/API-key and manual-credential setup are not available yet. Their entries, along with custom MCP, remain visible but unavailable for this profile; `interaction: hosted` does not make an unsupported credential mode usable. Shopify central enrollment remains unavailable pending its separate privacy and rotation qualification. A catalog entry, configured app or successful signature does not by itself grant data access.

`GET /v1/registry/schema` exposes the machine-readable JSON schema for this protocol. It describes the wire format; it does not replace catalog signature verification, supply trusted signing keys or authorize an operation.

The client needs a fixed HTTPS origin and explicitly trusted Ed25519 public keys. It verifies the signature over the exact payload bytes, protocol, expiry, descriptor contracts and revision. Older revisions and changed content at the same revision are rejected. Signature freshness can be renewed without changing descriptor content. The registry produces five-minute snapshots.

The revision high-water mark is held in memory by each client; this implementation does not provide a durable offline catalog cache or automatic trust-key rollover. Keys are operator configuration, not keys accepted from an untrusted feed. The client bounds responses, rejects redirects and ambiguous typed JSON, and allows plaintext HTTP only through an explicit localhost fixture option.

`central.OfficialClient(identity)` pins origin `https://auth.openagent.uno`, key ID `central-registry-20261021-1` and public key `35N3Qb16evtD9iJGSZ-OqkCpUv092HEySnz9e4Z1pR0` (unpadded URL-safe base64). The deployed catalog signature was verified with this pin. `client.Register(ctx)` registers the public installation identity; it does not grant provider access. Custom deployments can configure `central.Client` explicitly.

## Connection and invocation flow

The host registers its existing installation signing identity with the broker, retrieves the verified catalog and selects an available descriptor. An authorized host action then creates a central connection with the exact contract hash, recipient and explicitly approved operation names. OAuth consent, where required, completes into service custody. Access and refresh tokens are not returned to the client.

After hosted OAuth consent, polling `status` automatically completes a transaction once the broker reports it ready and persists its credentials inside the service vault. The host receives the updated connection state. The explicit `complete` route remains supported, but a generic consumer does not need a provider-specific redemption step. Status polling is an authenticated POST and can perform this completion; it is not a side-effect-free public status read.

Management and execution requests use installation signatures binding the HTTP method, path/query, body hash, timestamp and nonce. The supported central routes are:

| Request | Purpose |
| --- | --- |
| `POST /v1/execution/connections` | Create a connection using `CreateRequest`. |
| `POST /v1/execution/connections/{id}/status` | Poll connection state and automatically complete ready OAuth authorization into service custody. |
| `POST /v1/execution/connections/{id}/complete` | Complete an authorized OAuth transaction. |
| `POST /v1/execution/connections/{id}/refresh` | Refresh service-held credentials where supported. |
| `POST /v1/execution/connections/{id}/disconnect` | Disable the central handle and remove its usable token material. |
| `POST /v1/execution/connections/{id}/invoke` | Submit one admitted operation with a durable invocation ID. |
| `POST /v1/execution/connections/{id}/invocations/{invocation_id}` | Read an existing invocation's outcome metadata. |

Status, complete, refresh, disconnect and invocation-status requests carry `{"recipient":{"workspace_id":"…","subject_id":"…"}}`. Create and invoke requests carry the same recipient inside their typed request, alongside the contract and operation fields.

A connection is bound to the signing installation and recipient. The host must derive that recipient from authenticated context and revalidate its current audience and ACLs. Model arguments cannot choose the installation, recipient, credential, contract, grant revision or approval. Installation authentication does not establish universal authority over users in another host's namespace; cross-host audience expansion is not supplied by this protocol.

Connections pin the admitted operation set, contract hash and grant revision. Catalog refresh must not expand an existing local grant. The service checks current descriptor availability and the pinned contract before executing. An incompatible contract change stops execution until the host performs the appropriate reviewed connection/admission flow. Writes require trusted host approval metadata in addition to the operation and provider scope checks.

The first successful invocation can return content with `result_available: true`. Repeated invocation requests and status reads return outcome metadata with `result_available: false`; provider content is not durably stored for replay. The host must handle that distinction explicitly. Reusing an invocation ID with changed arguments is rejected. The client does not automatically retry a mutation after an uncertain outcome: inspect its status rather than submitting a fresh action blindly.

Disconnecting this central connection does not claim to revoke every provider-side grant or another installation's access. Global provider revocation and provider-specific limits remain separate operations and contracts.

## Google scope correction in SDK 0.1.14

New Gmail connections request `gmail.readonly` for mailbox reads and
`gmail.compose` for draft creation and sending. They no longer request
`gmail.modify` or the redundant `gmail.send`. Read-only operation selection
requests only readonly. Existing host-held grants retain their original app
and scopes; the SDK preserves supported legacy operation checks and refresh
without silently migrating credentials or requesting broader access.

Each Google connector requests its own subset of the app's declared scopes:

| Connector | Scopes |
| --- | --- |
| Gmail | `gmail.readonly`, `gmail.compose` |
| Drive | `drive` |
| Calendar | `calendar.calendarlist.readonly`, `calendar.events` |
| Analytics | `analytics.readonly` |

The revised Gmail authorization changes its central contract hash. A handle
pinned to an earlier contract requires an explicit reconnection; catalog
refresh must not silently expand a grant. The public central Gmail entry
remains unavailable while review is pending. An isolated, expiring admission
for one installation does not admit other installations or prove provider
approval.

On 23 October, isolated Google qualification exercised all 23 reviewed
operations: seven Gmail operations through central execution, and five Drive,
seven Calendar and four Analytics operations through the local runner. Each
connection also completed an explicit refresh, a subsequent read in a new
process and scoped disconnect. Source-account checks used only generated QA
mail/files and one private event without attendees. These checks do not
establish elapsed-expiry behavior, every shared-calendar case, acceptance by
Google or completion of a restricted-scope security assessment.

SDK releases and installed product bundles have separate version pins. An
older product's bundled runner does not acquire this correction automatically.
For an explicitly configured local review, download the matching platform
bundle and checksums from the 0.1.14 release, verify them, then select the runner
using `connectors.runner_path` or `OPENAGENT_CONNECTOR_RUNNER` before starting
the server. Explicit provider enrollment, local write authorization and Google
consent still apply. This override does not convert local connections to the
central profile or enable an unavailable central entry.

## Optional service configuration

The `connector-auth` command mounts these routes only when started with `-central-config /absolute/path/central.json`. Without that flag its existing broker profile remains unchanged. The existing `-state`, `-providers`, `-event-key`, `-listen` and `-origin` flags retain their meanings.

```json
{
  "revision": 1,
  "signing_key_id": "registry-key-1",
  "signing_key_file": "/private/connector-service/registry-signing.hex",
  "vault_path": "/private/connector-service/central-vault.json",
  "vault_key_id": "vault-key-1",
  "vault_key_files": {
    "vault-key-1": "/private/connector-service/vault-key.hex"
  },
  "qualified_catalog_ids": []
}
```

The signing-key file contains a hex-encoded 64-byte Ed25519 private key. Vault-key files contain hex-encoded 32-byte keys. Key paths are absolute and must resolve to private regular files, not symlinks. Configuration holds file references rather than key material. Configure the corresponding registry public key in the client; private keys, vault keys, tokens and vault files must remain outside published configuration and logs.

Qualification IDs are exact catalog IDs, not provider aliases. Unknown or duplicate IDs reject startup. The empty example enables no connector. The vault uses a single writer, encrypted state, atomic replacement and a private local directory with OS locking and directory fsync. Retain keys required by existing encrypted state and use a reviewed backup/rotation procedure.

Service-side vault support currently covers Linux and macOS. Windows and other vault-server targets fail closed until their locking implementation is qualified; producing a Windows binary does not establish Windows vault-server support. A Windows client can consume a qualified remote service.

## Data path and adoption boundary

Central execution means selected provider content transits the service before reaching the authorized host. That path must be disclosed in the receiving application's data-access flow. Credential custody is encrypted on the service; it does not move the host's memory, session history or local privacy responsibilities to that service. Provider content is not retained as an invocation replay cache.

The [privacy notice](/privacy) explicitly distinguishes this service-held vault
and API processing from the legacy broker that delivers credentials to a local
executor. A restricted qualification lane must bind the exact signing
installation and authenticated recipient; it does not enable Gmail for the
public catalog or another installation. Such admission is permission to conduct
the approved qualification, not a completed Google consent or a successful
provider lifecycle. Existing local credentials are never an automatic source
for a central connection. The [Google dossier](https://github.com/openagent-uno/openagent/blob/main/docs/verification/google-production-verification-2026-10-19.md)
records the remaining distinction between historical local-execution evidence
and any later central qualification.

Hosts integrate the public shared client rather than duplicate provider OAuth, scopes, endpoint or retry implementations. The reusable Go API, exact request types and setup details are documented in the [central package README](https://github.com/openagent-uno/openagent-tools/blob/main/packages/connectors/central/README.md). An existing local-only product does not become central-capable merely by rendering the new catalog. Host integration, service deployment, provider enrollment, user consent and end-to-end qualification are separate evidence boundaries.
