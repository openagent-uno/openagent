# Shared components and connector architecture

OpenAgent shares implementations across products while each product owns its
accounts, authorization and persistent data. Each standalone or independently
embedded installation keeps its own accounts; it does not become an account on
a central OpenAgent agent server. The common OAuth service is an optional dependency for common provider
apps; it is not the authority for the agent network or product users.

For the current qualification and remaining work, see
[Connector release status](./connector-status.md). For end-user actions, see
[Using connectors](./connectors.md).

For composing applications over several accounts or sources, see
[Composable applications](./application-composition.md). Shared provider
adapters supply operations; application state, projections, interactive views
and synchronization remain explicit host service contracts. A connector card
or a successful OAuth connection does not establish those application features.

## What is shared

| Component | Owner | Consuming products |
| --- | --- | --- |
| Runtime, sessions, runs, module services and uniform capability contracts | OpenAgent Core | Standalone and embedding products |
| Filesystem, editor, shell, web search, computer and browser implementations | OpenAgent Tools | Server or authenticated client capability hosts |
| Official connector catalog, operation schemas, provider adapters, scope checks, pagination and permitted retry logic | OpenAgent Tools `packages/connectors` | Go embedding hosts as a dependency; standalone through a local runner |
| Local connector runner and Python/MCP transport adapter | OpenAgent Tools | Python hosts and products exposing a connector through MCP |
| OAuth app exchange, secret-dependent renewal and Shopify coordination | Separately deployed `connector-auth` | Explicitly configured receiving installations |
| Accounts, tenants, grants, credential storage, audit, local privacy actions and UI | Each product | Its own installation and users |

The shared connector release is `0.1.5`, with Go module tag
`packages/connectors/v0.1.5` and runner release `connectors-v0.1.5`. Its catalog
contains 16 official adapters plus Custom MCP.
[Source and contract](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.5/packages/connectors)
and [platform artifacts](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.5)
are independently versioned from the standalone product. The platform release
is a qualification prerelease, not native signing or provider acceptance.
Its `qualification.json` records the tested boundaries alongside the source,
platform manifests and checksums. The deployed broker is independently released
as [auth-only 0.1.6](https://github.com/openagent-uno/openagent-tools/releases/tag/connector-auth-v0.1.6).
The deployed service includes a later reviewed Slack refresh fix recorded
in the [release checkpoint](./connector-status.md).
This does not change the version pinned by an installed product. A separate
configuration rollout on 17 October opened ClickUp, GitHub and Notion as a
limited public beta. The receiving host still authorizes each connection and
the user completes provider consent. Other providers retain their activation
gates; no general throughput or additional provider acceptance is inferred.

The standalone [server/CLI beta 40](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.40)
assembles public Core beta 22, connector 0.1.4 and
[Host Tools B6](https://github.com/openagent-uno/openagent/releases/tag/v1.0.0b6).
B6 has six qualified native targets and signed/notarized macOS bundles; its
release-index SHA-256 is
`a0f85b84e6d98f525c466126df7a5de9437d9628127607517a94f1b61b1889e0`.
[App beta 18](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.18)
is released independently. Its recorded Linux x64 marketplace trial uses
server beta 40 and SDK/runner 0.1.4, with 14 official entries and registry MCPs
in the same grid. Native release qualification and marketplace presentation
acceptance remain separate from provider consent and API operations. The
[earlier App beta 17](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.17)
trial with server beta 39 remains historical evidence; neither trial establishes
Mac or Windows marketplace GUI acceptance.
Each host owns its locked dependency assembly, installation, enabled storage
surfaces and release qualification. A public component release never silently
updates another host or attests its data-processing coverage.

SDK 0.1.5 adds Exa and Firecrawl through their official hosted MCPs, with
two compiled read tools each. The
[four real keyless reads](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.5-2026-10-17.json)
qualify the SDK runner only. Published
[server/CLI beta 41](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.41)
adopts SDK 0.1.5 and exposes 16 official entries plus Custom MCP. App beta 19
publication, the new product workflow/restart lifecycle and visual acceptance
remain pending. The historical beta 40/App beta 18 trial above continues to
describe SDK 0.1.4 and 14 entries.

A keyless connector still has a host-authorized connection and tool source.
Only a reviewed no-auth adapter accepts the explicit `{"kind":"none"}` contract;
an omitted token is never a fallback. Fixed provider endpoints and tool names
remain in the adapter, while owner/tenant grants, enable/disable, disconnect and
audit remain with the receiving host. No provider token is stored and no OAuth
refresh or broker exchange is needed. Server beta 41 defaults to public
ClickUp/GitHub/Notion catalog eligibility only when operator settings are absent;
explicit empty settings stay disabled and no default creates a grant. Fresh
keyless-only servers do not register with or poll the broker. See
[configuration precedence](./connector-operations.md#standalone-configuration).

Existing catalog IDs and tool names are preserved. Adding a shared adapter
must update its catalog entry, schemas, operation implementation and tests;
each product then consumes an explicitly pinned version. A catalog placeholder
without implemented tools remains unavailable.

## Core capabilities, tools, MCPs and connectors

A **tool** is an operation exposed through the Core capability catalog. A
**source** binds those operations to an executor and an authorized destination.
A **connector** implements a provider integration. **MCP** is a transport for
external tool servers. These are related concepts, not interchangeable package
types.

Core modules can expose native tools without an MCP process. A connector may
be called through a Go host adapter or a local Python capability source; an MCP
surface is available when a consuming host needs that protocol. The same
provider logic is used in either case. Sharing a connector does not require
routing every request through a remote shared MCP server.

External registry MCPs remain a separate implementation path even when their
cards appear in the same marketplace. Their endpoints, runtimes and trust
review belong to the receiving product. A public registry listing or an
operator-supplied product name is not an OpenAgent endorsement.

```mermaid
flowchart TB
  Core[OpenAgent Core public capability APIs]
  Shared[Shared catalog, schemas and provider adapters]
  Host[Independent Go host gateway]
  Runner[Local Go runner]
  Python[Standalone Python host adapter]
  MCP[Optional host-authorized MCP surface]
  API[Provider API]
  Shared --> Host
  Shared --> Runner
  Runner --> Python
  Runner --> MCP
  Python --> Core
  Host --> API
  Runner --> API
```

Embedding hosts supply their own identity and workspace/project policy.
The standalone supplies a verified network/device principal and registers
`OfficialConnectorSource` through Core's public catalog API. Core does not
import provider app secrets, product accounts or the broker implementation.
Trusted runner IPC carries credentials separately from model tool arguments;
it is not an unauthenticated network API.

## Data and authorization boundaries

The host supplies a connection binding, current credential, operation ID and
audit. It checks local authority before saving an OAuth result and again at
operation admission. The adapter enforces supported tool names, granted scopes,
read/write gates and provider-specific request rules. A model argument cannot
select another installation, owner, token or computer.

In the standalone, connector tools are bound to the initiating principal,
tenant and permitted result audience. In embedded host products, existing
membership, connection/installation identity, project scope and agent grants
remain authoritative. Sharing code never merges those permission systems.

Normal Gmail, Drive, task, shop and other provider requests originate from the
receiving product server. The broker performs confidential authentication
exchanges and a minimal Shopify shop-identity check. It does not proxy normal
provider contents. Connected data may still enter the product's transcripts,
files, Vault or configured model-provider requests; the product must govern
those destinations. See [Privacy](../privacy.md).

## Common OAuth without public local callbacks

```mermaid
sequenceDiagram
  participant Client as Product app or CLI
  participant Host as Receiving product server
  participant Auth as auth.openagent.uno
  participant Provider
  Client->>Host: Request connection with local authority
  Host->>Auth: Signed installation-bound transaction
  Auth-->>Host: Recipient-bound authorization URL
  Host-->>Client: Open browser authorization
  Client->>Auth: Verify recipient and approve requested permissions
  Auth-->>Client: Provider authorization URL
  Client->>Provider: User grants requested provider access
  Provider->>Auth: Callback with authorization code
  Host->>Auth: Signed outgoing poll and single-use redeem
  Auth->>Provider: Confidential code exchange
  Auth-->>Host: Transient token result
  Host->>Host: Recheck authority and save encrypted credential
  Host->>Provider: Normal direct API requests
```

Installations keep persistent Ed25519 signing and X25519 encryption keys.
Requests bind method, path/query, body, time and nonce. Transactions bind the
installation, provider and requested permissions, expire and can be redeemed
only once. The consent page identifies the receiving product/name and
cryptographic installation ID. Third-party installations use the same
versioned protocol and limits without receiving an approval badge.

The broker permanently stores identity/authorization metadata, keyed token
fingerprints, Shopify group generations and an encrypted minimized event queue.
It does not permanently store access tokens, refresh tokens, codes or
installation private keys. Tokens are transient during exchange and renewal.
Temporary peer token envelopes expire within ten minutes and are not a durable
central credential archive.

Own OAuth apps remain supported. Locally valid tokens and token-authenticated
connectors continue during a broker outage; new common consents and renewals
requiring the central app secret cannot complete during that outage.

## Shopify: one app and shop, several recipients

Shopify token acquisition and renewal must be coordinated for the same app and
shop; issuing a token concurrently can retire another operation's result.
The shared broker serializes both and tracks the current generation. The
requesting server atomically stores the entire replacement pair, commits its
checkpoint and sends a separately encrypted envelope to each authorized peer.
These constraints follow [Shopify's token lifecycle](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).

Every additional server must obtain verified Shopify consent and explicit
recipient authorization. The broker verifies numeric shop identity; a shop
name in an unsigned routing header is not sufficient. Each server keeps its
own tool permissions. A peer that missed an envelope asks a current peer for
a copy through outgoing polling; if no current copy is recoverable, it requires
fresh consent rather than reusing an uncertain credential.

Privacy and uninstall notifications enter a durable queue with verification,
deduplication, acknowledgments and retry. Products perform their own export and
redaction. Acknowledging durable receipt is not proof that local privacy work
has finished. The compatibility outbox can relay notifications to a legacy
host processor during migration, but that relay has not been activated
in production. Standalone beta 39 qualifies an opt-in worker for a fresh
canonical text-history cohort; historical content and other enabled storage
surfaces still require qualification. Common Shopify enrollment remains
disabled. See [release gates](./connector-status.md).

Existing credentials keep their issuing OAuth app. They are not silently
reassigned. Shopify can retire credentials during a later acquisition or
migration, so the rollout must coordinate remaining legacy token issuers and
recipient reconnection; old tokens are not promised indefinite validity.
See [Shopify's migration requirements](https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens).

## Privacy processing still required

The current standalone inbox is only the delivery boundary. Completing privacy
processing requires trusted lineage from a connection/result into transcripts,
compacted history, delegated sessions, Vault notes, attachments and generated
files. Provenance must remain bound to the authorized tenant and provider
account; model-supplied labels cannot authorize a privacy action.

The beta 39 inbox persists the complete broker receipt encrypted, including
group/topic and occurrence timestamps, before acknowledging delivery. This
preserves the generation fence across restart and duplicate delivery. Historical
payload-only receipts retain an explicit older format; missing metadata is
never inferred from the local receive time. These storage guarantees do not
complete a privacy request or enable Shopify enrollment.

The host needs durable, idempotent jobs for the verified provider request,
bounded export/redaction, admission fences while affected work is running,
and completion receipts. [Core beta 22](https://github.com/openagent-uno/openagent-core/releases/tag/v1.1.0-beta.22)
publishes reusable content/provenance contracts through public services. Its
installed-wheel qualification covers a fresh, canonical text-history cohort,
including selected records, derived history, compaction and child sessions.
The receiving product interprets Shopify events, selects the verified
customer/store and binds its own qualified storage surfaces before runtime
startup. Unqualified historical content, backups, media, Vault/files or custom
callbacks keep processing blocked. Publishing Core does not qualify a host
adapter or migrate existing data. Clearing a token or acknowledging a webhook
cannot substitute for completing local privacy jobs.

Standalone processing requires the strict boolean opt-in
`connectors.privacy.enabled=true`. Coverage is computed from the actual
NativeProvider/ModelDispatcher, exact canonical dashboard content validator,
baseline history audit and public sinks registered before startup/recovery and
connector publication. A `covered_surfaces` configuration field is rejected;
an operator or model cannot declare an unsupported callback or storage surface
qualified. The published API exposes provenance, fences and processing jobs;
provider event mapping, authorized export destinations and the runtime/storage
assembly remain host-owned. Text-only qualification does not enable common
Shopify or establish real-provider consent and two-server rotation acceptance.

## Shared code and product UI

The standalone marketplace uses one card component and one responsive grid for
provider integrations and registry MCPs. Official entries have the official provider
marks, without a dedicated tab, heading, label or
divider. The original logo assets and their source hashes are bundled locally.
They are currently packaged by each client, rather than fetched from a central
runtime UI service.

Host management screens and permission controls remain product code. The
shared library is not a shared React application, shared database or global
MCP credential store. Core exposes public contracts; products build their
surfaces from those contracts without engine forks or installation overlays.

### Remote MCP authentication: remaining work

The current MCP configuration's `oauth` flag is stored but is not connected to
an OAuth client in the HTTP transport. Turning it on does not start a complete
browser authorization flow. Static MCP headers are configuration returned to
authorized catalog readers; they are not the credential store for new personal
OAuth connections. Ordinary mutable MCP sources also do not carry the
per-connection owner binding used by official connector grants.

Adding authenticated official remote MCPs therefore needs one reusable managed
source per connection: locally encrypted OAuth/client-registration state,
an authenticated browser callback bound to its owner and installation, and
tenant/owner/audience/generation checks before tool calls and credential saves.
Public catalog responses expose connection state and tool descriptions, without
tokens. The host can register that source through Core's public capability APIs;
provider-specific API adapters need not be duplicated. Generic pool support can
then accept host-supplied HTTP authentication through a public hook.

For example, [Supabase's official MCP](https://supabase.com/docs/guides/ai-tools/mcp)
supports dynamic client registration without a manually created app or PAT, with
project and read-only restrictions. [Firecrawl documents an OAuth MCP endpoint](https://docs.firecrawl.dev/mcp-server/oauth);
its registration and callback compatibility still need qualification. Neither
integration is marked ready by this architecture note. Transport authentication,
consent, owner isolation, refresh/restart and supported elicitation behavior must
be verified before a card offers authenticated use.

## Operational limits

The first broker deployment is one writer, one metadata volume and a `Recreate`
rollout. It cannot be scaled by adding replicas against the same state file.
High availability requires a transactional store and distributed coordination
before multiple writers are admitted. Native runtime/signing qualification,
production secret storage, provider reviews and real product acceptance remain
separate from library unit tests and cross-compilation.

See [operator setup and recovery](./connector-operations.md) for configuration,
backup boundaries, API contracts and troubleshooting.
