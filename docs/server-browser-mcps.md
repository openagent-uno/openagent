# Server browser dependencies for custom MCPs

The standalone server does not lend an App or CLI device's `agent-in-chrome`
capability to Telegram, another channel, or a scheduled run. A separately
registered server MCP may depend on a browser running on the agent host. The
host must provision and supervise that browser explicitly; an enabled MCP row
does not start its external dependencies.

For a CDP-backed MCP, use a dedicated persistent profile owned by the agent's
operating-system account. Bind the debugging endpoint to `127.0.0.1`, keep its
port stable for the MCP configuration, and run the browser under a service
manager with automatic restart. On a headless Linux host, a virtual X server
can preserve the browser's normal rendering behavior. Keep the profile across
service restarts to retain cookies; do not delete or replace it as part of a
health repair. The browser service is a durable dependency, not a diagnostic
process to clean up after a test.

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
collection/watch tools distinguish this from an expired login. The person
using the account must complete the displayed challenge before authentication
and a full Telegram collection read can be verified. This is a host service
and custom MCP repair, not a change to an OpenAgent runtime package.
