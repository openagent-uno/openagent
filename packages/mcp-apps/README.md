# Optional MCP Apps host

This source candidate implements the stable [MCP Apps 2026-01-26 specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). It is independent of Electron, Core, model providers and the consuming product's identity system. It has no runtime dependencies and contains original implementation code.

`mountMcpApp` renders a `text/html;profile=mcp-app` resource through a trusted proxy on a **different origin** and an opaque inner iframe. `buildSandboxProxyHtml` and `SANDBOX_PROXY_HEADERS` supply that proxy. Serve it on an origin without product APIs, cookies, storage or native bindings. The host page must have a non-opaque HTTP(S) origin. Do not load untrusted HTML into the product renderer or a preload-enabled WebContents.

The browser entry is `src/index.mjs`; it exports `McpAppSession`, `mountMcpApp`, `loadMcpAppResource`, `parseUiResource` and capability constants. `src/index.d.ts` defines the complete API. Serve the three browser modules as a fixed allowlist, or bundle the entry with the consuming product's normal bundler. Raw HTML is passed only to the isolated proxy. Tool input/result data and lifecycle messages wait for the guest initialization handshake. Unknown methods and unsupported versions fail explicitly.

## Authenticated source binding

A trusted host supplies `{sourceId, toolRef, contextId, capabilityEpoch}` and a broker. The guest never supplies or replaces this binding. Each operation reauthorizes it and checks publication rights again after success **or failure**. `callTool` must resolve a named sibling only within the originating capability registration; `readResource` must use the same authorized registration. Neither a URI nor a tool name grants access. The broker must check current principal, tenant, session, audience, lease and registration lifetime against host-owned state. Root/Core's public source-bound services own these checks; JavaScript validation is not an authorization substitute.

The session supports `ui/initialize`, initialized notification, complete/partial tool input, lossless tool results, tool cancellation, resource reads, tool calls, resize, external links, user-message requests, model-context updates, display-mode requests, logging and teardown. Optional callbacks are advertised only when supplied. Message requests currently accept bounded text content; hosts needing other message block types must extend their explicit content contract. `ui/update-model-context` calls the context callback and never synthesizes a user message or follow-up itself.

Provide the original complete `toolInput` at mount, or call `setToolInput` once when available. Results wait for that input and initialization. If arguments are genuinely unavailable, explicitly close the input stage with `setToolInputUnavailable()`; it emits no fabricated argument notification. Result-only mounts close that stage automatically, and the desktop buffer handles result-only or cancellation-only bootstrap in the same way. `cancel` suppresses late original-tool results and aborts pending guest calls. `revoke` aborts and removes the app immediately. `dispose` allows a short teardown window, then closes it. Restart/revocation must invalidate the broker's captured epoch as well as closing the presentation.

## CSP and permissions

Declared resource CSP is intersected with the host's explicit `approvedCsp`. Missing approvals grant no external network, scripts, frames or base URIs. The parent host and proxy service origins cannot be granted to app CSP. Permissions similarly require both a resource declaration and an explicit `grantedPermissions` flag. Default camera, microphone, location and clipboard permissions are denied. HTTPS/HTTP link requests use a separate authorized callback; other URL schemes cannot reach it. Untrusted content receives no storage or same-origin privileges. HTML's own CSP cannot loosen the earlier injected policy.

## Verification

`node --test test/protocol.test.mjs` tests the pure session. `test/browser.test.mjs` uses the product's existing Playwright installation to launch a real headless Chromium with two local HTTP origins and a third external-resource fixture. Set `OPENAGENT_TEST_CHROMIUM_PATH` when using an explicitly installed browser binary. Phase C passed **58 tests and all six desktop/universal TypeScript checks** against the `0.1.0-source.6` runtime: 17 protocol, 11 sandbox/CSP browser, 21 desktop-service browser, six actual product policy-adapter, and three actual draft-component tests. Coverage includes actual iframe interaction, source/origin forgery, pre-request navigation blocking, CSP/base/CDN approval and denial, cancellation, live result delivery and revocation races. The three installed runtime copies were verified byte-identical to the qualified package source; a later documentation-only archive must retain that runtime identity and record its own version/hash.

This is source qualification, not a published package, signed desktop release or live third-party connector acceptance. The fixture app in `fixtures/counter.html` is synthetic. The package version intentionally carries a private `source` prerelease; consumers must pin the actual packed candidate and its hash rather than pretending it is a public release.


The desktop service is exported at `@openagent/mcp-apps/desktop`. Its browser broker forwards abort signals and rejects late publication after close, owner change or revoked authorization. `test/desktop.test.mjs` runs the real Node service in Chromium; `test/surfaces-browser.test.mjs` bundles the actual three adopter surface components. `test/runtime-browser.test.mjs` is an optional full integration test selected by `OPENAGENT_TEST_RUNTIME_ROOT`, `OPENAGENT_TEST_PRODUCT` (`glasspalace`, `ics` or `standalone`) and `OPENAGENT_TEST_PYTHON`. The standalone handler fixture additionally takes `OPENAGENT_TEST_RUNTIME_FIXTURE_ROOT` pointing to the adopter fixture repository. These tests compile the actual product desktop adapter and use the installed source tarball, so response wrapping, route selection and account selectors are exercised. Their control-plane identity/session endpoints are owned fixtures, not production authentication evidence.


The Node desktop service accepts a trusted `approvePolicy` callback. It receives
only the parsed declaration and can approve a subset for one view; it cannot
add domains that the resource did not declare. Desktop approvals accept exact
public HTTPS domain origins and exclude wildcard, IP and local hostnames.
Resource metadata alone grants nothing. The three product adapters present a
native confirmation for external resources and for opening an external link.
They recheck session/owner authorization after confirmation. Hardware iframe
permissions remain denied in these adapters. `ui/message` creates only a reviewable draft: an exact-owner native confirmation precedes a typed event to that renderer, and a second explicit Insert action preserves the existing composer text. The user sends through the normal chat control; the app request never sends as the user.
The native callbacks and CDN approval path passed Phase C. Callback tests compile the actual three product adapters with controlled Electron dialog/shell effects; they do not claim that a real OS consent dialog was clicked. CDN tests observe an owned HTTPS server using browser-process-only test hostname mapping and isolated-context TLS relaxation, without changing system DNS or trust stores.


Policy confirmation starts on the view's first resource-data load, after its
opaque view handle has been published. Closing/unmounting that view aborts the
parented native dialog immediately; its original session lifetime still applies.
Owner, exact main frame and authorized backend session are checked again before
CSP publication, link opening or draft delivery. Dialogs have no unparented macOS
fallback. Resource metadata cannot enable these host callbacks.

The safe draft path accepts bounded text content, including the stable spec's
single text block and existing content arrays. Other block types and non-user
roles fail explicitly. Suggested text remains visibly attributed to the app.
The three renderer review components reject stale account, actor, workspace,
agent or session scopes. They never invoke a chat-send API.

The completed serial qualification used `test/protocol.test.mjs`, `test/browser.test.mjs`, `test/desktop.test.mjs`, `test/product-policy.test.mjs` and `test/draft-surfaces-browser.test.mjs`, followed by desktop and universal `npx tsc --noEmit` in OpenAgent, GlassPalace and ICS. The comparison workspace receipt `outputs/openagent-codex-phase3/mcp-phase-c.json` records commands, logs, hashes and acceptance boundaries. Draft tests use the actual components in an owned composer fixture; full authenticated installed-product acceptance remains separate.


Interactive host decisions retain a SHA-256 request identity instead of the
full draft/link payload. Reusing an ID with changed arguments is rejected;
identical pending requests join the original operation. Each view admits one
pending native decision across CSP approval, external links and draft review.
Other request IDs fail as busy without being queued or retried automatically.
The normal per-view request-count and lifetime bounds still apply.


The proxy installs a per-view `frame-src` meta policy before creating the guest.
It permits only its own origin for the initial `srcdoc` and the host-approved
frame domains. This is separate from the guest's own CSP: direct guest
self-navigation must be blocked before a network request can disclose data.
There is no fetch-then-revert navigation guard. Qualification includes a denied
navigation with zero fixture-server hits and an approved frame-origin control.

The same trusted per-view proxy meta policy supplies `base-uri`: the approved
base domains or an explicit `'none'` default, installed before guest creation.
The static proxy header does not impose an unconditional inherited base ban.
The guest's own policy intersects the same approval. The proxy inserts no base
element and resolves its host origin from `location`, not `document.baseURI`.
The passing Chrome regression proves an approved base loads a relative script and
a denied base produces zero requests at that origin.


The optional `test/client-runtime-browser.test.mjs` qualifies the canonical
client resource route through the actual desktop socket/bridge, direct facade,
two owned SDK MCP stdio peers, gateway registry and `_current_client` handler,
Core source leases, actual desktop adapter and Chrome. It is gated by
`OPENAGENT_TEST_CANONICAL_CLIENT_RESOURCES=1` and `OPENAGENT_TEST_PYTHON`, with
source/installed Python dependencies supplied by the qualification environment.
Only the fixture certificate middleware and renderer ingress are controlled;
this does not prove production cryptographic authentication. The facade fixture
requires an ownership marker, has no native/browser builtins or broker daemon,
and awaits owned MCP children during cleanup. The canonical and both Computers client-resource chains passed local source qualification; installed-wheel graph acceptance is recorded separately by the packaging qualification.


Client-provided Apps have separate end-to-end fixtures. `test/client-runtime-browser.test.mjs` uses the canonical real capability WebSocket/current certificate-origin selector and lease, raw resource frames, facade, two owned stdio MCPs, actual desktop adapter and Chromium. `test/computer-runtime-browser.test.mjs` uses the GlassPalace/ICS Computers v2 desktop executor and per-server runtime sources, with a controlled authenticated control-plane ingress; signed current-lease behavior is tested separately by the products' Go suites. Both fixtures give two servers the same URI and deny calls to a sibling belonging only to the other server. The canonical fixture also cancels an in-flight resource read. Every fixture uses an explicitly owned direct facade without native/browser builtins or a persistent broker daemon and awaits its own children before cleanup. Enable the respective tests with `OPENAGENT_TEST_CANONICAL_CLIENT_RESOURCES=1` or `OPENAGENT_TEST_COMPUTER_CLIENT_RESOURCES=1`; supply the actual Python runtime and a locally installed Chromium path. These tests qualify local source/candidates, not production authentication or third-party services.


The desktop presentation buffers bootstrap and live invocation display until its
controller exists. It publishes input first, then the final result or cancellation
once, preserving the complete result. Browser authorization sends
`display_received:true` after accepting a terminal display; host-only authorization
guards always request authorization without a display snapshot. Delivery is
scheduled outside authorization to prevent recursive authorization/flush loops.
Passing Chrome tests cover delayed lossless results, cancellation, late-result suppression, completed/cancelled bootstrap receipts and terminal displays without available arguments. No empty input is invented.
