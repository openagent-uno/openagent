# App dashboard capabilities

OpenAgent App explicitly registers its dashboard tools on its authenticated
chat WebSocket using `app_capability_register`. The server acknowledges the
registration with that exact socket's opaque `connection_id`. The registration
is separate from consent to operate the user's computer and works when the
App has no local capability host or client instance.

The normal typed-chat path uses the collaboration HTTP API. The App waits for
registration acknowledgement and includes `app_connection_id` with each new
turn. The server resolves it only against a live socket belonging to the same
verified device and authorization epoch; a JSON connection reference never
supplies identity. Voice/stream turns carry their already verified ingress.
CLI, channel and generic REST clients do not register the App source.

The source is registered in `Runtime.capabilities` with a temporary lease.
Every discovery and invocation rechecks the exact originating connection,
authentication epoch, initiating principal and current result audience. A
private dashboard is not published into a shared conversation by inheritance.
Revocation/disconnection removes the source and invalidates previous handles.
Deferred work cannot retain its lease. A source survives successive messages
on one connection without treating a changing request ID as a new device.

The persistent dashboard service remains in `openagent-dashboards`. Its tools
use the same repository and migrations as the product REST/UI. Creating an
inline view or inserting its marker requires the current authorized session;
rendering the marker rechecks current publication rights and the exact immutable
view revision. The core receives this validation through `EngineExtensions`.

Verification: `tests/test_dashboard_capabilities.py` exercises actual temporary
SQLite/filesystem dashboard persistence, App operation without computer consent,
CLI/channel/deferred isolation, another principal/device, revocation, exact HTTP
connection binding and inline-reference publication. The App protocol test
bundles and executes the real WebSocket and collaboration clients, covering the
explicit offer and the acknowledgement-before-HTTP ordering. Web export and
TypeScript checks are separate from real authenticated UI/device qualification.

The installed device acceptance suite (`tests/verify_installed_device.py`) checks
package resolution, copies its fixtures outside the repository, and drives real
Iroh/PAKE enrollment for two accounts. Their exact device origins execute the
independent shell, editor and filesystem tools in separate temporary workspaces.
It verifies six persisted effects, rejects cross-user destination selection,
rechecks consent after discovery, rejects stale references after revocation and
disconnection, and proves that ingress without a client origin sees none of the
connected devices' tools. The model endpoint is a deterministic local HTTP fixture
using the actual agent/tool loop. This is transport/runtime acceptance; live
Telegram, Electron GUI, OS computer-control gestures, signing and updater
qualification remain separate checks.
