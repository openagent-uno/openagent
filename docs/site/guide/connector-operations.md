# Connector setup, embedding and recovery

This guide is for server operators and embedding products. ClickUp, GitHub and Notion common-app enrollment is available as a limited
public beta; other providers retain their [qualification gates](./connector-status.md).
SDK/runner 0.1.5, server/CLI beta 42 and App beta 19 are public. App beta 19
has six qualified native targets; its Linux x64 marketplace and local keyless
controls passed with server beta 42. This used hosted `--no-sandbox` and made
no provider calls; Mac/Windows GUI and sandbox security are not qualified. The
[fresh public installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product42-public-installer-2026-10-17.json)
passed across distinct filesystems. The
[limited keyless lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b41-2026-10-17.json)
passed on beta 41; beta 42 changes acquisition only and preserves that provider
implementation. Its release source is
[`a1664344`](https://github.com/openagent-uno/openagent/commit/a16643449b9a5fc027eb9d0f3ee7326ecd302654).

## Standalone configuration

The server loads a local runner and registers its managed sources through the
public Core capability API. The runner is trusted local IPC, not an exposed
HTTP service. It belongs on the server executing provider requests, not just
on the client displaying the marketplace.

```yaml
connectors:
  runner_path: /opt/openagent/connectors/bin/openagent-connector-runner
  auth_url: https://auth.openagent.uno
  # Released server beta 40: explicitly enable the public beta providers.
  # Use [] to disable common OAuth enrollment on this server.
  official_providers: [clickup, github, notion]
  # Optional, for the operator's own app registrations:
  # oauth_providers_file: /private/openagent/oauth-providers.json
```

The runner can also be selected with `OPENAGENT_CONNECTOR_RUNNER`, or discovered
on the server's PATH. Frozen server builds verify and bundle the consumer-pinned
runner. If it is missing, the authenticated catalog remains visible but marks
operations unavailable.

`official_providers` uses provider IDs: `gmail`, `google_drive`,
`google_analytics`, `clickup`, `github`, `notion`, `atlassian`,
`slack_import`, `shopify` and `postiz`. These differ from display
catalog IDs such as `google-drive`. A nonempty list does not configure the
central provider or bypass product policy. Standalone Shopify is independently
blocked until the local privacy processor is qualified. An empty OAuth list
does not disable token/account connectors that are configured locally.

Server beta 41 and beta 42 resolve common OAuth availability in this order:

1. An explicit `connectors.official_providers` list wins, including `[]`.
2. Otherwise, a present `OPENAGENT_CONNECTOR_AUTH_PROVIDERS` value supplies the
   comma-separated list. An empty value disables common OAuth enrollment.
3. Only when both settings are absent, it defaults to `clickup`, `github` and
   `notion`.

This changes catalog eligibility, not consent. It creates no connection,
provider grant or automatic broker registration. A fresh keyless-only server
also does not poll the broker. Existing OAuth installations may continue their
registered synchronization. The released beta 40 keeps its earlier explicit
opt-in requirement; use the YAML list above or the environment variable to opt
in. The three-provider broker beta was deployed separately, without new grants.
Empty OAuth lists do not disable local token/account or keyless connections.

The candidate Shopify setup asks for the canonical store domain, for example
`your-store.myshopify.com`, in the App or CLI. The authenticated create request
stores it as `config.shop` and passes it to the broker before consent. Reconnect
reuses that store, or the verified store in an older locally held credential;
it cannot silently select another store. This input does not enable enrollment
or bypass the independent Shopify privacy and provider qualification gates.

The server stores its signing/encryption identity in `connectors-identity.json`
and its credential encryption key in `connector-credential-key`, alongside its
configured database. Protect this host-owned directory; it must not be an
agent-writable workspace. Preserve these files and database state during an
upgrade. Tokens are not app settings or CLI arguments and must not be written
into a prompt, source repository or logs.

The candidate host refuses to create a replacement key when encrypted
credentials or privacy notifications already exist. If a restore reports a
missing credential key, recover the matching key from the protected backup
before starting the host. Do not clear records or create a new key to bypass
the recovery error.

## Embedding host opt-in

Go embedding hosts import the same versioned connector module. They retain their
existing credential store, membership checks, installation IDs and agent grants.
An operator explicitly configures:

```text
OPENAGENT_CONNECTOR_AUTH_IDENTITY_FILE=/private/product/connectors-identity.json
OPENAGENT_CONNECTOR_AUTH_URL=https://auth.openagent.uno
OPENAGENT_CONNECTOR_AUTH_PROVIDERS=<qualified provider IDs, comma-separated>
```

Enable only the providers accepted for that receiving host. The shared service
currently accepts `clickup`, `github` and `notion`; listing a disabled provider
locally cannot activate it centrally.
A native host supervisor passes only these public configuration values to its
API process, and only when an identity path is supplied. It does not inherit
app secrets or all environment variables into that child. New credentials still
require the product's local authority check before their storage transaction.

A local host product remains a server/client product: customer accounts, database, files
and agents are on that installation. Its public site is presentation/download
hosting. Enabling common OAuth does not turn it into a cloud account service.

## Pinning the shared implementation

A Go host consumes
`github.com/openagent-uno/openagent-tools/packages/connectors@v0.1.5`; its
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

Beta 42 also handles an installation and temporary wheelhouse on distinct
filesystems. Its
[fresh public-installer receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product42-public-installer-2026-10-17.json)
records the ordinary server-plus-CLI installer and dependency checks with no
source overlay or same-mount workaround. Beta 41's first EXDEV failure and
same-prefix recovery with owned same-mount `TMPDIR` remain historical evidence;
they are not relabeled as fresh installer success.

The shared Python package exposes `ConnectorRunner` and the optional
`openagent_connectors.mcp.serve_connector` surface. An embedding host supplies
an authorizing connector factory and credential/connection context. Do not
publish the raw runner protocol or credentials as a model-controlled MCP
endpoint. See the [shared library contract](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.5/packages/connectors).

## Keyless connectors

[SDK 0.1.5 is public](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.5)
with 16 official adapters plus Custom MCP. Its remote SDK qualification and
[four limited real reads](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.5-2026-10-17.json)
passed. Published server/CLI beta 42 adopts SDK 0.1.5. Two normal connections,
four public reads across a real restart and both local disconnects passed on
beta 41 through certified CLI/Iroh/gateway workflows. The provider code is
unchanged in beta 42; this does not relabel those reads as beta 42 provider
tests. App beta 19 is published; its [Linux x64 marketplace and local controls](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
passed with server beta 42, separately from provider reads. Exa and Firecrawl
each passed Connect, disable/re-enable and disconnect without credential forms
or OAuth controls. No provider call or model was used; hosted `--no-sandbox`
does not qualify sandbox security or Mac/Windows GUI. The
historical beta 40/App beta 18 trial retains SDK 0.1.4 and its 14-entry catalog.
Their official hosted MCP services offer limited access without an account or
API key. This mode exposes only the reviewed read tools: Exa search/fetch and
Firecrawl search/Markdown scrape. It does not include paid features or an
automatic authenticated fallback. See the provider's current
[Exa contract](https://exa.ai/docs/get-started/exa-mcp) and
[Firecrawl contract](https://docs.firecrawl.dev/mcp-server/keyless) for limits.

The published App beta 19 uses **Install** on the normal marketplace card and
then **Connect**. On the published beta 42 CLI/server, run `openagent-cli connectors connect exa`
or `openagent-cli connectors connect firecrawl`. No key, OAuth page or token
prompt is required. Enable/disable and disconnect remain local controls, and
multiple connections keep separate local owner/tenant bindings and grants.
These four tools are read-only; a local changes toggle does not add writes.
There is no provider credential to refresh or revoke for a keyless connection.

The authenticated create request contains only the ordinary connection fields:

```json
{"catalog_id":"exa","allow_write":false,"config":{}}
```

Keyless connections reject token fields and provider configuration. The host
stores no provider token, credential nonce or OAuth app ID for them. An embedding host passes the
explicit runner credential `{"kind":"none"}` only for a trusted catalog entry
whose reviewed adapter declares this contract. An absent or empty credential
never downgrades an authenticated connector to keyless access. Tenant, owner,
audience, enabled state and tool grants are checked on every invocation.

The receiving server calls the compiled provider endpoint directly. The broker
does not register or receive traffic from a fresh keyless-only installation.
Provider quotas and outages remain possible; calls make one attempt and do not
retry a quota failure or switch plans. Endpoints and remote tool names cannot
be supplied by model arguments; adding tools requires a reviewed SDK release.

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
[`openagent-connectors/v1`](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.5/packages/connectors).

## Own provider apps

Google, ClickUp and Postiz own-app configuration uses the shared provider
descriptor array, with client identity, a protected secret-file reference,
registered endpoints, redirect, scopes and PKCE settings. The standalone's
own-app redirect must use the explicitly configured loopback callback supported
by that provider. Multiple agents on one machine need separate reserved callback
ports. Product-local own-app credentials stay local.

Shopify own apps serving several servers need their own configured broker
instance, so acquisition/refresh can be coordinated per app and shop. Existing
Embedding hosts' registrations retain their existing compatible own-app paths.
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

On 13 October 2026 the approved authentication-service control-plane maintenance enabled and
rotated Kubernetes secrets-at-rest encryption. Live status and a final restart
were verified, with unchanged broker Secret values and a protected consistent
post-rotation backup. A cluster restore must preserve its matching server token,
encryption credentials and configuration; never replace encryption keys or
restore the datastore alone. The [status checkpoint](./connector-status.md)
distinguishes this storage qualification from outstanding provider/load tests.

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
