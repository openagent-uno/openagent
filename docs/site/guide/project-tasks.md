# Project tasks

Open **Projects** in a connected client, select an approved project and base revision, enter an instruction, then choose **Start task**. The server allocates a separate computer for each owner and task. Closing the client leaves an admitted run with the server. The Projects screen lists your tasks, including results from earlier connections to the same agent.

Open a task to see its current status and final response. **Review changes** shows the Git diff against the selected revision, including tracked deletions and new files. The client presents up to 128 KiB of the saved patch. A saved checkpoint remains available when the machine stops. After an interrupted preparation, **Resume preparation** uses the original request and allocation. If a run finished before a checkpoint was saved, **Save changes for review** checkpoints the current working tree and leaves the run result intact.

## Approving revisions

With `project_tasks` unset, the authenticated project catalog is empty and individual task requests return HTTP 404. The host loads the computer broker and initializes its project tables when `project_tasks` is configured.

Enable the standalone host's optional `project_tasks` setting in the agent configuration. A host operator prepares a private Lima home and a stopped base image containing the supported guest tools and the workspace commit at `/srv/workspace`. The process running OpenAgent must be able to run `limactl`. Set `lima_executable` to its absolute path if the service manager sets a different search path.

```yaml
project_tasks:
  lima_home: /var/lib/openagent/lima
  computer_pool:
    id: local-projects
    machines: 8
    machines_per_owner: 3
    running: 2
    running_per_owner: 1
    cpus: 4
    memory_bytes: 8589934592
    disk_bytes: 137438953472
  projects:
    - id: handbook
      title: Operations handbook
      tenant: example-network-id
      members: [alice, bob]
      revisions:
        - label: Approved edition
          commit: 0123456789abcdef0123456789abcdef01234567
          base: handbook-release
          surfaces: [terminal.read, terminal.input, preview.read, computer.suspend]
          preview:
            port: 18285
            path: /
```

The optional pool records machine reservations in the standalone database, accounts for each sealed guest’s CPU, memory and virtual disk, and enforces host and owner limits before cloning or starting a VM. Granting `computer.suspend` adds **Suspend computer** after the run finishes. Suspension frees running capacity and retains the workspace.

Use the registered network identifier and member handles. The client obtains the catalog through its authenticated connection. Reading a task, requesting changes, issuing input and publishing a result all depend on the current grant and the task's owner. To grant different surfaces, use separate project entries for disjoint member groups with the same sealed revision.

## Working on the assigned computer

**Open computer** lists the desktops available on the task's current guest. **Reconnect computer** reattaches the assignment and uses the provider's current generation. The browser viewer accepts input only for the selected target.

The terminal requires a guest that advertises the task-surface tools. `terminal.read` permits reattaching an existing shell and reading from an output cursor. Adding `terminal.input` permits opening a shell and sending input. The guest stores the terminal and its bounded transcript, so reopening the panel can recover output across client disconnects. When the guest reports that earlier output expired, the client marks the gap.

`preview.read` permits reading a configured guest-local HTTP service. The desktop client displays sanitized static HTML inside a sandbox and can display a PNG image. Native mobile clients can display a PNG. Use the task's browser viewer for an interactive page. Removing a revision grant fences further reads and input for that principal. The machine and checkpoint remain subject to the host's retention policy.

## Acceptance test

The Desktop test enrolls two synthetic accounts with separate device certificates over Iroh. Its local model edits a file by discovering the guest shell on the selected computer. Both clients verify the result, Git diff, terminal transcript and sandboxed preview. A one-running-VM budget forces the first user to suspend their guest before the second can start. The test also checks task, runtime, conversation and search endpoints with the other account and after the operator removes membership.

Use a dedicated 0700 Lima home and a sealed 1-vCPU, 1-GiB guest with a 4-GiB virtual disk, the prepared workspace commit, the guest shell, and the enrolled task surfaces. The guest preview endpoint must allow port 18285 and path `/`. Install the server's pinned Python dependencies and the desktop build dependencies, then run the following from `apps/app/desktop` with the test environment set.

```sh
export OPENAGENT_TEST_LIMA_HOME=/private/test/lima
export OPENAGENT_TEST_LIMA_BASE=prepared-task-base
export OPENAGENT_TEST_LIMA_COMMIT=0123456789abcdef0123456789abcdef01234567
export OPENAGENT_REAL_DESKTOP_PYTHON=/private/test/openagent/bin/python
export OPENAGENT_E2E_HOST_TOOLS_BIN=/private/test/openagent-host-tools
export OPENAGENT_DESKTOP_PROJECT_TASKS_E2E=1
npm run build:e2e
npx playwright test --config=playwright.config.mjs e2e/desktop-project-tasks.spec.mjs
```

For the published macOS arm64 app, set `OPENAGENT_E2E_PACKAGED_APP` to the extracted application bundle and `OPENAGENT_REAL_DESKTOP_PYTHON` to the installed standalone interpreter. The test opens both clients from the bundle and starts each renderer on its own local origin. The guest base must have the supported tool entry point installed and the declared Git revision checked out.

Keep the canonical database, host-policy markers, provider reservations, persistent guest disk and saved checkpoint together when backing up or restoring a project host. Install readers that enforce live host scope before attaching this database. A previous reader that predates the marker can expose a withdrawn task through its session APIs.
