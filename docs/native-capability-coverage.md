# Native capability coverage

This is the mapping from the general-purpose tools available in a Codex task to
OpenAgent's public capability catalog. It intentionally excludes third-party
connectors and specialist toolkits (ClickUp, Argent, React Native, etc.). Tool
names are not copied from Codex when OpenAgent already has a domain contract.

| General task | OpenAgent capability | Owner and scope |
| --- | --- | --- |
| Read/write/list/search files, inspect metadata and media | Filesystem tools, editor `grep`/`glob` | `openagent-tools`; App/CLI register on the verified device, standalone server may register for its workspace. |
| Apply a contextual text patch | Editor `apply_patch` | `openagent-tools` editor 1.1.0; one existing file per call, exact unified-diff context, authorized path roots. |
| Run a command, stream input/output, stop a job | `shell_exec`, `shell_input`, `shell_output`, `shell_kill`, `shell_list` | `openagent-tools` shell; background jobs remain scoped to their local principal. |
| Inspect OS processes | `shell_processes` | `openagent-tools` shell 1.1.0; PID and executable name only, with name/PID filters. No command line or environment values. |
| Inspect the screen and control desktop apps | `computer`, `computer_list_displays`, `computer_list_windows`, `computer_capture_window` | Device sidecar registered by App/CLI for the verified interactive turn. Exact display targeting enters device-tools `1.0.0b3`; installed App bundles remain on their published lock until rebuilt and signed. |
| Navigate/inspect browser tabs, page text, forms, console, network | `agent-in-chrome` | Device sidecar registered by App/CLI for the verified interactive turn. |
| Search the web and read a page | `full-web-search`, `get-web-search-summaries`, `get-single-web-page-content` | Independent `openagent-web-search-mcp`, installed and registered explicitly by the host; its browser runtime is provisioned separately. |
| Generate an image or video | `generate_image`, `generate_video` | Standalone `media-gen` capability using configured providers; provider availability determines whether calls succeed. |
| View an attached image | Attachments module / filesystem media read | Core module for turn attachments; filesystem capability for an authorized local path. |
| Discover/call tools, inspect results | Tool Discovery and the unified `ToolRef` dispatcher | Optional Core module; all sources use the same authorization and result envelope. |
| Python pipelines over authorized tools | PTC `run_python` | Optional Core module with host-supplied isolated executor. |
| Sessions and exact run state | Sessions module: list/search/read/create/rename/archive/restore plus `runs_get`, `runs_events`, `runs_children`, `runs_wait`, `runs_cancel` | Core `openagent-module-sessions` `1.1.0b2`; host authorization applies to every target. |
| Synchronous child delegation, scheduling, workflows, logs and memory | Delegation/Scheduler/Workflow/Logs/Vault modules | Core services and host APIs. Existing `delegate_task` waits for its child; team mode can fan out parallel calls within a turn. |

The `apply_patch` and `shell_processes` rows describe the upcoming independent
editor/shell `1.0.0b2` and host-tools `1.0.0b2` source. The currently pinned
App/CLI bundles and server dependency remain `1.0.0b1` until signed platform
bundles and the release index have been produced and their consumer locks
updated. Do not claim these two tools are present in an installed older bundle.

The same release boundary applies to the new computer display/window tools and run
controls. `openagent-device-tools` `1.0.0b3`, `openagent-host-tools` `1.0.0b4`,
and `openagent-module-sessions` `1.1.0b2` are source candidates. The desktop
resource lock still identifies its previously signed host-tools bundle; source
changes alone do not add tools to an installed desktop application.

Codex task/sidebar/worktree/usage-reset/confetti controls are controls of the
Codex application, not general agent tools. OpenAgent's sessions, delegation,
scheduler, workflow and host APIs cover only the explicitly listed concepts.
The Codex collaboration surface also includes asynchronous agent spawn,
follow-up tasks, agent-to-agent messages, interruption, listing and waiting.
OpenAgent now has exact-run observation, bounded waiting across worker processes
and cancellation, but does **not** yet expose detached spawn or follow-up to a live child as an agent
tool. Direct agent-to-agent messaging across arbitrary existing sessions is
**not** inferred from a task ID: it needs an explicit host-authorized recipient,
delegation and publication policy. Device tools are never promoted to durable
tools for a channel, workflow or scheduled task.

Computer control remains another material gap. The native sidecar supports
mouse, keyboard, screenshots, recording, display and window inventory,
exact-display pointer/screenshot targeting, and window capture;
it does not expose an accessibility element tree, element-targeted actions,
application lifecycle control, an element wait, or selection among existing
browser/app surfaces. The dedicated Agent-in-Chrome sidecar covers page trees
and tab interaction within its own browser profile, not all operating-system
windows. Display IDs must come from the verified client sidecar's inventory;
the ID, name and bounds are revalidated on each action. Real multi-monitor behavior still needs live
qualification beyond coordinate-mapping tests.

| Collaboration operation | Current OpenAgent behavior | Remaining contract |
| --- | --- | --- |
| Spawn a child and continue immediately | `delegate_task` creates a durable child but waits for its answer; team mode can issue parallel calls in one turn. | A public async child admission API with a durable run ID, a host-approved delegation and no retained client lease. |
| Read/list children and wait | Sessions tools now expose `runs_get`, `runs_children`, `runs_events` and bounded `runs_wait`. | Multi-agent presence/status beyond persisted runs needs a host-defined scope and lifecycle. |
| Interrupt a child | `runs_cancel` targets an exact run ID and reports whether cancellation is terminal. | Follow-up of a live child must define steering semantics and avoid duplicating external effects. |
| Send a follow-up or message to another agent | A person may add a turn to a shared session through authenticated ingress. | Agent-originated cross-session delivery needs recipient authorization, authorship, audience, idempotency and a durable delivery receipt. |

These contracts belong in Core and its optional Sessions/Delegation modules.
GlassPalace, Replio and standalone OpenAgent decide who may invoke them. The
computer UI tree and app lifecycle belong to client-registered device
capabilities; installing those packages must not add them to Telegram or a
GlassPalace sandbox.

The generic web-search package currently covers search and page text, not the
whole Codex `web.run` surface (finance, weather, sport, clocks, image search and
PDF page screenshots). Image editing is also not yet exposed by `media-gen`.
These are separate optional capability packages or provider features, not
reasons to enlarge the Core import or copy Codex-only APIs. A product must
register any such source deliberately, name its destination, and pass current
authorization through the same catalog. This document is a coverage inventory,
not a claim that an optional source is installed on every deployment.
