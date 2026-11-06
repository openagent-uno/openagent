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
openagent-task-run --config /task/openagent.yaml --message-file /task/message.txt \
  --setup-file /task/setup.json --output result.json --timeout 1800
```

The result is the `ask --json` object (`status`, `text`, `model`,
`attachments`, `session_id`) plus `exit_code` and `duration_seconds`. Setup
failures report only paths, status codes and gateway errors.

## Input handoff

The runner **consumes** its inputs. Before `openagent serve` starts it reads
`--config`, `--setup-file` and `--message-file` into memory and unlinks them;
the setup batch and the message reach `openagent-cli` on stdin
(`--batch-file -`, `--message-file -`), never through a file or argv. When the
agent turn begins, nothing the agent runs can find those files. If an input
cannot be removed (for example a read-only Secret volume), the run fails with
exit code 10 before the server starts: no agent turn ever sees a credential
that is still on disk. Inputs must be regular files: removing a symbolic link
(which is how a Secret volume presents its keys) would leave the target behind.
`--keep-inputs` disables the removal; use it only for inputs that hold no
secrets.

Put the inputs in a private, writable, memory-backed directory. On Kubernetes,
a Secret volume cannot be emptied, so copy it with an init container and never
mount it in the runner container:

```yaml
spec:
  automountServiceAccountToken: false
  securityContext: {runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, runAsNonRoot: true}
  volumes:
    - {name: task-secret, secret: {secretName: <per-run-secret>, defaultMode: 0440}}
    - {name: task, emptyDir: {medium: Memory, sizeLimit: 1Mi}}
    - {name: work, emptyDir: {}}
  initContainers:
    - name: inputs
      image: <registry>/openagent-task-runner:<tag>
      command: ["/bin/sh", "-c", "umask 077 && cp /secret/* /task/"]
      volumeMounts:
        - {name: task-secret, mountPath: /secret, readOnly: true}
        - {name: task, mountPath: /task}
  containers:
    - name: runner
      image: <registry>/openagent-task-runner:<tag>
      args: ["--config", "/task/openagent.yaml", "--setup-file", "/task/setup.json",
             "--message-file", "/task/message.txt", "--output", "/work/result.json"]
      env: [{name: TMPDIR, value: /work}]
      volumeMounts:
        - {name: task, mountPath: /task}
        - {name: work, mountPath: /work}
```

Keep credentials out of the container environment as well: environment
variables of the runner and of every process it starts are readable by the
same account through `/proc`.

### What remains readable during the turn

Consuming the inputs removes the copies the caller handed over. It does not
put a security boundary between the agent's host tools and the server: the
host tools (`shell`, `filesystem`, `editor`, the browser and computer-control
sidecars) run as the same account as `openagent serve`, in the agent
directory. That account can read what the server keeps to do its work: the
agent configuration (including `server_host_tools.browser.proxy`), the agent
database (provider API keys set through setup), the runner's client login, and
the environment of the browser sidecar, which carries the proxy URL. Treat
every credential a run uses as reachable by an agent that has the `shell`,
`filesystem` or `editor` host tool, and choose accordingly:

- disable those tools (`server_host_tools.tools`) for tasks that do not need
  them; Agent in Chrome alone cannot open local files (`file:` URLs are
  refused by `navigate` from device tools 1.0.0b16 and blocked by Chromium for
  pages, and the image adds
  a `URLBlocklist` policy as a backstop);
- give each run scoped, short-lived, spend-limited credentials, revoked when
  the Job ends, and restrict egress to the hosts the task needs.

## Container image

`Dockerfile` installs a published release through its pinned `install.sh`,
Debian Chromium with Xvfb (Agent in Chrome renders headful into a virtual
display when no `DISPLAY` is set) and the qualified Linux x64 computer-control
bundle. Build for `linux/amd64` with `OPENAGENT_RELEASE` and the installer's
SHA-256. Run as UID 10001 with a writable `TMPDIR` (for example an `emptyDir`).
Chromium carries a managed `URLBlocklist` policy for `file://*`, so no page,
tool or extension in the image's browser loads a local file.

## Interactive browser sessions

The image also ships `openagent-browser-session` (device tools ≥ 1.0.0b12): run it
as the container command, instead of `openagent-task-run`, to open the profile's
browser with an authenticated live view so a person can sign in once through the
caller's UI. See the Agent in Chrome README for the live-view protocol.

## Browser state and site access

A disposable agent directory gives each task a fresh browser profile. To keep
a site login between tasks, point `server_host_tools.browser.profile_dir` at
storage owned by the caller and give it one writer at a time; a person signs in
once inside that dedicated profile; set `server_host_tools.browser.exclusive_profile:
true` when the caller guarantees that single writer, so a lock left by a crashed
host does not block the profile. Route page traffic with
`server_host_tools.browser.proxy` (a Chrome `--proxy-server` value, passed to
the sidecar as `OPENAGENT_CHROME_PROXY`) when a task must leave through a
specific network.
Sites may still require interactive verification: the runner never automates
CAPTCHAs or disguises the browser (see the Agent in Chrome README).
