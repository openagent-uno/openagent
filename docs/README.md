# Product documentation

- [Architecture and migration status](architecture-v1.md)
- [Standalone modular profile](modules-v1.1.md)
- [App capability registration](app-capabilities-v1.md)
- [Shared tools, connectors and MCP architecture](site/guide/shared-components.md)
- [Using connectors in the App and CLI](site/guide/connectors.md)
- [Connector setup, embedding and recovery](site/guide/connector-operations.md)
- [Connector delivery status and remaining qualification](site/guide/connector-status.md)
- [Native capability coverage](native-capability-coverage.md)
- [Image model configuration and delivery](image-generation.md)
- [Voice input and transcribed attachments](voice-input.md)
- [Attachment preview in the App](attachment-preview.md)
- [Beta 38 shared connector Python product release](releases/v1.1.0-beta.38.md)
- [Beta 34 grounded memory authorization and durable recovery](releases/v1.1.0-beta.34.md)
- [Beta 35 session and scheduler reliability](releases/v1.1.0-beta.35.md)
- [Beta 33 authorized automation composition and resilient domain search](releases/v1.1.0-beta.33.md)
- [Beta 32 long-running automation deadline repair](releases/v1.1.0-beta.32.md)
- [Beta 31 catalog-aware fallback and resilient scheduled-task delivery](releases/v1.1.0-beta.31.md)
- [Beta 30 resilient scheduled-task delivery](releases/v1.1.0-beta.30.md)
- [Beta 29 default Vault path repair](releases/v1.1.0-beta.29.md)
- [Beta 28 terminal automation-run repair](releases/v1.1.0-beta.28.md)
- [Beta 27 unified workflow capability dispatch](releases/v1.1.0-beta.27.md)
- [Beta 26 independent web-search compatibility](releases/v1.1.0-beta.26.md)
- [Beta 25 one-shot child authorization repair](releases/v1.1.0-beta.25.md)
- [Beta 24 scheduler responsiveness and bootstrap ownership repair](releases/v1.1.0-beta.24.md)
- [Beta 23 standalone automation authorization repair](releases/v1.1.0-beta.23.md)
- [Beta 16 Telegram voice repair and live acceptance](releases/v1.1.0-beta.16.md)
- [Beta 17 Telegram vault access](releases/v1.1.0-beta.17.md)
- [Beta 18 Telegram image input and proxy capability repair](releases/v1.1.0-beta.18.md)
- [Beta 19 subscription proxy capability discovery](releases/v1.1.0-beta.19.md)
- [Beta 21 compatible server and CLI release](releases/v1.1.0-beta.21.md)
- [Beta 22 visual tool result repair](releases/v1.1.0-beta.22.md)
- [Beta 20 server computer and browser capability](releases/v1.1.0-beta.20.md)
- [Beta 13 subscription image integration receipt](releases/v1.1.0-beta.13.md)
- [Beta 12 App, server and CLI release receipt](releases/v1.1.0-beta.12.md)
- [Beta 11 image model release receipt](releases/v1.1.0-beta.11.md)
- [Beta 10 product and native capability release receipt](releases/v1.1.0-beta.10.md)
- [Beta 9 Python artifact qualification](releases/v1.1.0-beta.9.md)
- [Runtime, automation, and verification gates](runtime-and-verification.md)
- [Server browser dependencies for custom MCPs](server-browser-mcps.md)
- [Build and release contracts](build-and-release.md)
- [Repository and updater transition](repository-transition.md)
- [Frozen server qualification](frozen-server-qualification.md)
- [Official marketplace qualification](connectors-qualification.md)
- [OpenAgent vision](site/vision.md)
- [Product guide and documentation site](site/index.md)
- [Source history manifest](../packaging/source-history.json)

This repository owns standalone authentication and identity, installation,
configuration, app dashboards, client capability assembly and channels. It
does not own the reusable agent engine or autonomous computer tools.

The canonical website source and GitHub Pages workflow live under `docs/site`
and `.github/workflows/docs-pages.yml`. The historical `openagent-docs`
repository retains its deployment history and a source mirror, but no longer
owns the public domain.

The candidate privacy job bridge in `openagent_server.connector_privacy` maps
immutable authenticated connector receipts into upstream Core privacy requests.
Occurrence timestamps fence original consent generations; customer/order IDs are
provider-validated numeric selectors. Durable receipt ACK and local processing
status remain separate. Processing retries across restarts and broker outages;
historical payload-only receipts remain blocked pending authenticated redelivery.
The candidate normal startup installs the tracker through strict opt-in before
runtime recovery and source registration. No runtime currently injects a fully
covered processor, and the published Core
pins do not yet contain these candidate APIs. Shopify enrollment remains closed
until canonical content writer coverage, sink completion, protected export
delivery and consumer qualification are complete. Tests using Core source candidates
are source qualification, never installed-wheel or product-release acceptance.

The host-tools NDJSON producer writes explicit UTF-8 bytes independently of
Windows locale and frozen-interpreter environment handling. The three encoding
regressions live in `packages/host-tools/tests/test_stdio_encoding.py`; the
compatibility 0.1.3 build for existing consumers retains its independent release
and does not change this product's host-tools version or dependency closure.
