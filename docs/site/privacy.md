# OpenAgent privacy

Updated: 19 October 2026.

OpenAgent is a modular AI agent runtime and a standalone client/server product. Its official connectors let an authorized agent work with services such as Gmail, Google Drive, Google Analytics, Shopify and ClickUp. The same connector library can be embedded in independent host products.

**Service contact:** AI Agent, the commercial name used for the OpenAgent connector service. For support, privacy questions or requests concerning that service, email [geroale2000@gmail.com](mailto:geroale2000@gmail.com).

## What this notice covers

This notice describes the OpenAgent website, standalone product and shared authentication service at `auth.openagent.uno`. Each receiving product's operator controls its own server, user accounts, connection permissions and stored content. For any independently operated host installation, also consult that operator's privacy notice. A product appearing in the authorization disclosure is the intended recipient; its name does not mean OpenAgent endorses it.

Common OAuth enrollment is available as a limited beta for the profiles and operations recorded in the [qualification status](/guide/connector-status). Google's external app is published with verified Branding, but its data access remains unverified and subject to the observed 100-user cap; Google remains an explicit host opt-in. Its unlisted demonstration video is uploaded and Google has confirmed data access is in review. Approval and the security assessment required before approval are not complete. Publication, branding and bounded account trials do not qualify every receiving product, operation or data-processing configuration. Existing connections using a product's own app continue under that registration.

## Information accessed and why

The connector you select requests permission to perform its listed functions. Depending on your authorized scopes and local tool permissions, Gmail can access messages, threads, attachments and drafts or send messages; Drive can access file metadata and content or perform permitted file operations; Analytics reads reports and account/property metadata. Shopify and other connectors access the resources described in the [connector catalog](/guide/connectors). Token-based connectors use credentials supplied to the receiving server.

This information is used to carry out the agent tasks and automations you authorize. The receiving server performs normal API calls directly to the provider. Connecting a service does not itself authorize every agent or every write operation; the product's local access controls still apply.

## Where information is processed

The shared authentication service handles your consent transaction, authorization-code exchange and renewals that require the app secret. It processes access and refresh tokens during those operations without maintaining a permanent token archive. Provider tokens and authorization codes must not be included in application logs. Normal email, document, store and task API content does not pass through that service.

The receiving product stores credentials locally and processes API results on its server. In the standalone product, credentials are encrypted at rest and associated with the local owner, tenant and receiving installation. Agent sessions, memory, files, audit records and tool results may be retained according to the product's enabled features and storage configuration.

When an agent uses connected content in a model request or an authorized tool action, that content can be sent to the model provider or destination configured for that task. A self-hosted server does not automatically make an external model local. Review your model configuration, enabled memory features, authorized tools and the receiving product's privacy information before providing sensitive content.

## Shared authentication metadata

The central service retains installation public identities, consent and authorization metadata, and authorized Shopify recipient associations. For Shopify it also retains credential versions and fingerprints used to coordinate rotation, plus a durable queue of minimized, encrypted privacy and uninstall notifications. Fingerprints are used to identify a credential generation, not to recover the token.

Encrypted credential-delivery messages are addressed to a particular authorized installation and expire within ten minutes. Tokens remain with receiving servers; a server that misses a delivery can request a current copy from an authorized peer or require new consent if no current copy is recoverable. Privacy notifications are acknowledged and deduplicated so an offline recipient can process them later.

Installation, authorization and delivery records are retained for operation, recovery, revocation and handling privacy requests. This release does not provide a universal fixed deletion period for that metadata or for independently operated product databases. Contact the service or the receiving product's operator to request removal of records they control. Disconnecting a connector is not a deletion request for existing agent history, files, backups or provider data.

## Google user data

The intended use of Google data is limited to the user-facing connector tasks you authorize. OpenAgent's common Google app is not offered for advertising, sale of Google user data, credit decisions or training a generalized AI model. Embedding products and configured model providers must meet the applicable Google data-use restrictions before common-app access can be activated.

The [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including its Limited Use requirements where applicable, governs this integration. Publishing this notice does not establish verification or security-assessment completion. Google restricted-scope approval, recipient data-handling checks and the applicable security assessment remain release gates for the common app.

## Revocation, deletion and privacy requests

Use **Disconnect from this server** to remove a product's local connection. Revoking or removing the app in the provider's settings can affect all products connected through that app. Neither action automatically deletes previously stored agent content or content you created at the provider.

For access, correction, export or deletion of data held by your receiving product, contact its operator. For OpenAgent's shared service, contact [geroale2000@gmail.com](mailto:geroale2000@gmail.com), identifying the provider and receiving installation where possible; do not send tokens, passwords or other secrets. Requests may require verification of your authority over the relevant installation or account. Self-hosted administrators also control their local storage and backup retention.

Shopify privacy notifications are delivered to the authorized receiving products, which carry out actions on their own data. Server beta48 implements explicit opt-in and qualified export/redaction processing for a fresh canonical text-history cohort; configuration alone cannot attest that coverage. Historical content, media, Vault/files and other unqualified surfaces remain blocked. General Shopify enrollment remains disabled. The scoped broker QA gate admits only two approved receiving installations; actual two-host OAuth, provider and privacy-notification acceptance remains pending. See the [qualification status](/guide/connector-status) for the current boundary.

## Website and changes

The public website is hosted through GitHub Pages; the authentication service uses separate operator-managed infrastructure. Their hosting providers may process request metadata such as IP addresses and browser information to deliver and protect the services. This notice does not assert that infrastructure request logs have a particular retention period.

We update this page when the published data handling changes. Check the date above and the receiving product's own notice when reconnecting or enabling new capabilities.
