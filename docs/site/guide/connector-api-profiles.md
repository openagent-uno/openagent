# Shared provider API profiles

::: info Shared SDK availability
[SDK 0.1.8](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.8)
ships 114 official connectors. The receiving server must adopt that version;
App, server and OAuth activation are qualified separately. Use
[release status](./connector-status.md) for the installed and tested cohort.
:::

OpenAgent implements provider integrations once in the shared connector SDK.
Each admitted profile contains concrete operations, authentication, closed input
schemas and response handling. A provider name or directory listing alone never
makes a connector available.

## Connect an account

1. Choose the receiving server and user, then open **Connectors → Browse**.
   Provider cards and registry MCPs use the same grid and search.
2. Select a provider. Read its supported operations and API setup instructions.
   API entitlement and provider plan requirements still apply.
3. For a token profile, obtain an authorized API token from the provider's
   documented account settings. Enter the raw token in the server's secure
   setup field, without its HTTP header or prefix. If the profile explicitly
   requires an encoded Basic credential, follow its displayed instructions.
   Never enter a provider password in an API-token field or put a secret in chat.
4. Connect and perform a permitted read to verify the credential. Saving a
   connection alone does not prove provider access.
5. Connect another account separately when needed. Disable or disconnect each
   local connection through its own controls.

A personal API token or manually supplied OAuth access token is distinct from
the common OAuth app. These profiles do not register an app, request a consent
grant or automatically renew an access token. Replace an expired credential
through a new authorized connection. Providers with an enabled common app use
the browser OAuth flow instead; own-app configuration remains available for
supported OAuth implementations.

Each product stores its credentials locally, encrypted at rest, and makes the
normal API requests. The model receives tool schemas and permitted results;
it cannot choose credential headers or read stored secrets. The compiled SDK
selects the exact header, scheme, endpoint and any fixed API-version headers.

## Supported operations and composition

The first API-profile batch supplies a small, explicit read-only subset for
each service. Its tool list is the contract: it does not imply every feature of
the provider or parity with its ChatGPT app. Local **Allow changes** is absent
for a read-only profile. Later mutations need a typed operation, scope review,
host authorization, appropriate retry policy and dedicated tests.

Each connection is an independent source in Core's public capability APIs.
Applications can compose several accounts, providers and filesystems through
these sources. The host owns durable application state, projections, sync
checkpoints, views, actions and conflict handling. Adding a connector does not
implicitly add a calendar, task manager or editor application. See
[composable applications](./application-composition.md).

Pagination is explicit per operation. Some initial operations intentionally
return one bounded page; their descriptions state that limit. Supported cursor
operations expose an opaque page token bound to the connection, account,
operation, filters and credential generation. A rotated credential requires a
fresh listing. Neither provider next-page URLs nor arbitrary downloads are
followed automatically.

## OneDrive and SharePoint selection

The Microsoft file adapters use delegated OAuth rather than the
manual-token setup above. Their common-app enrollment remains closed until
registration and actual consent are qualified; a catalog card does not enable
it automatically. Each account gets a separate local connection.

For OneDrive, use **Choose drive** to list existing drives and select one.
For SharePoint, search for a site, choose it, then select one of its document
libraries. Selecting a different site clears the previous library. The server
checks the selection against a fresh authorized Microsoft listing; a model
cannot change the site or drive through tool arguments. A new selection starts
pagination again because previous page tokens belong to the old binding.

The CLI exposes the same owner controls:

```sh
openagent connectors microsoft-resources CONNECTION_ID --kind drives
openagent connectors select-microsoft-drive CONNECTION_ID DRIVE_ID
openagent connectors microsoft-resources CONNECTION_ID --kind sites --query Research
openagent connectors select-microsoft-site CONNECTION_ID SITE_ID --query Research
```

For subsequent listing pages, pass the returned opaque `--page-token` and the
same query. Selecting a resource from that page also requires its page token.
After selecting a SharePoint site, list its drives and select a library.

OneDrive requests delegated `User.Read` and `Files.Read`; SharePoint requests
`User.Read` and `Sites.Read.All`, with offline access for renewal. SharePoint
requires a work or school account and can require tenant approval. Selected-only
permissions and application credentials are outside this initial subset.
The tools read metadata and complete files up to 2MiB; they do not mutate files,
provision drives or expose temporary download links.

## Implementation boundary

The reviewed profiles are immutable SDK inputs under
`packages/connectors/definitions`. They use the existing fixed-origin HTTP
engine behind argument, response and pagination validation. They are not
user-supplied HTTP templates or a runtime plugin loader. An unsupported schema
or contract fails admission and cannot become an available card.

Go hosts embed the versioned module. Python hosts invoke the local runner and
can expose the same operations through MCP when required. Accounts, permissions,
audit and credential storage stay with the receiving host. Core uses its public
capability interfaces; it does not import provider-specific transport code.

Available shared brand marks are bundled vectors from recorded sources. The
marketplace renders only the SDK's finite vector format and performs no remote
logo fetch. Existing bundled marks remain supported; a missing verified mark
uses the ordinary card fallback rather than another brand's logo.

Synthetic protocol and lifecycle fixtures verify implementation boundaries.
Actual provider consent, reads, renewals and disconnection are reported
separately. Package publication, a registered OAuth app and a successful
fixture are independent facts.

## Provider inventory (SDK 0.1.8)

The 90 manual-token profiles below are compiled implementations with two read operations each. They ship in SDK 0.1.8; this list does not declare a successful live credential test or provider-app registration. Follow the linked provider documentation and the instructions shown by the card. Availability can require a provider plan, approval or an authorized OAuth access token obtained through your own app.

| Provider setup | Catalog ID | Supported read tools |
| --- | --- | --- |
| [AgentMail](https://docs.agentmail.to/api-reference/inboxes/list) | `agentmail` | `files.agentmail.inboxes.list`<br>`files.agentmail.inboxes.get` |
| [Ahrefs](https://docs.ahrefs.com/en/api/docs/introduction) | `ahrefs` | `files.ahrefs.domain_rating.get`<br>`files.ahrefs.metrics.get` |
| [Airtable](https://airtable.com/developers/web/guides/personal-access-tokens) | `airtable` | `files.airtable.bases.list`<br>`files.airtable.tables.list` |
| [Apollo.io](https://docs.apollo.io/reference/authentication) | `apollo` | `files.apollo.organizations.search`<br>`files.apollo.people.search` |
| [Asana](https://developers.asana.com/docs/oauth-scopes) | `asana` | `files.asana.projects.list`<br>`files.asana.tasks.list` |
| [Ashby](https://developers.ashbyhq.com/docs/authentication) | `ashby` | `files.ashby.jobs.list`<br>`files.ashby.candidates.list` |
| [Attio](https://docs.attio.com/rest-api/endpoint-reference/objects/list-objects) | `attio` | `files.attio.objects.list`<br>`files.attio.lists.list` |
| [beehiiv](https://developers.beehiiv.com/api-reference/publications/index) | `beehiiv` | `files.beehiiv.publications.list`<br>`files.beehiiv.publications.get` |
| [Better Stack](https://betterstack.com/docs/uptime/api/get-all-monitors-of-a-monitor-group/) | `better-stack` | `files.better_stack.monitor_groups.get`<br>`files.better_stack.monitor_groups.monitors.list` |
| [Box](https://developer.box.com/guides/security/) | `box` | `files.box.folders.items.list`<br>`files.box.files.get` |
| [Brevo](https://developers.brevo.com/docs/api-key-authentication) | `brevo` | `outreach.brevo.contacts.list`<br>`outreach.brevo.account.get` |
| [Brex](https://developer.brex.com/guides/roles_permissions_scopes) | `brex` | `files.brex.users.list`<br>`files.brex.departments.list` |
| [Cal.com](https://cal.com/docs/api-reference/v2/authentication) | `cal-com` | `files.cal_com.profile.get`<br>`files.cal_com.bookings.get` |
| [Calendly](https://developer.calendly.com/docs/authentication/how-to-authenticate-with-personal-access-tokens) | `calendly` | `files.calendly.users.me`<br>`files.calendly.event_types.list` |
| [Canva](https://www.canva.dev/docs/connect/authentication/) | `canva` | `files.canva.designs.list`<br>`files.canva.designs.get` |
| [Capsule CRM](https://developer.capsulecrm.com/v2/overview/authentication) | `capsule` | `files.capsule.parties.list`<br>`files.capsule.opportunities.list` |
| [Close](https://developer.close.com/topics/authentication) | `close` | `files.close.leads.list`<br>`files.close.contacts.list` |
| [Cloudflare](https://developers.cloudflare.com/api/resources/zones/methods/list/) | `cloudflare` | `files.cloudflare.zones.list`<br>`files.cloudflare.accounts.list` |
| [Coda](https://coda.io/developers/apis/v1) | `coda` | `files.coda.identity.get`<br>`files.coda.docs.get` |
| [CoinMarketCap](https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency) | `coinmarketcap` | `files.coinmarketcap.cryptocurrencies.map`<br>`files.coinmarketcap.global_metrics.get` |
| [Contentful](https://www.contentful.com/developers/docs/references/authentication/) | `contentful` | `files.contentful.content_types.list`<br>`files.contentful.assets.list` |
| [CourtListener](https://www.courtlistener.com/help/api/rest/) | `courtlistener` | `files.courtlistener.opinions.search`<br>`files.courtlistener.oral_arguments.search` |
| [Customer.io](https://docs.customer.io/integrations/api/app/) | `customer-io` | `files.customer_io.campaigns.list`<br>`files.customer_io.campaigns.get` |
| [DigitalOcean](https://docs.digitalocean.com/reference/api/scopes/droplet/read/) | `digitalocean` | `files.digitalocean.droplets.list`<br>`files.digitalocean.projects.list` |
| [Dovetail](https://developers.dovetail.com/docs/authorization) | `dovetail` | `files.dovetail.projects.list`<br>`files.dovetail.projects.get` |
| [Dropbox](https://developers.dropbox.com/oauth-guide) | `dropbox` | `files.dropbox.folders.list`<br>`files.dropbox.metadata.get` |
| [ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication) | `elevenlabs` | `files.elevenlabs.voices.list`<br>`files.elevenlabs.models.list` |
| [Fathom](https://developers.fathom.ai/quickstart) | `fathom` | `files.fathom.meetings.list`<br>`files.fathom.recordings.transcript` |
| [Figma](https://developers.figma.com/docs/rest-api/authentication/) | `figma` | `files.figma.user.get`<br>`files.figma.files.get` |
| [Financial Datasets](https://www.financialdatasets.ai/openapi.json) | `financial-datasets` | `files.financial_datasets.income_statements.list`<br>`files.financial_datasets.prices.snapshot` |
| [Fireflies](https://docs.fireflies.ai/fundamentals/authorization) | `fireflies` | `files.fireflies.transcripts.list`<br>`files.fireflies.transcripts.get` |
| [Front](https://dev.frontapp.com/reference/api-token-details) | `front` | `files.front.company.get`<br>`files.front.inboxes.list` |
| [GitBook](https://gitbook.com/docs/developers/gitbook-api/authentication) | `gitbook` | `files.gitbook.organizations.list`<br>`files.gitbook.organizations.get` |
| [GitLab (Beta)](https://docs.gitlab.com/api/rest/authentication/) | `gitlab` | `files.gitlab.projects.list`<br>`files.gitlab.issues.list` |
| [Grain](https://developers.grain.com/authentication.html) | `grain` | `files.grain.recordings.list`<br>`files.grain.recordings.get` |
| [Gusto](https://docs.gusto.com/app-integrations/docs/getting-setup) | `gusto` | `files.gusto.token.info`<br>`files.gusto.companies.get` |
| [HeyGen](https://developers.heygen.com/docs/api-key) | `heygen` | `files.heygen.avatars.list`<br>`files.heygen.voices.list` |
| [Honeycomb](https://docs.honeycomb.io/api/dataset-definitions/authorization) | `honeycomb` | `files.honeycomb.datasets.list`<br>`files.honeycomb.datasets.get` |
| [HubSpot](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/intro-to-auth) | `hubspot` | `files.hubspot.contacts.list`<br>`files.hubspot.companies.list` |
| [Hugging Face](https://huggingface.co/docs/hub/en/api) | `hugging-face` | `files.hugging_face.models.list`<br>`files.hugging_face.datasets.list` |
| [Hunter](https://hunter.io/api-documentation.md) | `hunter` | `files.hunter.account.get`<br>`files.hunter.domains.search` |
| [incident.io](https://docs.incident.io/api-reference/introduction) | `incident-io` | `files.incident_io.incidents.list`<br>`files.incident_io.roles.list` |
| [Instantly.ai](https://developer.instantly.ai/api/v2) | `instantly` | `outreach.instantly.campaigns.list`<br>`outreach.instantly.campaigns.get` |
| [Klaviyo](https://developers.klaviyo.com/en/docs/authenticate_) | `klaviyo` | `outreach.klaviyo.profiles.list`<br>`outreach.klaviyo.campaigns.list` |
| [LaunchDarkly](https://launchdarkly.com/docs/api#authentication) | `launchdarkly` | `files.launchdarkly.projects.list`<br>`files.launchdarkly.flags.list` |
| [lemlist](https://developer.lemlist.com/api-reference/getting-started/authentication) | `lemlist` | `outreach.lemlist.campaigns.list`<br>`outreach.lemlist.campaigns.get` |
| [Linear](https://linear.app/developers/graphql) | `linear` | `files.linear.issues.list`<br>`files.linear.projects.list` |
| [Lucid](https://developer.lucid.co/reference/overview) | `lucid` | `files.lucid.documents.get`<br>`files.lucid.threads.list` |
| [MailerLite](https://developers.mailerlite.com/getting-started) | `mailerlite` | `files.mailerlite.groups.list`<br>`files.mailerlite.segments.list` |
| [Massive](https://massive.com/docs/rest/quickstart) | `massive` | `files.massive.tickers.list`<br>`files.massive.market_status.get` |
| [Miro](https://developers.miro.com/reference/scopes) | `miro` | `files.miro.boards.list`<br>`files.miro.boards.search` |
| [monday.com](https://developer.monday.com/api-reference/docs/authentication) | `monday` | `files.monday.boards.list`<br>`files.monday.items.list` |
| [Neon](https://neon.com/docs/manage/api-keys) | `neon` | `files.neon.projects.list`<br>`files.neon.projects.get` |
| [Netlify](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/) | `netlify` | `files.netlify.sites.list`<br>`files.netlify.sites.get` |
| [Nifty](https://developers.niftypm.com/docs/authentication) | `nifty` | `files.nifty.projects.list`<br>`files.nifty.projects.get` |
| [Omnisend](https://api-docs.omnisend.com/reference/getting-started) | `omnisend` | `files.omnisend.campaigns.list`<br>`files.omnisend.campaigns.get` |
| [OneSignal](https://documentation.onesignal.com/reference/authentication) | `onesignal` | `files.onesignal.apps.list`<br>`files.onesignal.apps.get` |
| [PandaDoc](https://developers.pandadoc.com/reference/authentication-process) | `pandadoc` | `files.pandadoc.documents.list`<br>`files.pandadoc.documents.details` |
| [Pendo](https://engageapi.pendo.io/#getting-started) | `pendo` | `files.pendo.features.list`<br>`files.pendo.pages.list` |
| [PostHog](https://posthog.com/docs/api) | `posthog` | `files.posthog.projects.list`<br>`files.posthog.projects.get` |
| [Postman](https://learning.postman.com/docs/developer/postman-api/authentication/) | `postman` | `files.postman.collections.list`<br>`files.postman.collections.get` |
| [Quo](https://www.quo.com/docs/api-reference/introduction/authentication) | `quo` | `files.quo.phone_numbers.list`<br>`files.quo.conversations.list` |
| [Railway](https://docs.railway.com/integrations/api) | `railway` | `files.railway.account.get`<br>`files.railway.projects.get` |
| [Ramp](https://docs.ramp.com/developer-api/v1/api/users) | `ramp` | `files.ramp.users.list`<br>`files.ramp.users.get` |
| [Read AI](https://support.read.ai/hc/en-us/articles/49381161088659-API-Reference) | `read-ai` | `files.read_ai.meetings.list`<br>`files.read_ai.meetings.get` |
| [Readwise](https://readwise.io/api_deets) | `readwise` | `files.readwise.books.list`<br>`files.readwise.highlights.list` |
| [Render](https://render.com/docs/api) | `render` | `files.render.services.list`<br>`files.render.deploys.list` |
| [Resend](https://resend.com/docs/api-reference/introduction) | `resend` | `outreach.resend.domains.list`<br>`outreach.resend.domains.get` |
| [RevenueCat](https://www.revenuecat.com/docs/api-v2) | `revenuecat` | `files.revenuecat.projects.list`<br>`files.revenuecat.apps.list` |
| [Rootly](https://docs.rootly.com/api-reference/overview) | `rootly` | `files.rootly.incidents.list`<br>`files.rootly.services.list` |
| [SignNow](https://github.com/signnow/SignNowNodeSDK) | `signnow` | `files.signnow.documents.list`<br>`files.signnow.documents.get` |
| [Smartsheet US](https://developers.smartsheet.com/api/smartsheet/guides/basics/authentication) | `smartsheet` | `files.smartsheet.sheets.list`<br>`files.smartsheet.sheets.get` |
| [Spotify](https://developer.spotify.com/documentation/web-api/concepts/authorization) | `spotify` | `files.spotify.playlists.list`<br>`files.spotify.saved_tracks.list` |
| [Statsig](https://docs.statsig.com/console-api/introduction) | `statsig` | `files.statsig.gates.list`<br>`files.statsig.experiments.list` |
| [Stripe](https://docs.stripe.com/keys) | `stripe` | `commerce.stripe.customers.list`<br>`commerce.stripe.invoices.list` |
| [Supabase](https://supabase.com/docs/guides/platform/personal-access-tokens) | `supabase` | `files.supabase.projects.list`<br>`files.supabase.projects.get` |
| [SurveyMonkey](https://api.surveymonkey.com/v3/docs#authentication) | `surveymonkey` | `files.surveymonkey.surveys.list`<br>`files.surveymonkey.surveys.details` |
| [Tally](https://developers.tally.so/api-reference/introduction) | `tally` | `files.tally.forms.list`<br>`files.tally.submissions.list` |
| [Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search) | `tavily` | `files.tavily.search`<br>`files.tavily.usage.get` |
| [TickTick:To-Do List & Calendar](https://developer.ticktick.com/docs/openapi.md) | `ticktick` | `files.ticktick.projects.list`<br>`files.ticktick.projects.get` |
| [Todoist: To Do List & Calendar](https://developer.todoist.com/api/v1/) | `todoist` | `files.todoist.projects.list`<br>`files.todoist.tasks.list` |
| [Typeform](https://www.typeform.com/developers/get-started/scopes/) | `typeform` | `files.typeform.forms.list`<br>`files.typeform.responses.list` |
| [Vercel](https://vercel.com/docs/rest-api/reference/welcome) | `vercel` | `files.vercel.projects.list`<br>`files.vercel.deployments.list` |
| [Webex](https://developer.webex.com/docs/api/v1/people/get-my-own-details) | `webex` | `files.webex.people.self`<br>`files.webex.rooms.list` |
| [Webflow](https://developers.webflow.com/data/reference/authentication) | `webflow` | `files.webflow.sites.list`<br>`files.webflow.collections.list` |
| [Wistia](https://docs.wistia.com/docs/making-api-requests) | `wistia` | `files.wistia.media.list`<br>`files.wistia.folders.list` |
| [WorkOS](https://workos.com/docs/reference) | `workos` | `files.workos.organizations.list`<br>`files.workos.directories.list` |
| [Wrike](https://developers.wrike.com/docs/oauth-2-0) | `wrike` | `files.wrike.contacts.self`<br>`files.wrike.tasks.list` |
| [YNAB: Get Good At Money](https://api.ynab.com/) | `ynab` | `files.ynab.user.get`<br>`files.ynab.plans.list` |
| [Zoom](https://developers.zoom.us/docs/integrations/oauth-scopes-granular/) | `zoom` | `files.zoom.meetings.list`<br>`files.zoom.meetings.get` |
