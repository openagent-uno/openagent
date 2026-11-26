# Standalone modular profile

The standalone server builds a signed, versioned `RuntimeProfile` from the
separately installed OpenAgent module wheels. The full profile enables tool
discovery, Sessions, federated Search, Vault, dynamic MCP management, Workflows,
Scheduler, Events, Delegation, Skills, Models, Budget, Attachments and Logs; PTC
is enabled only by product configuration.

Standalone authorization checks capability presence through the uniform
runtime catalog. It does not infer native module availability from the MCP
module's connection pool, so Sessions, Vault and other native capabilities are
visible whenever their registered surface is active.

The three automation domains contribute separate workers to the runtime graph.
They share one execution implementation, but activation and shutdown are
reference-counted by domain, so hot removal of Scheduler does not stop Workflow
or Event work. Product task seeding and UI broadcasts attach to that module-owned
worker instead of starting a second scheduler loop.

OpenAgent App and CLI register filesystem, editor, shell, computer-control
and agent-in-chrome capabilities for the authenticated device. The App also
registers dashboard tools on its own chat connection. An authorized
interactive turn can share its device grants with a synchronous child.
Verified private channel mappings can grant access to the same owner's
devices. A scheduled task can use a device explicitly lent by its approver
while that device stays connected.

The standalone full profile separately registers filesystem, editor and shell
for the server workspace. An operator may also enable the server's own
computer-control and agent-in-chrome sidecars with `server_host_tools`.
These durable capabilities operate on the agent host,
have distinct references from a connected client device, and are available to
channels and automation when enabled. Dashboard state stays in the server's
dashboard service.

The product system prompt is composed after mandatory kernel and active-module
blocks. Removing Vault removes its tools, hooks, reminders and prompt rules.
Removing tool-discovery removes its discovery and canonical-tool discipline.
The shipped full profile enables both, preserving the existing tool and memory
rules. Module packages and OpenAgent Tools remain independently versioned inputs
to the coordinated standalone release manifest.
