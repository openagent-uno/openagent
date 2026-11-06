<!-- Installation names and paths are anonymized operator labels; original deployment records are retained in the protected audit. -->
# Server browser dependencies for custom MCPs

The standalone host can grant personal device tools to a verified private
channel turn through its explicit identity/device-owner policy; see
[Client Capabilities](site/guide/client-capabilities.md). These exact device
sources are distinct from the agent's own `server_host_tools.tools`. A missing
client destination must never be substituted with the server desktop.

## Full desktop rather than a browser-only display

A screenshot/stream captures the complete display. Xvfb plus Chromium alone
contains no window manager: there are no managed window decorations, taskbar or
application switcher to capture. Provision an X11 window manager and panel (for
example `openbox` and `tint2`) in the **same** display, Xauthority and mount
namespace as the supervised browser. Preserve its profile and display; attaching
a shell does not require restarting Chromium or signing in again.

`apps/server/scripts/attach-desktop-shell.py --browser-service=<owned.service>`
attaches Openbox and tint2 to the exact service's existing browser display. Run
as the browser's OS user. It follows only descendants of that unit's current
MainPID, inherits only DISPLAY/XAUTHORITY, refuses an existing window manager,
and stops its own children on shutdown. Install `openbox`, `tint2`, `xprop` and
`xsetroot` through the host package manager first. A companion systemd service
should use `After=`, `BindsTo=` and `PartOf=` for the browser unit, share its
`PrivateTmp` via `JoinsNamespaceOf=`, and be wanted by that browser unit. Verify
`_NET_SUPPORTING_WM_CHECK`, a visible panel, window controls and actual pointer/
keyboard interaction through the authenticated App desktop view. This is
optional host infrastructure, not a Core requirement: clientless/headless agents
without desktop tools remain valid.

When several supervised browsers/displays coexist, first compare the native
computer tool's effective `DISPLAY`/Xauthority with the browser unit being
selected. Attaching a shell to another healthy browser's display will not add
window controls to the computer the App is actually showing. Follow the exact
matching unit; verify its PID/profile remain unchanged when attaching the shell.

For a persistent remote computer, supervise the X server and shell independently
of browser windows. For example, run `xvfb-run --server-num=<fixed number>
--auth-file=<private persistent file> --server-args="-screen 0 1280x920x24 -noreset"
python3 attach-desktop-shell.py --existing-display` as the desktop service.
Keep X11 TCP disabled (the `xvfb-run` default), the authority file private to the
OS user, and its display number stable. Browser/tool services consume that exact
DISPLAY/XAUTHORITY and join the desktop's mount namespace when PrivateTmp is
enabled. With `Type=notify`/`NotifyAccess=all`, the helper signals readiness only
after its window manager is running; dependent browsers then start with their
window decorations in place. The desktop must not depend on a browser unit: closing its last window
must leave the desktop and taskbar usable. A browser exit can end its CDP tools
until reopened; it must not terminate the computer or agent service.

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

## Memory pressure and browser child failures

Check kernel OOM records together with the service's `Result`, `OOMPolicy`,
`MemoryCurrent`, `MemoryPeak` and restart history. A killed browser child and a
killed agent process are different failures. Under `OOMPolicy=stop`, even an
ancillary browser OOM can stop the complete agent unit and interrupt every chat.
Keep the dated raw incident evidence in the operator's private audit storage.

For a host whose browser/tool failures are independently supervised, the supported
`service.systemd` configuration can explicitly select `OOMPolicy: continue`.
Retain appropriate machine-specific memory limits and the agent's restart policy.
This keeps a child OOM from requesting a whole-unit stop; it does not guarantee
that the kernel will spare the main process or replace resource lifecycle fixes.
Apply through the existing service-manager configuration and verify the effective
unit setting. Preserve all agent identities, state, browser profiles and rollback
artifacts.

The independent [web-search browser resource repair](https://github.com/openagent-uno/openagent-tools/blob/main/docs/web-search-browser-resources.md)
is published as `web-search-v1.0.0-beta.3`. Install its verified archive into a new
owned prefix and select its executable with `OPENAGENT_WEB_SEARCH_MCP_COMMAND`;
do not patch installed JavaScript. It coalesces concurrent browser launches,
limits extraction contexts, closes contexts after errors and waits for batch
cleanup. Qualify the installed archive with real browser failures and concurrent
extractions, then test the host's authenticated runtime/tool path separately.
The [2 November installed qualification](qualification/standalone-browser-recovery-2026-11-02.json)
records stable server 1.1.2, browser resource tests, preserved state and a real
model/tool turn under the Telegram bridge identity. It does not claim a new
external Telegram message round trip or a deliberately repeated global OOM.

## Dogfood installation, 2026-10-04

The Chrono24 MCP on Dogfood installation reported `connection refused` at its localhost CDP
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
from that disposable copy did not change the result. Dogfood installation now runs a second,
resource-limited Chrome service on loopback CDP port `18801` for this MCP; the
original browser and its other site sessions remain intact. A Telegram
`chrono24_status` call through Dogfood installation returned `state: login_required` and
`verification_required: false` on the new profile. When Dogfood installation submitted the
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
"black Xvfb screenshot" was false. Dogfood installation's stored `computer_control_computer`
result and a direct MCP capture both show the browser and verification widget
on display `:101`; the running sidecar's `DISPLAY` and `XAUTHORITY` match the
Chrome service. Core and Claude sub proxy had been passing the image as text
instead of pixels. Do not restart or replace the display to address that
model-side interpretation error, and do not request exported session cookies.
See [beta 22](releases/v1.1.0-beta.22.md) for the model-visible repair.
