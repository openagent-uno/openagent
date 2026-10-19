# Google production verification dossier

Prepared 19 October 2026. **Submission preparation, not a Google approval or a
compliance attestation.** No verification application, new grant, scope change,
assessment purchase or deployment is performed by this document.

## Recorded state and evidence

The operator observed **External / In produzione** after the explicitly approved
Publish App action on 19 October. The same console showed an unverified user
limit of **100**, with **1** counted user. The private console witness is retained
by the operator (SHA256
`59fd6956fb06a814374f85237df5f3fc029c40c305b2719a5d3d2f62c406f549`).
The subsequent Google Branding automatic check **failed**: Google reported
that the homepage was not registered to the submitting owner and requested
ownership verification followed by a 24-hour wait. This is an observed branding
blocker, not a submitted scope review. The operator then verified the **https://openagent.uno/ URL-prefix property**
in Search Console using Google's HTML file. The live vendor file is 53 bytes,
SHA256 `70eef78b47701c28885fa3e668197a860140b142c18e3516843bac554ca1031b`;
the success-witness SHA256 is `aea20195a69f5884488b52c22eaa83211564228462b17b57909feda692a0d6ae`.
This is HTML/URL-prefix ownership verification, **not** DNS TXT verification
or a verified Domain property: no TXT change was applied. The retried Branding check then **passed and was published**: the console
reported that verified branding is displayed to users, and enabled preparation
for data-access verification. Private success-witness SHA256:
`80b5976f73b64a7ab79b5cbb2ba0dd88c5f6be522987af96c60f8c7013cb02f3`.
The first failed check and 24-hour warning are history, not a current waiting
gate. Sensitive/restricted data-access verification is still unverified; no
submission or security-assessment completion is recorded. Private witness SHA256:
`91ab7a076030a3a639190eb0998c9c578f049bc327c5fbdcec425de6add27724`.
Publication, brand verification and data-access verification are different
states. Google describes published external apps with unverified sensitive or
restricted access as subject to warnings and a user cap. Verified branding does
not establish unrestricted data access or make this an Internal organization app.
[Google app-state reference](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).

The [four-Google-connector receipt](../qualification/google-four-product45-oauth-2026-10-19.json)
(SHA256 `9f4a34cb9fb0fa347e4b71d54cc1a0ab2834b6f1219e99a2a926b7e617a2aa84`)
records normal public server45/SDK18 consent/redemption, an initial read,
explicit owner refresh, a real same-identity process restart, post-restart read,
and local disconnect/tombstone/source removal for each Google profile. It
records eight workflow reads and zero model calls. It does not attest all APIs,
all users, provider-wide revocation, data deletion or Google verification.

The [three-Microsoft lifecycle/final-cleanup receipt](../qualification/microsoft-three-product45-oauth-2026-10-19.json)
(SHA256 `d909da439d1f58842b6e8a258200eb51073b57b009b8a77419cbc9c2d5d9805c`)
closes the shared receiving-runtime cleanup. Its three Microsoft lifecycles are
context, not Google evidence. Together these receipts cover seven limited
connector lifecycles, not seven Google scopes. The earlier separate Google
Calendar private/no-attendee event create/get/ETag-update/get/delete trial must
retain its original execution; it is not a fresh post-restart mutation test.

## Reviewer-facing description and data flow

Suggested description, subject to the operator's factual review:

> OpenAgent is a self-hostable agent app, CLI and server. Users explicitly connect
> an account to a named receiving server and authorize bounded workflows or agent
> tasks using the connected service. Gmail supports user-directed email work;
> Drive supports finding and working with existing files; Analytics supports
> read-only account/property reporting; Calendar supports selecting calendars
> and managing events. Connecting an account does not authorize every local
> agent or every write operation.

The shared authentication service performs code exchange and secret-dependent
renewal. The receiving host stores encrypted credentials and calls Google APIs;
normal email/document/event/report content does not traverse that service.
Configured models can receive authorized task content at the receiving host.
The submission must identify actual recipients, storage and model-provider data
handling, rather than claiming that every self-hosted or embedded configuration
is qualified. See [privacy](../site/privacy.md),
[operations](../site/guide/connector-operations.md), and
[composition boundaries](../site/guide/application-composition.md). The latter's
reference applications are architecture acceptance cases, not shipped UI claims.

Google's Workspace policy includes email-productivity uses, including generative
AI summaries, among permitted Gmail use cases; Drive productivity use must be
visible through the app UI. Proposed category: user-directed productivity/task
automation. Google must determine acceptance of the actual application, not its
SDK or a generic “AI agent” label.
[Workspace policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).

## Scope justifications grounded in implemented operations

These are draft justifications for the six **currently declared** scopes, not
proof that all scope-enabled operations were exercised. No scopes are added or
removed here. Use the exact Google URI prefix
`https://www.googleapis.com/auth/` for every suffix below.

| Scope suffix | Implemented purpose and proposed justification | Evidence and least-privilege gap |
| --- | --- | --- |
| `gmail.modify` | Restricted. Gmail message/thread/attachment reads, history/watch and unpublished draft creation support user-directed email processing. Source: SDK `providers/manifests.go` and `gmail.go`. | Real trial covered `outreach.gmail.messages.list` only. Read-only cannot create drafts; however the currently qualified read alone does not justify requesting every implemented write. Demonstrate the draft feature if retaining the broad profile. `gmail.modify` does not permit immediate permanent deletion. |
| `gmail.send` | Sensitive. SDK message/draft send operations are separately classified as publish actions. | No real send or draft trial is claimed. Google also accepts `gmail.modify` for message sending, so a separate send scope is not additional provider-enforced isolation. Its overlap requires an honest least-privilege explanation or a future reviewed scope/profile change; a local publish gate does not narrow the raw token. |
| `drive` | Restricted. The SDK can search existing account files and read/download/export them, and exposes separately admitted file/content/comment/permission operations. Source: SDK `providers/manifests.go` and `drive_upload.go`. | Real trial covered `files.drive.search` only. `drive.file` is Google's recommended per-file option; it does not provide unrestricted discovery of pre-existing unselected files. Broad existing-file discovery plus actual user-facing editing must be demonstrated if retaining `drive`. Do not describe this as a Picker-only integration or claim writes were tested. |
| `analytics.readonly` | Lists accessible GA4 account/property summaries and reads bounded reports, realtime reports and metadata. No Analytics edit scope is requested. Source: SDK `providers/google_analytics.go`. | Real trial covered `ads.google_analytics.account_summaries.list`; report execution remains separate. The read-only scope is accepted by that endpoint. Retain the exact classification shown in the project's Data Access console rather than inventing a classification from its name. |
| `calendar.calendarlist.readonly` | Lists/reads subscribed CalendarList entries so the user can select the target calendar. Source: SDK `providers/google_calendar.go`. | Real trial covered `files.google_calendar.calendars.list`. Does not require calendar ACL management or subscription writes. Confirm its sensitive/non-sensitive classification in Data Access. |
| `calendar.events` | Reads and creates/updates/deletes events on calendars already accessible to the account, subject to host write admission and provider access. | Separate private-event create/read/update/delete trial exists; the fresh lifecycle tested CalendarList. Read-only event scope cannot write; `events.owned` or `app.created` would limit the supported calendar surface and require a reviewed implementation/profile change. No calendar creation, ACL or full `calendar` scope is requested. |

Official endpoint/scope references:
[Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Gmail send accepted scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send),
[Drive scope classification and per-file alternative](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Analytics account summaries authorization](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

## Branding, domain and privacy gaps

| Item | Available source evidence | Remaining concrete material |
| --- | --- | --- |
| App identity | Registration says OpenAgent / OpenAgent Shared Connectors. Homepage source describes the modular product and connectors. Google now reports Branding verified and published. | Preserve that actual branding. The privacy notice uses a commercial service name; this dossier does not establish a legal entity or authority to represent one. |
| Homepage/privacy | Registration points to `https://openagent.uno` and `/privacy`. Homepage source and site navigation/footer link privacy and contact. | Confirm Google's verification of these actual deployed pages and their relevance. Source links and working DNS do not establish domain ownership. |
| Domain | All four registered callbacks use HTTPS on `auth.openagent.uno`; homepage/privacy use `openagent.uno`. | The first Branding check's ownership failure/24-hour warning is historical. Search Console verified the HTTPS homepage URL-prefix property via the 53-byte vendor HTML file, and the retried Branding check passed/published. No DNS TXT or Domain-property verification is claimed. Keep the HTML proof available; no current 24-hour block is asserted. |
| Notice | Current privacy source describes access/use, local encrypted credentials, central transient delivery, configured-model transfers, retention boundaries and disconnect versus deletion. | Operator review is needed for accurate controller/service identity, actual retention and deletion procedures, human access and recipient/model restrictions. The blanket “common apps ... not yet available” sentence predates the dated limited betas and needs a later reviewed update. Do not invent retention periods or guarantees. |
| Limited Use | Notice links the Google policy and disclaims advertising/sale/generalized-model training. | Review a clear affirmative Limited Use statement and demonstrate restrictions across receiving hosts/model processors. General model-provider choice is not proof that every configured destination complies. |

Google requires accurate branding, a public relevant homepage, linked privacy
information and verified domain ownership. These checks must use the existing
registration; this dossier does not request another app or client.
[Brand and sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

Google's data-use rules restrict transfers, human access and downstream use;
consent must match actual visible features. The assessment must reconcile
durable task/session results and caches with provider retention/deletion rules,
and show how revocation stops future access without pretending it deletes
already stored history. Generalized model training is not an authorized use.
[API User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).

## Actual data-access form and draft field text

After published brand verification, the operator opened Google's data-access
form. It requires three justifications (maximum 1,000 characters each): the
sensitive group `calendar.events`, `gmail.send`, `analytics.readonly`; restricted
`drive`; and restricted `gmail.modify`. The observed intended-use selections
were **Produttività Drive** and **Produttività email**. The required YouTube URL
is missing and Save is disabled. The operator entered the three texts and
selected those categories, but no data-access application was saved/submitted.
The private form-witness SHA256 is `f2e4698926c2da00698836f651c8493f7138a79926aff86a46467971597d92d8`.
The following are the entered draft text, not submitted or approved answers.

### Sensitive group (861 characters)

OpenAgent exposes user-authorized connector operations through its app/server workflows. calendar.events enables reading, creating, updating and deleting events on calendars the connected account can access; read-only event access cannot support these writes. analytics.readonly lists accessible GA4 accounts/properties and reads reports without Analytics administration writes. gmail.send is required by the current connector's separately admitted send/publish operations; no email is sent by simply connecting. gmail.modify also authorizes sending at Google, so the separate send scope is a local operation contract, not narrower provider access. The 19 October trial proved calendar selection, Analytics account summaries and refresh/restart/disconnect; a separate private Calendar event trial proved create/read/update/delete. No real Gmail send is claimed.

### Drive restricted (769 characters)

OpenAgent's Drive connector lets the user find existing files and folders in their connected account and invoke separately authorized metadata, content, comment and permission operations through the receiving server. The drive scope covers discovery and editing of pre-existing files that were not individually selected for this app. drive.file would limit access to app-created or individually shared/selected files and would not preserve that existing-file discovery surface. The implemented API surface includes writes, but the 19 October real-account trial proved only a bounded files search plus refresh, restart, reread and local disconnect. Broader feature demonstration remains to be supplied; no completed Google verification or security assessment is claimed.

### Gmail modify restricted (821 characters)

OpenAgent's Gmail connector supports user-directed email productivity: bounded message search/list, just-in-time message/thread/attachment reads, history/watch and creation of unpublished drafts. gmail.modify is requested for the implemented read-and-draft surface; gmail.readonly cannot create drafts and gmail.metadata cannot read bodies or attachments. Send operations have separate local publish admission and a gmail.send scope requirement, although gmail.modify itself also authorizes sending at Google. The 19 October real-account trial proved bounded message listing, explicit refresh, process restart, reread and local disconnect only; no real draft creation or email send is claimed. This justification does not attest Google verification, CASA completion or every receiving host/model provider's data handling.

## Demo and assessment package still required

No verification/demo video was found by filename in the existing activation
folder or the delivery-evidence video inventory checked on 19 October. Screenshots,
workflow hashes and signed receipts are partial evidence, not a video substitute.
**No video URL is supplied.**

Prepare an English recording of: the actual app and user-facing purpose; the
normal connect/disclosure and OAuth grant with app/client identity visible;
each requested sensitive/restricted feature; where workflow data moves; and
local disconnect. For automation, show multiple real workflow definitions and
data directions. Use bounded, explicitly approved non-sensitive test data;
recording or additional write actions require their own authorization. Supply
an unlisted reviewer-accessible video after it actually exists.

Restricted `drive` and `gmail.modify` mean a server-mediated design must not
assume a self-hosting exemption. No Google-approved assessment, assessor report
or Letter of Assessment was found in the evidence inspected. Determine the
actual review/assessment request with Google and a designated assessor; retain
the result and its scope/expiry. Existing race/vet, vulnerability/secret scans,
encryption and lifecycle receipts are supporting engineering evidence, not
CASA approval. No payment or assessor engagement is authorized here.
[Restricted-scope verification and demo/assessment requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Submission handoff

1. Preserve the current app/client, six declared scopes and four callbacks,
   the verified published branding and URL-prefix ownership proof. Record Data
   Access classifications and the Verification Center's actual requests;
   published branding does not complete that separate review.
2. Confirm owner identity/contact, domain ownership and the privacy/recipient
   data-flow statements above. Resolve the Gmail scope overlap and justify the
   broad Drive surface using demonstrated features, not a catalog card.
3. Attach the two immutable lifecycle receipts as partial evidence, then provide
   the missing demo and any required security-assessment evidence.
4. Submit only truthful answers through the existing console and record Google's
   resulting status. Until approval, keep `verification_complete` and
   `general_public_qualification` false and disclose warnings/user limits.

## Explicit limited-trial preparation

The historical four-Google lifecycle ran while the app was in **Testing** with
an approved test account. It is not retroactively labeled a verified production
trial. The new publication state is recorded separately.

The candidate `prepare-provider-trial.py` retains its historical Testing mode
and adds **only** the explicit `--google-production-unverified-trial` flag for
a Google provider. Example, from the Tools repository with an operator-reviewed
baseline file and a new output directory:

```sh
python3 deploy/connector-auth/prepare-provider-trial.py \
  --provider google_calendar \
  --google-production-unverified-trial \
  --baseline-providers /private/reviewed-providers.json \
  --output /private/new-google-limited-trial
```

This file-only preparation requires the recorded external `in_production` /
`unverified` state, false verification/public-qualification flags and an observed
count below the unverified 100-user cap. That observation is not a reservation
or bypass of Google's live limit. API enablement, exact registered callback,
client, Secret reference, fixed endpoints and declared-scope checks still apply.
Missing the explicit flag refuses production metadata; the flag refuses Testing,
unknown or verified-state metadata and cannot select a Microsoft profile.

Output preserves the existing reviewed public rows and every other baseline
row. It changes no live configuration, Secret, host default, scope or grant.
The output receipt labels `production-unverified-limited-trial`, attests no
provider review or public qualification, and authorizes no broker apply. It
cannot replace an existing provider row; an existing eleven-profile deployment
needs no additive preparation merely because the console publication changed.
The accompanying 18 standard-library file tests passed; they exercise
preparation only and make no provider call.
