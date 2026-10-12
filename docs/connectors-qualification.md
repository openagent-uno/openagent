# Standalone official marketplace qualification

Development acceptance on 12 October 2026; public/native releases and real provider acceptance remain pending.

The full standalone server used the acquired, checksum-verified 0.1.1 runner. A disposable network membership authenticated the real desktop app through Iroh, and the CLI through its normal gateway. The app displayed all 12 catalog entries from the authenticated API, including unavailable OAuth entries and the two unimplemented placeholders. No mocked management responses or loopback identity bypass were used for this run.

Direct reload at `/mcps` now waits for the connection store to restore the authenticated server target. Target changes clear credential forms and pending authorization; old asynchronous responses cannot update another target. OAuth cancellation invalidates pending polling, and token setup requires an actual connected response before showing success.

A deliberately invalid Replio fixture was rejected. A well-formed dummy token was then saved on the disposable server, its enable switch persisted across a native renderer reload, and local disconnect removed its credential and nonce. The dummy token was absent in plaintext from the SQLite database. No external Replio API call was made, so this is local management acceptance, not provider authentication or tool-operation acceptance.

Validation: TypeScript check and full Expo web export passed. The native Electron app loaded the exported build and repeated the reload, connect, disable and disconnect flow. This is a development app; it does not qualify a signed installed release, Windows or Linux.

Shopify enrollment remains blocked until product-local privacy export/redaction of derived content is implemented. Central common OAuth remains disabled pending provider configuration, production secret-storage hardening and real end-to-end checks.
