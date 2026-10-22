# Product documentation

- [Beta55 public wheel and installer qualification](qualification/product-beta55-2026-10-22.json)
- [Channel bridges beta6 public artifact qualification](qualification/channel-bridges-0.1.0b6-2026-10-22.json)
- [Beta55 main-chat replies and explicit threads](releases/v1.1.0-beta.55.md)
- [Main-chat replies and explicit thread preservation](releases/channel-bridges-0.1.0-beta.6.md)
- [Architecture and migration status](architecture-v1.md)
- [Standalone modular profile](modules-v1.1.md)
- [App capability registration](app-capabilities-v1.md)
- [Shared tools, connectors and MCP architecture](site/guide/shared-components.md)
- [Embedding official conversational channels and explicitly mapped shared sessions](site/guide/embedded-channels.md)
- [Channel bridges beta 5 public artifact qualification](qualification/channel-bridges-0.1.0b5-2026-10-22.json)
- [Channel bridges beta 4 public artifact qualification](qualification/channel-bridges-0.1.0b4-2026-10-22.json)
- [Slack file delivery: HTTP acknowledgement source regression](qualification/channel-slack-upload-source-2026-10-22.json)
- [Composable applications and multi-source architecture](site/guide/application-composition.md)
- [Using connectors in the App and CLI](site/guide/connectors.md)
- [Shared catalog and central connector execution](site/guide/central-connectors.md)
- [Connector setup, embedding and recovery](site/guide/connector-operations.md)
- [Connector delivery status and remaining qualification](site/guide/connector-status.md)
- [Google production verification dossier and remaining evidence](verification/google-production-verification-2026-10-19.md)
- [Connector credential custody and data processing](site/privacy.md)
- [Native capability coverage](native-capability-coverage.md)
- [Image model configuration and delivery](image-generation.md)
- [Voice input and transcribed attachments](voice-input.md)
- [Attachment preview in the App](attachment-preview.md)
- [Beta 54 Slack file upload completion](releases/v1.1.0-beta.54.md)
- [Beta 53 shared channel sessions and normal runtime delivery](releases/v1.1.0-beta.53.md)
- [Beta 52 canonical attachment history and delivery](releases/v1.1.0-beta.52.md)
- [Beta 44 Calendar and mail connector SDK adoption](releases/v1.1.0-beta.44.md)
- [Beta 41 keyless connectors and common OAuth beta](releases/v1.1.0-beta.41.md)
- [Beta 40 connector SDK 0.1.4 consumer release](releases/v1.1.0-beta.40.md)
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

The privacy job bridge in `openagent_server.connector_privacy` maps
immutable authenticated connector receipts into upstream Core privacy requests.
Occurrence timestamps fence original consent generations; customer/order IDs are
provider-validated numeric selectors. Durable receipt ACK and local processing
status remain separate. Processing retries across restarts and broker outages;
historical payload-only receipts remain blocked pending authenticated redelivery.
Server/CLI beta 39 installs the tracker through strict opt-in before runtime
recovery and source registration, using published Core and SQLite beta 22 APIs.
Installed-wheel qualification covers only a fresh canonical text-history cohort;
coverage is computed from the host-owned assembly, not asserted by configuration.
Historical content, media, Vault/files and custom callbacks remain outside that
qualified coverage and fail closed. Shopify enrollment remains closed pending
real provider, webhook and two-server acceptance. See
[Connector release status](site/guide/connector-status.md) for the recorded gates.
Tests using Core source candidates establish source qualification, never
installed-wheel or product-release acceptance.

The host-tools NDJSON producer writes explicit UTF-8 bytes independently of
Windows locale and frozen-interpreter environment handling. The three encoding
regressions live in `packages/host-tools/tests/test_stdio_encoding.py`; the
compatibility 0.1.3 build for existing consumers retains its independent release
and does not change this product's host-tools version or dependency closure.
