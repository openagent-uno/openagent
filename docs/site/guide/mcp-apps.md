# MCP Apps: source integration and local qualification

Date: 30 October 2026. This is a local source candidate; it does not attest a signed desktop release, a deployed web host or a live third-party MCP installation.

The implementation follows the [stable MCP Apps specification dated 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). A tool declares `_meta.ui.resourceUri`; its originating server serves exactly that `ui://` resource with MIME `text/html;profile=mcp-app`. Tool visibility defaults to `model` and `app`; `app`-only tools stay out of model discovery, and `model`-only tools cannot be called by an app.

## Product composition

The transcript retains the text tool result and offers **Open interactive view** only when it has both the saved opaque tool reference and declared UI metadata. Opening is explicit. The frontend supplies the current authenticated session and product selector; the host independently resolves the current account/principal, session audience and originating registration. Neither the resource URI nor a source name can select another executor.

The universal web component embeds a trusted host page. The shared optional `@openagent/mcp-apps` package serves that host page and an isolated proxy on two separate loopback HTTP origins in desktop compositions. Source HTML runs in an opaque inner iframe with scripts only. It cannot access product/native IPC, parent storage, cookies or privileged host endpoints. Declared CSP/permissions are intersected with explicit host approvals; default external network, camera, microphone, location and clipboard access are denied. An explicitly configured web deployment must provide its own separate HTTPS proxy origin and authenticated transport. Missing transport presents capability unavailable. Native mobile has a text fallback.

The host implements initialization/version negotiation, original tool input and result delivery, resize, source-bound tool/resource requests, context updates, cancellation and teardown. Optional link/message callbacks are advertised only when the product supplies them. A request cannot alter the captured tenant/principal/session/audience, registration lifetime or capability epoch. Account/session changes hide and close old views; late opens cannot attach to a new context. Revocation closes the sandbox and pending actions are not automatically replayed. A cancelled or disconnected mutation may have an uncertain external effect; its request ID remains reserved.

The Python host uses the public Core `McpAppService`, `CapabilityCatalog.describe_tool/read_tool_resource/call_source_tool` and optional store `read_tool_invocation` APIs. Saved input/result data comes from an exact authorized session invocation, not caller-provided HTML or result data. Managed transports and custom sources retain tool `_meta`, use exact-origin resource reads, recheck publication rights and maintain the product sandbox consent checks. Existing published release locks are not evidence for these new contracts: the source composition requires the actual Core and SQLite candidate `1.1.0b38.dev2026103005` artifacts. The optional route service returns `mcp_app_runtime_upgrade_required` when its required public service APIs are missing.

## HTTP contract

POST `/api/sessions/{session_id}/mcp-apps/open` accepts `{tool_ref, tool_call_id?}`. POST `/api/sessions/{session_id}/mcp-apps/{handle}/request` accepts `{method, params, request_id?}`. POST `/api/sessions/{session_id}/mcp-apps/{handle}/cancel` accepts `{request_id}`. POST `/api/sessions/{session_id}/mcp-apps/{handle}/close` accepts `{}`. Every operation resolves the authenticated account and exact session; request body fields cannot supply identity or execution context. The desktop main process binds the request to the exact account loopback and renderer consumer; the gateway derives identity from authenticated ingress. Each opaque handle is additionally bound by Core to the full resolved execution context.

Original display data is optional when no saved invocation was selected. No empty input is invented to unblock result ordering. HTTP request IDs identify one operation and argument set; cancellation or retries never create a new mutation implicitly. A context mismatch cannot close or consume another viewer's handle.

## Evidence and limits

The source tests exercise actual Chromium, HTTP and independent stdio MCP processes. Local acceptance covers real UI rendering, two button mutations, denial of model-only and other-source tools, actor/session mismatch, undeclared resources, request-ID replay, cancellation, owner-close isolation and live revocation. The actual universal surface source was bundled with real React/React Native Web to verify opening, closing, session/account changes and late-open cleanup. Controlled identity and proxy fixtures are explicit; this is not an authenticated production account test.

The shared library separately tests source/origin forgery, CSP denial/approval, native privilege isolation, initialization ordering, process-independent cancellation and teardown. Packaging must pin the genuine private source tarball and actual hash. No proprietary implementation source was copied.


## Client-provided resources and current origin

The canonical desktop path retains tool `_meta` and negotiates `mcp-app-resources/1` per originating server. The exact account loopback and renderer are selected in Electron main. Main supplies `X-OpenAgent-Client-Instance` from its current client-instance identity; a model or resource URI cannot supply this authority. The gateway's `_current_client` resolves that selector only under the verified device certificate and current device-auth epoch, then obtains the exact registered client origin. The `ExecutionContext` carries the matching session capability leases.

The dedicated `client_resource_read` frame carries the original server, session, generation and certified account/network; its channel is bound to the verified client instance and auth epoch. Replies retain raw MCP resource contents. The broker independently checks consent, principal, declared resource and the provider generation before publication. Cancellation propagates through registry, WebSocket, bridge, facade and SDK stdio; reconnect or another server with the same URI never supplies a fallback. Old host bundles without the negotiated flag fail explicitly.

GlassPalace and ICS expose their per-server authorized MCP catalog/resource routes through Computers v2 and the runtime `ComputerMcpSource`. Current signed lease, actor, workspace, computer, generation, session and explicit local server allowlist remain required. This path is separate from the existing fixed filesystem/shell relay. Raw sibling tool names and duplicate `ui://` URIs stay within the exact originating server.

The three actual client-resource chains passed local source qualification with two independent owned SDK stdio peers, actual desktop adapters and Chromium. Canonical tests also cover a wrong current-client selector, cancellation and channel revocation. Their certificate/control-plane ingress is a controlled fixture; production certificate issuance and signed lease behavior are separate acceptance boundaries. Final installed-wheel graph/client reruns are tracked by the packaging receipt rather than inferred from source results.

## Host policy, drafts and live display

The proxy installs trusted per-view `frame-src` and `base-uri` restrictions before creating the guest. Unapproved self-navigation is blocked before a network request can leak data. Explicit public HTTPS resource origins require a parented native confirmation; wildcard, IP and local origins cannot be granted by that desktop callback. Frame/base approvals are intersected with the resource declaration. Tests observe zero requests for denied navigation/base URLs and positive requests for approved frame/base/CDN controls.

Link opening rechecks the exact owner window, main frame and backend session after a cancellable native confirmation. `ui/message` supports bounded text proposals only: native review, a typed event to the exact owner renderer, a source-attributed draft and an explicit Insert action preserving existing composer text. Sending remains the user's normal chat action. Camera, microphone, geolocation and clipboard iframe permissions remain denied by the product adapters; metadata never grants hardware access.

Saved invocation display uses a trusted live reader. `authorize` accepts `display_received:boolean` and may return `{authorized:true, display:{toolInput, toolResult?, toolCancelled?, toolStatus}}` until the desktop acknowledges a terminal display. The desktop buffers until the controller exists, publishes one final result or cancellation and suppresses late duplicates. When arguments are unavailable, `setToolInputUnavailable()` closes the input stage without emitting fabricated input.

## Phase C qualification

The `0.1.0-source.6` runtime passed **58 tests plus all six desktop/universal TypeScript checks** in OpenAgent, GlassPalace and ICS. The three installed runtime copies and source.6 archive hashes matched. The comparison workspace's `outputs/openagent-codex-phase3/mcp-phase-c.json` and `.md` record exact logs, hashes and limits. A later documentation-only package has a distinct version/hash while preserving these qualified runtime JavaScript/declaration bytes.

Native callback tests use the actual adapters with mocked Electron dialog/shell effects; no real OS consent dialog was clicked in those tests. Draft components run in an owned composer fixture, not a full authenticated installed application. No source result alone proves a signed release, production account or live third-party service. The current Core and SQLite source composition is `1.1.0b38.dev2026103005`; capability-host transport uses `1.0.0b2.dev2026103002`. Candidate graph versions and hashes must be taken from the actual packaging receipts, not old published release locks.

The Core host service retains at most 16 MiB of serialized completed results globally, 32 active delivery cohorts and 8,192 reserved IDs. Expired cache entries never permit a repeated mutation. A pending duplicate disconnect cannot cancel the original operation; current callers retain complete results through publication authorization.
