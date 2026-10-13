# Connector setup, embedding and recovery

This guide is for server operators and embedding products. Common app
activation is still gated by the [qualification status](./connector-status.md).
The examples describe the candidate implementation; do not assume an older
public standalone or native host release already contains these settings.

## Standalone configuration

The server loads a local runner and registers its managed sources through the
public Core capability API. The runner is trusted local IPC, not an exposed
HTTP service. It belongs on the server executing provider requests, not just
on the client displaying the marketplace.

```yaml
connectors:
  runner_path: /opt/openagent/connectors/bin/openagent-connector-runner
  auth_url: https://auth.openagent.uno
  # Keep empty until common providers are qualified and the host opts in.
  official_providers: []
  # Optional, for the operator's own app registrations:
  # oauth_providers_file: /private/openagent/oauth-providers.json
```

The runner can also be selected with `OPENAGENT_CONNECTOR_RUNNER`, or discovered
on the server's PATH. Frozen server builds verify and bundle the consumer-pinned
runner. If it is missing, the authenticated catalog remains visible but marks
operations unavailable.

`official_providers` uses provider IDs: `gmail`, `google_drive`,
`google_analytics`, `clickup`, `shopify` and `postiz`. These differ from display
catalog IDs such as `google-drive`. A nonempty list does not configure the
central provider or bypass product policy. Standalone Shopify is independently
blocked until the local privacy processor is qualified. An empty OAuth list
does not disable token/account connectors that are configured locally.

The server stores its signing/encryption identity in `connectors-identity.json`
and its credential encryption key in `connector-credential-key`, alongside its
configured database. Protect this host-owned directory; it must not be an
agent-writable workspace. Preserve these files and database state during an
upgrade. Tokens are not app settings or CLI arguments and must not be written
into a prompt, source repository or logs.

## GlassPalace and ICS opt-in

Both Go products import the same versioned connector module. They retain their
existing credential store, membership checks, installation IDs and agent grants.
An operator explicitly configures:

```text
OPENAGENT_CONNECTOR_AUTH_IDENTITY_FILE=/private/product/connectors-identity.json
OPENAGENT_CONNECTOR_AUTH_URL=https://auth.openagent.uno
OPENAGENT_CONNECTOR_AUTH_PROVIDERS=<qualified provider IDs, comma-separated>
```

Do not set the allowlist until provider and product acceptance gates pass.
The ICS native supervisor passes only these public configuration values to its
API process, and only when an identity path is supplied. It does not inherit
app secrets or all environment variables into that child. New credentials still
require the product's local authority check before their storage transaction.

ICS remains a local server/client product: customer accounts, database, files
and agents are on that installation. Its public site is presentation/download
hosting. Enabling common OAuth does not turn it into a cloud account service.

## Pinning the shared implementation

A Go host consumes
`github.com/openagent-uno/openagent-tools/packages/connectors@v0.1.1`; its
`go.mod`/`go.sum` must resolve the published module, rather than an accidental
sibling replacement. The standalone consumer lock is
`apps/server/connectors.lock.json` and binds the source commit, manifest,
platform archive and wheel hashes.

From a source checkout containing the candidate acquisition script:

```sh
python3.11 apps/server/scripts/acquire-connectors.py   --platform darwin-arm64   --output /tmp/connectors-verified-new   --wheelhouse /tmp/connectors-wheelhouse-new
```

Use a fresh output directory. Targets are `darwin-arm64`, `darwin-x64`,
`linux-arm64`, `linux-x64`, `win32-arm64` and `win32-x64`. `--assets` accepts a
local release directory for an offline build while preserving checksum checks.
Acquisition does not install Python dependencies or qualify native signing.

The shared Python package exposes `ConnectorRunner` and the optional
`openagent_connectors.mcp.serve_connector` surface. An embedding host supplies
an authorizing connector factory and credential/connection context. Do not
publish the raw runner protocol or credentials as a model-controlled MCP
endpoint. See the [shared library contract](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.1/packages/connectors).

## Authenticated standalone management API

App and CLI use the normal verified server membership. Being able to reach a
loopback port does not grant connector-management authority.

| Method and route | Operation |
| --- | --- |
| `GET /api/marketplace/official` | Catalog and current availability |
| `GET /api/connectors/catalog` | Compatible catalog alias |
| `GET /api/connectors` | Locally authorized connection metadata |
| `POST /api/connectors` | Create/setup a connection |
| `POST /api/connectors/{id}/connect` | Reauthorize the same connection |
| `POST /api/connectors/{id}/poll` | Outgoing consent-status polling |
| `PUT /api/connectors/{id}` | Enable/write admission controls |
| `DELETE /api/connectors/{id}` | Disconnect this server |

Responses never return stored credentials. The APIs recheck product authority;
clients must not substitute another connection, installation or principal.
The broker has a separate signed `/v1` contract for installation registration,
transactions, redemption, refresh/revoke, group commits/recovery, temporary
mail and durable events. Its contract is
[`openagent-connectors/v1`](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.1/packages/connectors).

## Own provider apps

Google, ClickUp and Postiz own-app configuration uses the shared provider
descriptor array, with client identity, a protected secret-file reference,
registered endpoints, redirect, scopes and PKCE settings. The standalone's
own-app redirect must use the explicitly configured loopback callback supported
by that provider. Multiple agents on one machine need separate reserved callback
ports. Product-local own-app credentials stay local.

Shopify own apps serving several servers need their own configured broker
instance, so acquisition/refresh can be coordinated per app and shop. Existing
GlassPalace/ICS registrations retain their existing compatible own-app paths.
A connection's issuer remains the app that minted its credentials; swapping a
client ID or copying a secret is not a credential migration.

## Backup and restart boundaries

Back up a consistent database snapshot, its required WAL/state, product files,
credential key and installation identities together. Include locally pending
privacy jobs and their processing receipts. Respect the product's single-writer
cutover procedure; do not restart against an incomplete or newly initialized
credential store.

The broker backup includes authorized installation/group metadata, the durable
event queue, event-encryption key and provider configuration/secret-manager
references. There should be no durable access/refresh-token archive to back up.
Recoverability must include required protected app/key material without exposing
it in artifacts or logs. Temporary encrypted token messages are expected to be
lost across broker restart; recipients recover from a current peer or consent
again.

## Troubleshooting

| Symptom | Check/action |
| --- | --- |
| Card is unavailable | Read its server-provided reason; a placeholder, missing runner, disabled host opt-in and unconfigured provider are different states |
| Marketplace registry results fail | Retry the registry search; locally supplied connector cards and existing valid connections remain independent |
| Wrong account/server shown | Verify selected network, agent, user and server identity before starting consent; a logo does not establish the receiver |
| OAuth cancelled or expired | Retry from the same connection; do not reuse or share a consumed transaction URL |
| Local authority was removed during consent | The host must reject saving the result; restore legitimate membership before requesting a new consent |
| Broker is down | Locally valid tokens still work; secret-dependent renewal and new common consent wait for recovery |
| Shopify peer missed a token envelope | Request a current peer copy; with no recoverable current copy, obtain fresh consent |
| Provider app was removed | Reauthorize after restoring the provider grant; removal can affect other products using that app |
| Privacy job received but still pending | Inspect the product-local worker and completion receipt; delivery acknowledgment alone is not completion |

Monitor `/healthz` separately from `/readyz`. The current production bootstrap
can report healthy with zero configured providers while readiness correctly
refuses enrollment. Before activation, qualify backup/restore, capacity,
provider callbacks, peer recovery and product-local privacy actions. The
[deployment runbook](https://github.com/openagent-uno/openagent-tools/tree/codex/shared-official-connectors/deploy/connector-auth)
contains the detailed operator gates.
