# Connector setup, embedding and recovery

This guide is for server operators and embedding products. ClickUp, GitHub,
Notion, Outlook Mail/Calendar and OneDrive common-app enrollment is available as
a limited beta. Google is restricted to its approved Testing audience; SharePoint
retains its eligible-account [qualification boundary](./connector-status.md).
Current published Python components are **SDK/runner 0.1.8 and server/CLI beta46**: 114 official connectors plus Custom MCP, including 90 token profiles with two specific reads each and read-only OneDrive/SharePoint. Real account/provider acceptance remains separate.
[App22 is public](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.22).
The [App22/server45 Linux x64 marketplace receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app22-server45-marketplace-2026-10-18.json)
records 114 official cards, 30 registry results and ten reviewed images. It
verified blank Postman setup and one local Exa control cycle, with zero provider
calls, model turns or OAuth grants. App21/server44 remains historical evidence.
The earlier App beta20/server43 [normal public installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json),
[three-connection/six-workflow lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b43-2026-10-17.json)
and [Linux x64 marketplace/local controls](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-server43-marketplace-2026-10-17.json)
passed separately. The GUI uses hosted `--no-sandbox` and made zero provider
calls; Mac/Windows marketplace GUI and sandbox security are unqualified.

## Standalone configuration

The server loads a local runner and registers its managed sources through the
public Core capability API. The runner is trusted local IPC, not an exposed
HTTP service. It belongs on the server executing provider requests, not just
on the client displaying the marketplace.

```yaml
connectors:
  runner_path: /opt/openagent/connectors/bin/openagent-connector-runner
  auth_url: https://auth.openagent.uno
  # Controlled Google Testing: explicit lists REPLACE the server default.
  # Keep the six qualified beta providers and add the four Google profiles.
  # Use [] to disable common OAuth enrollment on this server.
  official_providers:
    - clickup
    - github
    - notion
    - outlook_mail
    - outlook_calendar
    - onedrive
    - gmail
    - google_drive
    - google_analytics
    - google_calendar
  # Optional, for the operator's own app registrations:
  # oauth_providers_file: /private/openagent/oauth-providers.json
```

The runner can also be selected with `OPENAGENT_CONNECTOR_RUNNER`, or discovered
on the server's PATH. Frozen server builds verify and bundle the consumer-pinned
runner. If it is missing, the authenticated catalog remains visible but marks
operations unavailable.

`official_providers` uses provider IDs: `gmail`, `google_drive`,
`google_analytics`, `google_calendar`, `outlook_mail`, `outlook_calendar`,
`onedrive`, `sharepoint`, `clickup`, `github`, `notion`, `atlassian`,
`slack_import`, `shopify` and `postiz`. These differ from display
catalog IDs such as `google-drive`. A nonempty list does not configure the
central provider or bypass product policy. Standalone Shopify is independently
blocked until the local privacy processor is qualified. An empty OAuth list
does not disable token/account connectors that are configured locally.

Server beta46 resolves common OAuth availability in this order:

1. An explicit `connectors.official_providers` list wins, including `[]`.
2. Otherwise, a present `OPENAGENT_CONNECTOR_AUTH_PROVIDERS` value supplies the
   comma-separated list. An empty value disables common OAuth enrollment.
3. Only when both settings are absent, it defaults to `clickup`, `github`,
   `notion`, `outlook_mail`, `outlook_calendar` and `onedrive`.

This changes catalog eligibility, not consent. It creates no connection,
provider grant or automatic broker registration. A fresh keyless-only server
also does not poll the broker. Existing OAuth installations may continue their
registered synchronization. The released beta 40 keeps its earlier explicit
opt-in requirement; use the YAML list above or the environment variable to opt
in. The three-provider broker beta was deployed separately, without new grants.
Empty OAuth lists do not disable local token/account or keyless connections.

The ten-provider example is for the approved Google **Testing** audience only.
Explicit configuration and `OPENAGENT_CONNECTOR_AUTH_PROVIDERS` replace the
resolved list; they do not append to it. Include all desired providers rather
than setting only the four Google IDs and unintentionally hiding the others.
SharePoint is deliberately separate: an operator-authorized trial with an
eligible work/school account must explicitly include `sharepoint` while retaining
any other desired IDs. That opt-in grants no tenant consent or site access;
the eligible-account SharePoint lifecycle remains unqualified.

[Published beta46](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.46)
ships the six-provider default. Published betas43–45 retain their historical
three-provider default; publishing beta46 does not update an existing host.
Google Testing still needs the full explicit ten-provider override; SharePoint
remains a separate opt-in. The real provider lifecycle receipts below used
public server45 with an explicit opt-in and are not relabeled as beta46 trials.
The [installed beta46 qualification](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product46-installed-2026-10-19.json)
and [normal public-source installer46](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product46-public-installer-2026-10-19.json)
passed. The latter installed server and thin CLI separately, checked both
prefixes' dependencies, ORM, the 114-plus-Custom catalog and the six-provider
constructor default, without enrollment or provider/model calls. It used the
immutable public script at `4e6a8bbb`, SHA256
`05fcb4f1f5c984253efd4e6b01288fb4827575bf213a05d8b43a3d3455f3fe0b`.
The linked installer receipt tracks live website byte equality separately from
these installation tests.
App22 reads server-provided availability and needs no new binary for these
server settings; native App provider-operation acceptance remains separate.

The [SDK18 broker image-only checkpoint](https://github.com/openagent-uno/openagent-tools/blob/7e3c6f829b22a8dcfa3bdce79416580a365ab12f/deploy/connector-auth/qualification-2026-10-19.md)
retained those three providers. Preparing more provider rows or storing an app
secret does not activate a receiving server. Google Testing trials use only the
approved test audience. Microsoft's immutable secret is now stored and mounted
read-only; normal startup as UID 65532 verified the projected file. The first
additive rollout was rolled back after a provider-specific startup-validation
failure. The [source fix](https://github.com/openagent-uno/openagent-tools/commit/975d9426b1373b1db0c1b7f75d329451f3cf5d75)
passed auth/OAuth tests, vet and a static Linux amd64 build. Its scanned image
`sha256:1040f2873a8bdb35f128cb0cee6851e718b787a2328619173e1c8466bd20121a`
recovered eleven-provider technical readiness at 08:14:17 UTC on 19 October:
one Ready writer, health/readiness 200 and unsigned request 401. At that
server45 checkpoint, its three-provider default was unchanged. Beta46's
six-provider default is recorded above; Google Testing and SharePoint still
need explicit host configuration. Broker readiness establishes neither general
Google audience approval nor account access. The current [diagnostic broker](https://github.com/openagent-uno/openagent-tools/blob/4c73501009c7f9d81dd0adec2223232dee839fcc/deploy/connector-auth/qualification-2026-10-19-diagnostics.json)
uses source `645e0484` and image
`sha256:04d942f6cc69a59af958911a21a3f4ca2e1901a456d43220b8ac3061a6e13c5d`;
its image-only rollout passed at 08:43:13 UTC with the configuration preserved.
Fresh Google Drive, Analytics, Calendar and Gmail connection/read/owner-refresh
trials passed, followed by a real same-identity server restart, four post-restart
workflow reads and normal local disconnect/tombstone/source removal. The
[four-connector receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/google-four-product45-oauth-2026-10-19.json)
records those exact operations. The later Microsoft receipt below closes final
owned receiving-runtime and worker cleanup.
Earlier Google Calendar/Gmail/Outlook Calendar reads/refresh and the private
Calendar-event mutation trial retain their original scope: the old receiver hit
its deadline and lost local state before restart/disconnect qualification.

Outlook Mail's normal product poll returned HTTP503. The broker safely reports
`stage=scopes reason=scope_config provider_error=none`; token and raw scope values
remain private and the configured-scope check stays fail-closed. Microsoft's
[documented same-resource cumulative consent](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/resources-and-scopes#consent-lifetime)
requires an app/recipient design that preserves actual token permissions, not
just filtered metadata. Operator-approved registrations per connector family
have verified Web callbacks, least-privilege delegated declarations and separate
immutable secret custody; each family remains shared across receiving products.
The original Calendar registration is retained with Calendar-only permissions
and callback. The operator separately removed its old account grant before the
next test. The [family configuration rollout](https://github.com/openagent-uno/openagent-tools/blob/a52c1bbdd45fca768052cfd37b89f0ecba238f58/deploy/connector-auth/qualification-2026-10-19-microsoft-families.json)
passed without changing the image. Fresh Mail, Calendar and OneDrive redemption,
workflow reads and owner refresh passed. They also passed a real same-identity
process restart, three post-restart reads and normal local disconnect/tombstone/
source removal. The three issuing registrations matched public product metadata;
the [Microsoft lifecycle and final-cleanup receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/microsoft-three-product45-oauth-2026-10-19.json)
records final process quiescence and guarded worker deletion. Local disconnect
is distinct from provider-wide revocation. Mail is limited to `folders.list`, Calendar to a calendar
list and OneDrive to `drives.list`; no send, draft, event write, file change or
drive provisioning is qualified. The SharePoint personal-account attempt was
blocked before consent with a work/school-account requirement. Record that
observed account boundary without inferring a license requirement or granting
organization-wide consent. A final
receipt must identify the exact tested operations and any account/tenant result
without exposing content or credentials.

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
`github.com/openagent-uno/openagent-tools/packages/connectors@v0.1.8`; its
`go.mod`/`go.sum` must resolve the published module, rather than an accidental
sibling replacement. The standalone consumer lock is
`apps/server/connectors.lock.json` and binds the source commit, manifest,
platform archive and wheel hashes. Public server45 pins SDK18; older installations
retain their existing component versions until explicitly updated.

From a matching source checkout containing the acquisition script:

```sh
python3.11 apps/server/scripts/acquire-connectors.py   --platform darwin-arm64   --output /tmp/connectors-verified-new   --wheelhouse /tmp/connectors-wheelhouse-new
```

Use a fresh output directory. Targets are `darwin-arm64`, `darwin-x64`,
`linux-arm64`, `linux-x64`, `win32-arm64` and `win32-x64`. `--assets` accepts a
local release directory for an offline build while preserving checksum checks.
Acquisition does not install Python dependencies or qualify native signing.

The [normal beta 43 installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json)
passed with default HOME/TMPDIR, using the public manifest and pinned runner.
The [beta 42 acquisition repair](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product42-public-installer-2026-10-17.json)
retains its distinct-mount proof. The [initial beta 41 EXDEV and recovery](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b41-2026-10-17.json)
remain historical evidence; neither is relabeled as a new provider test.

The shared Python package exposes `ConnectorRunner` and the optional
`openagent_connectors.mcp.serve_connector` surface. An embedding host supplies
an authorizing connector factory and credential/connection context. Do not
publish the raw runner protocol or credentials as a model-controlled MCP
endpoint. See the [shared library contract](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.8/packages/connectors).

## Keyless connectors

[SDK 0.1.6](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.6)
contains 19 official adapters plus Custom MCP. Five providers have reviewed
keyless read-only contracts: Exa search/fetch, Firecrawl search/scrape, Parallel
search/excerpt fetch, Context7 library resolution/docs, and CoinGecko bounded
prices/global aggregates. Public fixed MCP endpoints and tool schemas are
compiled into the shared adapter; there is no arbitrary remote tool, SDK code,
paid fallback or client-selected endpoint.

| Provider | Local bounds and qualification |
| --- | --- |
| [Exa](https://exa.ai/docs/get-started/exa-mcp) | Up to 10 results or 5 public URLs; limited SDK reads and beta 41 fetch workflow lifecycle |
| [Firecrawl](https://docs.firecrawl.dev/mcp-server/keyless) | Up to 10 results or one public-page Markdown scrape; limited SDK reads and beta 41 scrape workflow lifecycle |
| [Parallel Search](https://docs.parallel.ai/integrations/mcp/search-mcp) | Up to 3 search queries or 5 public URLs; failed per-URL results fail the operation; both SDK reads and beta 43 fetch workflow lifecycle |
| [Context7](https://github.com/upstash/context7) | Typed library resolution/query; bounded text and exact library ID; both SDK reads and beta 43 query workflow lifecycle |
| [CoinGecko](https://docs.coingecko.com/docs/mcp-server) | Up to 10 coin IDs and 3 currencies, or global aggregates; fixed server-owned SDK templates; both SDK reads and beta 43 global workflow lifecycle |

The [SDK six-read receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.6-2026-10-17.json)
and [beta 43 six-workflow lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b43-2026-10-17.json)
retain separate transport and telemetry scopes. [App beta 20/server 43 Linux GUI](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-server43-marketplace-2026-10-17.json)
passed all five local connection/control cycles without provider calls. Earlier
[SDK 0.1.5](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.5-2026-10-17.json),
[beta 41 provider reads](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b41-2026-10-17.json)
and [App beta 19/server 42 GUI](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
remain immutable historical evidence. None establishes full provider parity,
Mac/Windows marketplace GUI or hosted sandbox security.

In App beta 20 use **Install → Connect** on the normal marketplace card. On server/CLI beta 43:

```sh
openagent-cli connectors connect exa
openagent-cli connectors connect firecrawl
openagent-cli connectors connect parallel-search
openagent-cli connectors connect context7
openagent-cli connectors connect coingecko
```

No key, OAuth page or token prompt is required. Enable/disable and disconnect
remain local owner/tenant controls; multiple connections retain independent
bindings and tool grants. These tools are read-only and a changes toggle cannot
add writes. There is no provider credential to refresh or revoke.

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
[`openagent-connectors/v1`](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.8/packages/connectors).

## Own provider apps

Google, ClickUp and Postiz own-app configuration uses the shared provider
descriptor array, with client identity, a protected secret-file reference,
registered endpoints, redirect, scopes and PKCE settings. SDK17 additionally
supports `google_calendar`, `outlook_mail` and `outlook_calendar`; adopting
server44 is published; [App21 is public](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.21) with six native targets and 36 verified assets; [App21/server44 Linux x64 marketplace](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json) passed. The earlier App20/server43 pair retains its SDK16 receipt. The standalone's
own-app redirect must use the explicitly configured loopback callback supported
by that provider. Multiple agents on one machine need separate reserved callback
ports. Product-local own-app credentials stay local.

Shopify own apps serving several servers need their own configured broker
instance, so acquisition/refresh can be coordinated per app and shop. Existing
Embedding hosts' registrations retain their existing compatible own-app paths.
A connection's issuer remains the app that minted its credentials; swapping a
client ID or copying a secret is not a credential migration.

## Calendar and mail SDK 0.1.7

[SDK17 is published](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.7)
with an [exact qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/calendar-mail-sdk-0.1.7-2026-10-17.json).
It adds reusable operations, not a calendar app, email client or synchronization
service. Public server44 adopts SDK17 with [installed Python qualification](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/calendar-mail-product-1.1.0b44-2026-10-17.json).
The [fresh public installer44](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product44-public-installer-2026-10-17.json) passed combined server/CLI installation, dependency/version checks and the installed 22-plus-Custom catalog, without a source overlay or HOME/TMPDIR override. It started no server or model and made zero provider calls. [App21 is public](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.21) with six native targets and 36 verified assets; [App21/server44 Linux x64 marketplace](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json) passed; real Google/Microsoft account acceptance was pending at that historical checkpoint. The dated server45 trials above record later, limited acceptance. Common enrollment for
all three new provider IDs was closed in that historical cohort. The current
broker's technical trial configuration is recorded above; adding IDs to
`official_providers` alone cannot configure a central registration or grant
account access.

| Catalog / provider | Typed operations | Scope contract |
| --- | --- | --- |
| `google-calendar` / `google_calendar` | `files.google_calendar.` + `calendars.list/get`, `events.list/get/create/update/delete` | `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and `https://www.googleapis.com/auth/calendar.events` for the canonical full subset |
| `outlook-mail` / `outlook_mail` | `outreach.outlook_mail.` + `folders.list/get`, `messages.list/get`, `attachments.list/get`, `drafts.create/update`, `messages.send` | `offline_access`, `User.Read`, `Mail.ReadWrite`; separately request `Mail.Send` to expose send |
| `outlook-calendar` / `outlook_calendar` | `files.outlook_calendar.` + `calendars.list/get`, `events.list/get/create/update/delete` | `offline_access`, `User.Read`, `Calendars.ReadWrite` for the canonical full subset |

The adapters recognize documented method-specific read-only scopes and broader
provider scopes; they do not equate unrelated scope names. Local read/write
admission remains independent. `Mail.ReadWrite` authorizes drafts, never send;
`messages.send` also requires local publish admission. HTTP202 records acceptance,
not delivery. Outlook Calendar writes accept UTC times. This subset excludes
Graph delta sync, arbitrary OData, recurrence expansion, invitations, uploads
and MIME; Google writes exclude attendees and conferencing parameters. Editing
or deleting an existing meeting may still notify its existing guests.

For an operator-owned app on a qualified SDK17 host:

1. Register the app under the operator's actual identity, enable the required
   provider API, and register the callback supported by that app type. Google
   Calendar requires Calendar API enablement and accepted Calendar scopes.
   Microsoft requires the appropriate account/tenant audience and delegated
   Graph permissions. The original common registration initially saved seven
   delegated permissions. The current family layout uses `User.Read`
   and `offline_access` plus `Calendars.ReadWrite` for Calendar, `Files.Read` for
   OneDrive or `Sites.Read.All` for SharePoint; Mail has `Mail.ReadWrite` and the
   separately declared `Mail.Send`. Saving these declarations grants no admin or
   user consent. Console settings and immutable secret custody are verified;
   original projected mounting and eleven-provider technical startup passed.
   New family configuration, client authentication and real Microsoft lifecycles
   remain separate. Tenant/account restrictions are recorded from actual results;
   no new license or trial is implied. No existing user tokens migrate to another
   app automatically. A later [SharePoint credential rotation](https://github.com/openagent-uno/openagent-tools/blob/2e685b6a68b1fede45b61ed5530cc993ad4a80be/deploy/connector-auth/qualification-2026-10-19-microsoft-sharepoint-rotation.json)
   removed the prior provider credential and verified the replacement mount with health/readiness;
   app identity/scopes were preserved, without qualifying consent or site access.
2. Store app secrets in protected server-owned files. Set
   `connectors.oauth_providers_file` to the provider descriptor array using
   `id`, `app_id`, `client_id`, `secret_file`, `authorization_url`, `token_url`,
   `redirect_uri`, `scopes` and `pkce: true`. SDK17 own-app callbacks bind only
   `http://127.0.0.1:<reserved-port>/<registered-path>` on the receiving server.
   The browser callback must reach that server; separate local servers reserve
   different ports. Do not expose a private descriptor as tool arguments.
3. Use fixed Google authorize/token endpoints or Microsoft's global-cloud
   `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` and `/token`.
   Request Microsoft Graph resource-prefixed scopes; `offline_access` remains
   unprefixed. Sovereign-cloud and arbitrary tenant authorities are outside this
   SDK subset. The SDK verifies Microsoft `/me` with `User.Read` and retains the
   account ID through refresh; a different account requires a new connection.
4. Connect each account independently through the qualified host's normal
   marketplace/API/CLI controls. Recheck authorization before storing the
   result. Keep each connection's issuer, scopes and local enabled/write state.
   Perform real read/write/refresh/restart/disconnect qualification before
   enabling common enrollment. Source fixtures do not establish that acceptance.

Google hosts must store the query profile, page cursor and final `nextSyncToken`
with their own projection/checkpoint transaction. Preserve cancellation
tombstones and the documented query restrictions across pages. A 410
`sync_reset_required` requests an explicit host decision: the adapter does not
silently clear state or run a full resynchronization. Graph page envelopes bind
connection, verified account, operation and fixed resource path; they cannot be
reused for another source. Neither cursor implements an application sync engine.

Google Calendar and Outlook Calendar event updates/deletes, and Outlook Mail
draft updates, require the provider ETag. Google requires a strong ETag;
Microsoft accepts the validated provider ETag. A 412 `version_conflict` requires
a fresh read and explicit reconciliation, with no automatic overwrite. Every
operation makes one HTTP attempt; uncertain writes are not replayed. Go hosts
receive a bounded `ProviderError`; Python exposes `ConnectorError.code` and an
optional validated `provider_status`. No provider error body, header, credential
or request ID is exported through that error contract. Microsoft conditional
write behavior still needs real provider qualification. Local disconnect
removes only that product connection; this implementation does not expose a
Microsoft-wide consent-revocation endpoint.

See the [published SDK contract](https://github.com/openagent-uno/openagent-tools/blob/main/docs/connector-calendar-mail-0.1.7-candidate.md),
[Google Calendar authorization](https://developers.google.com/workspace/calendar/api/guides/auth),
[incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync),
and [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

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

Monitor `/healthz` separately from `/readyz`. A bootstrap configuration can
report healthy with zero configured providers while readiness correctly refuses
enrollment. The dated current broker checkpoint has eleven configured profiles
and health/readiness 200. Its readiness does not extend the specific provider
acceptance recorded above or qualify loaded capacity, peer recovery and
product-local privacy actions. The
[deployment runbook](https://github.com/openagent-uno/openagent-tools/tree/main/deploy/connector-auth)
contains the detailed operator gates.
