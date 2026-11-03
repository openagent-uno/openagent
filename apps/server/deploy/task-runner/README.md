# Ephemeral task runner

`openagent-task-run` executes **one** task with the complete standalone OpenAgent
and exits. Use it when an orchestrator needs agent runs on demand — one job,
container or VM per task, scaled to zero when idle — instead of a long-lived
server. It composes only public commands:

1. `openagent serve` in a new, empty agent directory (full module profile:
   sessions, delegation/sub-agents, scheduler, vault, MCP, and the opted-in
   `server_host_tools`, including `agent-in-chrome` and `computer-control`).
2. `openagent invite --first-user --ticket-only`: the host-created first-user
   invitation, which makes the runner account the agent owner.
3. `openagent-cli connect <ticket> --no-interactive` with a random password.
4. `openagent-cli request --batch-file <setup>` (optional): providers, models,
   MCP servers or other settings through the normal authenticated REST API.
   `${N.key}` reuses a value from response `N`.
5. `openagent-cli ask --message-file <task> --json`: one turn, same session and
   tool behavior as an interactive chat.
6. The server and every child process (MCP servers, browser) are stopped.

```sh
openagent-task-run --config openagent.yaml --message-file task.txt \
  --setup-file setup.json --output result.json --timeout 1800
```

The result is the `ask --json` object (`status`, `text`, `model`,
`attachments`, `session_id`) plus `exit_code` and `duration_seconds`. Setup
failures report only paths, status codes and gateway errors. Keep provider
keys out of argv and logs: write the setup file with mode 0600 from a secret.

## Container image

`Dockerfile` installs a published release through its pinned `install.sh`,
Debian Chromium with Xvfb (Agent in Chrome renders headful into a virtual
display when no `DISPLAY` is set) and the qualified Linux x64 computer-control
bundle. Build for `linux/amd64` with `OPENAGENT_RELEASE` and the installer's
SHA-256. Run as UID 10001 with a writable `TMPDIR` (for example an `emptyDir`).

## Interactive browser sessions

The image also ships `openagent-browser-session` (device tools ≥ 1.0.0b12): run it
as the container command, instead of `openagent-task-run`, to open the profile's
browser with an authenticated live view so a person can sign in once through the
caller's UI. See the Agent in Chrome README for the live-view protocol.

## Browser state and site access

A disposable agent directory gives each task a fresh browser profile. To keep
a site login between tasks, point `server_host_tools.browser.profile_dir` at
storage owned by the caller and give it one writer at a time; a person signs in
once inside that dedicated profile. Route page traffic with
`server_host_tools.browser.proxy` (a Chrome `--proxy-server` value, passed to
the sidecar as `OPENAGENT_CHROME_PROXY`) when a task must leave through a
specific network.
Sites may still require interactive verification: the runner never automates
CAPTCHAs or disguises the browser (see the Agent in Chrome README).
