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
| Inspect the screen and control desktop apps | `computer-control` | Device sidecar registered by App/CLI for the verified interactive turn. |
| Navigate/inspect browser tabs, page text, forms, console, network | `agent-in-chrome` | Device sidecar registered by App/CLI for the verified interactive turn. |
| Search the web and read a page | `full-web-search`, `get-web-search-summaries`, `get-single-web-page-content` | Independent `openagent-web-search-mcp`, installed and registered explicitly by the host; its browser runtime is provisioned separately. |
| Generate an image or video | `generate_image`, `generate_video` | Standalone `media-gen` capability using configured providers; provider availability determines whether calls succeed. |
| View an attached image | Attachments module / filesystem media read | Core module for turn attachments; filesystem capability for an authorized local path. |
| Discover/call tools, inspect results | Tool Discovery and the unified `ToolRef` dispatcher | Optional Core module; all sources use the same authorization and result envelope. |
| Python pipelines over authorized tools | PTC `run_python` | Optional Core module with host-supplied isolated executor. |
| Sessions, children, scheduling, workflows, logs, memory | Sessions/Delegation/Scheduler/Workflow/Logs/Vault modules | Core services and host APIs, with the host's identity and authorization. |

The `apply_patch` and `shell_processes` rows describe the upcoming independent
editor/shell `1.0.0b2` and host-tools `1.0.0b2` source. The currently pinned
App/CLI bundles and server dependency remain `1.0.0b1` until signed platform
bundles and the release index have been produced and their consumer locks
updated. Do not claim these two tools are present in an installed older bundle.

Codex task/sidebar/worktree/usage-reset/confetti controls are controls of the
Codex application, not general agent tools. OpenAgent's sessions, delegation,
scheduler, workflow and host APIs provide the corresponding product concepts
where applicable. Direct agent-to-agent messaging across arbitrary existing
sessions is **not** inferred from a task ID: it needs an explicit host-authorized
recipient and publication policy. Device tools are never promoted to durable
tools for a channel, workflow or scheduled task.

The generic web-search package currently covers search and page text, not the
whole Codex `web.run` surface (finance, weather, sport, clocks, image search and
PDF page screenshots). Image editing is also not yet exposed by `media-gen`.
These are separate optional capability packages or provider features, not
reasons to enlarge the Core import or copy Codex-only APIs. A product must
register any such source deliberately, name its destination, and pass current
authorization through the same catalog. This document is a coverage inventory,
not a claim that an optional source is installed on every deployment.
