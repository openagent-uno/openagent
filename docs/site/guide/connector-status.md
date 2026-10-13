# Connector release and qualification status

Status recorded on **13 October 2026**. This page distinguishes implemented
code, published artifacts, deployed services and real provider acceptance.
A visible card or a passing health check alone does not make a connector ready
for production. It is a qualification checkpoint, not a promise that an older
installed client already includes the candidate UI.

## Delivery checkpoint

| Surface | Confirmed | Still required |
| --- | --- | --- |
| Shared Go connector module | Published `0.1.1`; ten implemented integrations, two unavailable placeholders; preserved IDs/tool contracts | Continue versioned adapter compatibility and release qualification |
| Runner and Python/MCP adapter | Published checksum/manifest prerelease for six OS/architecture targets; public acquisition verified | Native Windows/Linux/macOS runtime and signing acceptance |
| Standalone server/App/CLI | Candidate implementation uses the pinned shared release; real authenticated local catalog; unified App cards/search and connection controls verified on macOS; CLI management contracts pass | Qualified coordinated product release and real provider operations |
| GlassPalace | Shared module pinned; connector gateway and focused control-plane contracts pass; marketplace identifies shared integrations | Updated production/native delivery and final real UI/provider acceptance |
| ICS | Shared module pinned; native supervisor forwards explicit opt-in; real local native login, catalog and encrypted dummy-token connection/reload verified | Published updated native server/client and real provider acceptance |
| Common authentication service | HTTPS service deployed on Mixout; signed outgoing registration/mailbox and metadata restore verified; `0.1.1` release binary | Production storage/capacity qualification and provider activation |
| Common provider enrollment | **No provider enabled** in the central deployment at this checkpoint | Complete the gates below before enabling new common consents |

The [connector prerelease](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.1)
is distinct from [standalone product downloads](../downloads.md). Code is being
reviewed in the [standalone integration PR](https://github.com/openagent-uno/openagent/pull/2)
and [Tools PR](https://github.com/openagent-uno/openagent-tools/pull/2).
Provider availability is reported by the authenticated server catalog, not
inferred from a downloaded binary or logo.

## Provider registration checkpoint

- **Google:** OpenAgent app/client, callbacks, test audience and the existing
  connector scope set are prepared. Gmail, Drive, Analytics Data and Analytics
  Admin APIs were individually enabled and verified. The app remains in Testing;
  applicable verification and security assessment are not complete.
- **ClickUp:** the existing GlassPalace registration is reused. Its old redirect
  was removed at the operator's request; ClickUp saved the common auth origin.
  The actual callback path still needs a real round-trip test. Existing tokens
  were not revoked by this configuration change.
- **Shopify:** the original GlassPalace registration is retained, renamed
  **OpenAgent**, and its released version is Active. The common callback was
  added; existing page, scopes, secrets and legacy webhook endpoints were kept.
  This records the existing app's configuration, not a new review approval.
- **Postiz:** the reviewed common app registration is still pending.
- **Token/account connectors:** no common OAuth app is needed. Product-local
  configuration is implemented; dummy-token tests do not validate a real account.

## What the tests establish

Shared Go race/vet and adapter tests cover operation compatibility, scopes,
pagination, permitted retry behavior, replay/recipient fences, Shopify
coordination/recovery and durable webhook retry/deduplication. Provider responses
in these tests are controlled fixtures.

Standalone storage/authorization and acquisition tests, CLI management tests,
TypeScript and full renderer exports passed. The full native development App
used real device/network membership against a disposable server. It displayed
12 catalog entries alongside 30 actual public-registry results. Gmail search
mixed the branded integration and registry MCPs in the same grid. Dummy Replio
save, Manage, disable and disconnect passed; fixture credentials were removed.

ICS native development acceptance used a new local account, workspace and
server, not the user's installation. The encrypted Replio fixture persisted
a renderer reload. Both Go products' focused frontend suites passed 53 checks.
These checks do not establish real OAuth access, signed installed releases,
Windows/Linux native acceptance or completion of privacy actions.

## Remaining implementation and activation gates

1. Complete the standalone privacy-content processor: provenance of connected
   data, product-local export/redaction of derived history/Vault/files as
   applicable, durable processing/retry and completion receipts. Shopify remains
   blocked there until this is implemented and qualified.
2. Qualify production app-secret storage, recoverable metadata/key backups,
   restore procedures and the broker's capacity/request budget. Bootstrap health
   is not the admission or availability gate for a loaded production service.
3. Finish provider review/verification and test Google, ClickUp, Shopify and
   Postiz using their real callback/consent flows. Complete real cancel, read,
   authorized write, renewal, restart and local disconnection in all products.
4. Activate the central Shopify webhook path only after the legacy compatibility
   delivery and each product's local privacy processing are tested, including
   duplicate notifications and offline recipients.
5. Test two real servers on one Shopify shop: simultaneous acquisition/refresh,
   offline peer, expired/lost envelope, recovery and fresh consent. Coordinate
   any remaining legacy app-token issuers during the transition.
6. Build, sign and qualify supported product releases, preserve existing IDs,
   credentials and update paths, then opt receiving products into the qualified
   common app registrations. Migrate old connections through explicit consent.

Google's [restricted-scope rules](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
still apply when data is stored or transmitted by product servers; avoiding a
central content archive does not by itself remove verification/assessment
requirements. Shopify's [privacy requirements](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
require product actions in addition to receiving notifications.

## Architectural limits beyond the first rollout

The broker is intentionally a single writer. Multi-replica operation requires
transactional persistence and distributed rotation coordination. UI code remains
host-owned; provider marks are verified local assets packaged by clients.
Third-party protocol access does not automatically approve a product. Those
limits must remain explicit when embedding or extending the shared components.

The [operator guide](./connector-operations.md) describes configuration and
failure recovery. Update this checkpoint when a gate gains concrete evidence;
do not replace an untested boundary with a claim inferred from another layer.
