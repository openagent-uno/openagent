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
gate. At that earlier checkpoint no data-access application had been submitted.
The later submission is now in review, as recorded below; scope approval and
security-assessment completion are not established. Private witness SHA256:
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
| `gmail.modify` | Restricted. Gmail message/thread/attachment reads, history/watch and unpublished draft creation support user-directed email processing. Source: SDK `providers/manifests.go` and `gmail.go`. | The historical server45 trial covered `outreach.gmail.messages.list`. A new server47 trial created one generated self-addressed draft; its single normal `drafts.send` workflow succeeded at 11:22:52 UTC. A subsequent exact sent-message read verified the same sender/recipient, generated subject marker, SENT and no DRAFT; the pre-send canonical draft query returned no remaining draft. No resend occurred. Read-only access cannot create that draft; this bounded trial does not qualify all implemented writes. `gmail.modify` does not permit immediate permanent deletion. |
| `gmail.send` | Sensitive. SDK message/draft send operations are separately classified as publish actions. | A new server47 trial created one generated draft and submitted that same draft once to its authorized sender at 11:22:52 UTC. An exact sent-message read subsequently verified self-addressing, the generated subject marker and SENT without DRAFT, while the prior canonical draft query found no remaining draft. No second send or external delivery claim is made. Google also accepts `gmail.modify` for message sending, so a separate send scope is not additional provider-enforced isolation. Its overlap requires an honest least-privilege explanation or a future reviewed scope/profile change; a local publish gate does not narrow the raw token. |
| `drive` | Restricted. The released catalog exposes search, metadata get, content download, content create and content update. Other manifest operations are not automatically catalog tools. Source: SDK `catalog.go`, `providers/manifests.go` and `drive_upload.go`. | Server47 generated-file create/read/content-update passed on 19 October. The attempted cleanup helper stopped before any unexposed metadata workflow; the authorized owner moved that exact file to trash in Google's UI, followed by two normal API reads verifying trash state and the owned marker. API trash, comments and permissions edits are not qualified. `drive.file` does not preserve discovery of pre-existing unselected files; that broader discovery requirement remains part of the scope justification. |
| `analytics.readonly` | Lists accessible GA4 account/property summaries and reads bounded reports, realtime reports and metadata. No Analytics edit scope is requested. Source: SDK `providers/google_analytics.go`. | The historical server45 lifecycle and new server47 demonstration both covered `ads.google_analytics.account_summaries.list`; no report or write was run in the new demonstration. The read-only scope is accepted by that endpoint. Retain the exact classification shown in the project's Data Access console rather than inventing a classification from its name. |
| `calendar.calendarlist.readonly` | Lists/reads subscribed CalendarList entries so the user can select the target calendar. Source: SDK `providers/google_calendar.go`. | Real trial covered `files.google_calendar.calendars.list`. Does not require calendar ACL management or subscription writes. Confirm its sensitive/non-sensitive classification in Data Access. |
| `calendar.events` | Reads and creates/updates/deletes events on calendars already accessible to the account, subject to host write admission and provider access. | Both the earlier private-event trial and the new server47 owner-verified, no-attendee create/get/ETag-update/get/delete cycle passed. No independent absence read after the new delete is claimed; the separate beta47 four-profile refresh/restart/post-read/disconnect cycle subsequently passed at 11:38:42 UTC, followed by stopped QA processes and erasure of the exact temporary profile, including credentials, at 11:50:35–36 UTC after verified safe evidence export. Read-only event scope cannot write; `events.owned` or `app.created` would limit the supported calendar surface and require a reviewed implementation/profile change. No calendar creation, ACL or full `calendar` scope is requested. |

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

The separate [server47/SDK19 Google4 demonstration and full lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/google-demo-product-1.1.0b47-2026-10-19.json)
records the new generated-file/draft/event operations, Analytics account summary,
refresh, real restart, post-reads and normal disconnect. Owned processes were
stopped and the exact temporary credential profile erased after verified safe
evidence export. The owned worker was subsequently deleted after the final
video export and remaining QA cleanup; shared persistent state was preserved.

## Actual data-access form and entered field text

At 11:41:08 UTC on 19 October, the operator verified the following text in
Google's actual form. These replace the earlier entered drafts, including their
now-outdated "no real send" statement and the overly broad Drive description.
The original checkpoint remains in source history. The intended-use categories
are **Produttività Drive** and **Produttività email**. The unlisted demonstration video is now uploaded, and the reviewer URL was
supplied privately in Google’s console and persisted in this form. Google confirmed that the
data-access changes were saved, then at **12:11:38 UTC** the Verification
Center confirmed **data access in review**. Submission is complete; no
data-access approval or security-assessment completion is claimed. Form witness SHA256: `1f59dd740b9c71b0852918d93952c9e49bc3413d670031c7ffba26b8fb55a93e`.

### Sensitive scope group (954 characters)

OpenAgent exposes user-authorized connector operations through its app, CLI and receiving server. calendar.events enables event reads and create/update/delete operations on accessible calendars; read-only scope cannot support these writes. analytics.readonly lists accessible GA4 account/property summaries and supports read-only reports without Analytics administration writes. gmail.send is required by the connector's separately admitted send operations; connecting alone never sends mail. gmail.modify also allows sending at Google, so local publish admission does not narrow the token's provider permissions. Live QA demonstrated a private Calendar event create/read/update/delete without attendees, Analytics account summaries, and one generated Gmail draft sent once to the same authorized account. Credentials stay on the receiving server, which performs normal API calls. Google data-access approval and any applicable assessment remain pending.

### Drive restricted (840 characters)

OpenAgent searches and reads existing Drive files and supports creating and updating file content through user-authorized server workflows. The drive scope preserves access to pre-existing files not individually selected for this app; drive.file would limit access to app-created or individually shared/selected files. The released catalog exposes search, metadata get, content download, content create and content update only. The QA demonstrates generated-file create/read/content-update. Recoverable trash was performed by the authorized owner in Google's UI and independently checked through the connector; no connector trash or permission-edit operation is claimed. Credentials stay on the receiving server and normal Drive API traffic leaves that server. No completed Google data-access verification or security assessment is claimed.

### Gmail modify restricted (879 characters)

OpenAgent supports user-directed Gmail productivity through the receiving server: bounded message search/list and just-in-time message, thread and attachment reads, plus creating unpublished drafts. gmail.readonly cannot create drafts and gmail.metadata cannot read message bodies or attachments. The current connector uses gmail.modify for read/draft operations and a separate local publish admission plus gmail.send requirement for sending; gmail.modify also permits sending at Google, so this local distinction does not narrow the raw token. The live QA created one new plain-text draft and submitted that same draft once to the authorized test account itself; no existing mail or other recipient was modified. Credentials are encrypted locally and ordinary Gmail API traffic leaves that server. Google data-access review and any applicable security assessment remain pending.

The Gmail result was additionally checked by the exact returned sent-object
ID: same sender/recipient, generated subject marker, SENT and no DRAFT; the
pre-send canonical draft query found no remaining draft. The provider rewrote
RFC Message-ID, so the original was retained and the verified returned object
identity was used for follow-up reads. No resend occurred. This does not make
the sanitized live viewer an exhaustive provider request log.

## Actual demonstration video and pending assessment

The approved demonstration now exists: **4 minutes 32 seconds**, 34 actual
chronological browser captures, 1,920×1,080 H.264, **3,832,045 bytes**, SHA256
`d82d5f007eacf90af1a9ac5876f0fc974a402e8be135808f35043a913c4a8450`.
The operator reviewed five decoded thumbnails and accepted the readable render.
It shows the real provider consent flows and sanitized normal server47
CLI/Gateway workflow output. English captions identify the receiving path,
original capture times, shortened pauses and the later scrolled views of
recorded actual output. It is **not continuous screen recording or App22
native UI**, and the visible event stream is not an exhaustive provider log.
No planned or synthetic event is presented as a completed provider call.

The first encoded version had oversized captions; it remains preserved
privately as a visual failure. The replacement changed presentation only,
using the same 34 source images, captions and 272-second chronology. No image
content or provider result was edited. The Drive catalog boundary and owner
UI-assisted trash remain visible rather than being replaced with API-success
claims. Encoding took place on the bounded remote worker after QA processes
stopped and the temporary credential profile was erased.

**Unlisted reviewer URL supplied privately in Google’s console.** The URL,
video ID and channel/account identifiers are deliberately not published here.
YouTube Studio showed the saved unlisted visibility, completed SD/HD processing
and no issues in its checks. The upload used the existing channel after explicit
approval of the upload terms. The same URL was then saved in Google's data-access
form with the three entered justifications unchanged. The subsequent Verification Center displayed that the app's data access is
**in review** at 12:11:38 UTC. This is actual submission, distinct from the
earlier form save and from approval. The video and lifecycle receipts support the review;
they do not establish acceptance by Google or qualification of every operation,
receiving host, model processor or account type.

The additional information submitted with the application was:

> OpenAgent is a self-hosted, model-agnostic agent runtime with an app, CLI and server. The attached 4:32 demonstration shows Google consents and normal public server47/SDK19 workflows. It is a chronological sequence of real browser captures with English captions, not continuous recording or native App22 UI. Drive starts at 0:08; Gmail at 1:36; Calendar at 2:40; Analytics at 3:20. Only generated QA files, one self-addressed email and a private event without attendees were changed. Normal Google API calls originate on the receiving server, which stores encrypted credentials; the shared service handles secret-dependent OAuth exchange/renewal. Google stays explicit opt-in, outside the seven-provider default. All four trial connections passed refresh/restart/read/disconnect; the disposable credential profile was erased. No data-access approval or applicable security-assessment completion is asserted. Setup/privacy: https://openagent.uno/guide/connectors and https://openagent.uno/privacy

The submission flow stated that CASA is required before approval; the operator
acknowledged that requirement. No assessment was purchased or completed.
The actual submission witness SHA256 is `ff65518bed7ecaa4101049d2f90971acfd069ca7b3d446bcfbafa09443f06a50`.

Restricted `drive` and `gmail.modify` mean a server-mediated design must not
assume a self-hosting exemption. No Google-approved assessment, assessor report
or Letter of Assessment was found in the evidence inspected. Determine the
actual review/assessment request with Google and a designated assessor; retain
the result and its scope/expiry. Existing race/vet, vulnerability/secret scans,
encryption and lifecycle receipts are supporting engineering evidence, not
CASA approval. No payment or assessor engagement is authorized here.
[Restricted-scope verification and demo/assessment requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Review follow-up

1. Preserve the current app/client, six declared scopes and four callbacks,
   the verified published branding and URL-prefix ownership proof. Record Data
   Access classifications and the Verification Center's actual requests;
   published branding does not complete that separate review.
2. Confirm owner identity/contact, domain ownership and the privacy/recipient
   data-flow statements above. Resolve the Gmail scope overlap and justify the
   broad Drive surface using demonstrated features, not a catalog card.
3. Attach the dated immutable lifecycle and demonstration receipts as partial
   evidence; keep the uploaded unlisted reviewer URL in Google’s console and
   private evidence only. Supply any
   security-assessment evidence Google requests.
4. Preserve the submitted answers and Google's actual in-review status. Respond
   through the existing review if more evidence is requested. Until approval,
   keep `verification_complete` and
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
The finite preserve-only set also retains existing Slack/Postiz rows only when
they exactly match reviewed source; neither can be selected for addition by this
preparer, and unknown/Atlassian baseline additions remain rejected. The output
receipt labels `production-unverified-limited-trial`, attests no provider review
or public qualification, and authorizes no broker apply. It
cannot replace an existing provider row; an existing thirteen-profile deployment
needs no additive preparation merely because the console publication changed.
The accompanying 20 standard-library file tests passed; they exercise
preparation only and make no provider call.
