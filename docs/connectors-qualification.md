# Standalone official marketplace qualification

Development acceptance on 12 October 2026; public/native releases and real provider acceptance remain pending.

The full standalone server used the acquired, checksum-verified 0.1.1 runner. A disposable network membership authenticated the real desktop app through Iroh, and the CLI through its normal gateway. The app displayed all 12 catalog entries from the authenticated API, including unavailable OAuth entries and the two unimplemented placeholders. No mocked management responses or loopback identity bypass were used for this run.

Direct reload at `/mcps` now waits for the connection store to restore the authenticated server target. Target changes clear credential forms and pending authorization; old asynchronous responses cannot update another target. OAuth cancellation invalidates pending polling, and token setup requires an actual connected response before showing success.

A deliberately invalid Replio fixture was rejected. A well-formed dummy token was then saved on the disposable server, its enable switch persisted across a native renderer reload, and local disconnect removed its credential and nonce. The dummy token was absent in plaintext from the SQLite database. No external Replio API call was made, so this is local management acceptance, not provider authentication or tool-operation acceptance.

Validation: TypeScript check and full Expo web export passed. The native Electron app loaded the exported build and repeated the reload, connect, disable and disconnect flow. This is a development app; it does not qualify a signed installed release, Windows or Linux.

Shopify enrollment remains blocked until product-local privacy export/redaction of derived content is implemented. Central common OAuth remains disabled pending provider configuration, capacity qualification and real end-to-end checks. The approved production secret-storage hardening is verified in the public status checkpoint.

## Unified marketplace presentation

The marketplace now combines provider integrations and public-registry MCPs
in one alphabetically sorted grid using the same `MarketplaceTile` and
responsive `MarketplaceGrid`. There is no Official tab, heading, badge or
separator. The original eleven provider logo assets were copied from
GlassPalace with their source metadata and verified SHA-256 hashes; protocol
connectors retain the mail icon. Connection controls open from the card's
Manage action, and search/pagination remain bound to the authenticated target.
The earlier default-Official-tab screenshot is superseded by this presentation.

The unified native app loaded 12 catalog entries and 30 real registry results
in the same grid. A Gmail search mixed the branded Gmail connector with real
registry Gmail MCPs and retained no official label or divider. The Replio card
opened its credential form, saved a dummy credential, changed to Manage and
exposed enable/disconnect controls. Local disable and disconnect passed and
the database confirmed every fixture credential was removed. TypeScript and
the final full Expo web export passed after these changes. Real OAuth and
signed/public product release acceptance remain pending.

## Credential-key recovery

The host refuses to generate a new credential key when encrypted connection
credentials or privacy notifications already exist in the database. A partial
restore must recover the matching key; the failure leaves encrypted records
unchanged. Nineteen focused storage/authorization tests passed with the verified
0.1.1 adapter, including missing-key credential/event cases and restart after
restoring the original key. This does not complete Shopify content processing.

The branch now includes canonical main through the beta 37 product changes and
the published documentation updates. A separate clean environment consumed
checksum-verified published Core/SQLite `1.1.0b20`, connector `0.1.1` and Tools
protocol wheels. All 25 connector storage/authorization and acquisition checks
passed against those artifacts, without a Core source overlay. The earlier
native development acceptance is not relabeled as a new signed product release.

## Durable privacy receipt metadata

The host now encrypts the complete broker receipt, including immutable group,
topic, creation and occurrence timestamps. Payload-only storage lost the
generation fence needed to process a delayed notification after restart.
Delivery ACK follows the local database commit; a lost ACK or concurrent
redelivery preserves the original receipt and pending/processing status.
Conflicting duplicate IDs are rejected before ACK or credential revocation.
An old uninstall revokes the prior credential but preserves a newer consent.

The additive schema migration labels historical payload-only rows as format 1
without inventing missing metadata. Only a matching authenticated redelivery
can enrich those rows to the complete format 2. Receipt remains distinct from
privacy processing completion, and Shopify enrollment is still blocked.
All 35 focused authorization, acquisition and privacy-receipt checks passed
against the published Core/SQLite beta 20 and connector adapter 0.1.1.
