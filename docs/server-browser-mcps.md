# Server browser dependencies for custom MCPs

The standalone server does not lend an App or CLI device's `agent-in-chrome`
capability to Telegram, another channel, or a scheduled run. It can register
its **own** `agent-in-chrome` and `computer-control` sidecars by listing them in
`server_host_tools.tools`; those have a distinct host destination and are
available to channels and automation. A separately registered server MCP may
also depend on a browser running on the agent host. The host must provision
its graphical session and sidecar dependencies explicitly.

For a CDP-backed MCP, use a dedicated persistent profile owned by the agent's
operating-system account. Bind the debugging endpoint to `127.0.0.1`, keep its
port stable for the MCP configuration, and run the browser under a service
manager with automatic restart. On a headless Linux host, a virtual X server
can preserve the browser's normal rendering behavior. Keep the profile across
service restarts to retain cookies; do not delete or replace it as part of a
health repair. The browser service is a durable dependency, not a diagnostic
process to clean up after a test.

For `agent-in-chrome` attached to an external Chrome service, set
`server_host_tools.browser.external_supervisor: true`. The service must record
the exact `DevToolsActivePort` marker after each Chrome start; the sidecar
checks the marker's port and WebSocket path before attaching. The product's
`apps/server/scripts/record-browser-ownership.py` verifies the same-user Chrome
process, profile and loopback CDP endpoint before writing that marker. Keep a
fixed display number and Xauthority file when `computer-control` shares the
service's Xvfb display. Stopping the browser MCP then leaves the supervised
Chrome process alive, including a human verification handoff.

Verify in order:

1. Check that the browser service is active and its restart count is stable.
2. Read `http://127.0.0.1:<cdp-port>/json/version` from the agent host.
3. Call the dependent MCP from the affected channel and inspect its result.
   A reachable CDP endpoint alone does not prove that the site is available
   or that its session remains authenticated.

When an MCP executes `fetch()` inside a browser tab, select a tab on the exact
origin of its configured API. Choosing a `.com` page for a `.it` API can yield
a browser-side cross-origin failure (`http_status: -1`) even though CDP is
healthy. A subsequent HTTP `401` or `403` is a separate site authentication or
access result; it must not be reported as a browser connection failure.

If a protected login page presents an interactive challenge, inspect the
browser tab as well as the API response. The API may return an ordinary `401`
while the tab is visibly stopped at a Cloudflare verification. Report
`verification_required` separately from `login_required` so the agent can
request a person to finish the challenge in that same browser profile. A
loopback-only remote desktop reached through SSH can provide a temporary
handoff on a headless host. Remove that remote desktop and tunnel after the
verification, while leaving the managed browser and profile running. Do not
copy session or clearance cookies between machines or spoof browser and
hardware identity as a default recovery path.

## Friday, 2026-10-04

The Chrono24 MCP on Friday reported `connection refused` at its localhost CDP
endpoint. No browser process or supervisor was running. A dedicated Chromium
systemd service was installed with the existing agent-owned profile and
loopback CDP binding. The Chrono24 MCP's tab selection was changed to require
the configured base host. A Telegram `chrono24_status` call then reached the
browser and returned HTTP `403`. On 2026-10-04, the login tab was inspected
through an SSH-protected screen sharing session and displayed a Cloudflare
Turnstile checkbox. The collection API separately returned `401`. The custom
MCP now reports `state: verification_required` in `chrono24_status`, and its
collection/watch tools distinguish this from an expired login. The manual
checkbox attempt in the original profile returned to the same challenge.
Testing on the same host showed that Google Chrome Stable with a fresh,
separate profile displayed the login form, while Chrome Stable with a copy of
the old profile still displayed the challenge. Removing Chrono24 site data
from that disposable copy did not change the result. Friday now runs a second,
resource-limited Chrome service on loopback CDP port `18801` for this MCP; the
original browser and its other site sessions remain intact. A Telegram
`chrono24_status` call through Friday returned `state: login_required` and
`verification_required: false` on the new profile. When Friday submitted the
form directly from a clean profile, Chrono24 displayed a visible Cloudflare
"Conferma" checkbox over the login page. The widget was not exposed through
the page's ordinary iframe and input selectors, so the MCP initially misread
the page as `login_required`. It now detects the visible prompt, and a live
status check returns `state: verification_required`, `logged_in: false`. The
MCP also retries a transient CDP target replacement during navigation. The
Telegram collection read did not succeed; authentication and collection
access remain unverified until the site's interactive check is completed.
This is a host service and custom MCP repair, not a change to an OpenAgent
runtime package.

The follow-up diagnosis for beta 22 found that the model's assertion of a
"black Xvfb screenshot" was false. Friday's stored `computer_control_computer`
result and a direct MCP capture both show the browser and verification widget
on display `:101`; the running sidecar's `DISPLAY` and `XAUTHORITY` match the
Chrome service. Core and Claude sub proxy had been passing the image as text
instead of pixels. Do not restart or replace the display to address that
model-side interpretation error, and do not request exported session cookies.
See [beta 22](releases/v1.1.0-beta.22.md) for the model-visible repair.
