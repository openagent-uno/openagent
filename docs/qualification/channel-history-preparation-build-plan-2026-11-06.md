# Channel bridge beta19: bounded remote wheel plan

Status: **prepared, not executed**. This is a component-only build plan, not a
native bundle, deployment or provider acceptance receipt. Beta18 public bytes
remain immutable. The beta19 tag was absent from the canonical remote on
6 November 2026 when this plan was prepared.

## Inputs and ownership

- Canonical repository: `https://github.com/openagent-uno/openagent.git`.
- Root reviews and merges the source candidate normally before assigning the
  exact forty-character public commit to `SOURCE_COMMIT`.
- Use an existing explicitly owned Linux x64 executor. Do not provision a
  machine, dispatch paid CI, restart application services or inspect runtime
  credentials. A flat-rate existing executor adds no compute subscription.
- The executor receives only the public commit identifier and this reviewed
  build operator. It obtains source over public HTTPS. No account token,
  deployment configuration, application data or private repository is an input.
- Canonical component entry point:
  `python3 scripts/workspace.py wheel channel-bridges --output "$JOB/out"`.
  This retains the normal `uv build` clean-snapshot builder and its source/hash
  manifest. Do not create a wheel by hand or reuse beta18 wheel metadata.

## Resource admission and hard bounds

Use a new owned directory on the executor's physical scratch filesystem, outside
application and backup paths. Verify Python 3.11+, Git, curl, tar, systemd and
x86_64; verify sufficient disk before writing. The directory must be absent
before creation and empty except for the operator/tool cache at launch.

Before launch require at least 30% physical RAM and scratch disk remaining after
the complete reservation: **128 MiB RAM and 512 MiB disk**. Abort rather than
relax either floor. A prior read-only observation does not replace this fresh
admission check.

The single transient systemd service runs as an unprivileged user with:

```text
MemoryMax=128M
MemoryHigh=96M
MemorySwapMax=0
CPUQuota=50%
TasksMax=32
RuntimeMaxSec=300
TimeoutStopSec=15
KillMode=control-group
OOMPolicy=kill
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateDevices=true
PrivateTmp=true
ReadWritePaths=<only the new owned JOB directory>
```

Use one build/download worker (`UV_CONCURRENT_BUILDS=1`,
`UV_CONCURRENT_DOWNLOADS=1`), a job-local uv/cache/home/tmp directory,
`UV_HTTP_TIMEOUT=30` and no inherited Git configuration or credential helper.
Network and disk errors, timeout or OOM stop this attempt without automatic
retry or raising limits. Preserve the resulting log/partial artifacts for
review; never delete application data to make the build fit.

## Canonical source and build sequence

1. Fetch the public Linux GNU uv **0.11.14** archive into the owned job directory:
   `https://github.com/astral-sh/uv/releases/download/0.11.14/uv-x86_64-unknown-linux-gnu.tar.gz`.
   Its official release asset digest, read from the provider API, is
   `f3b623eb0e6141a7053d571d59a0bdc341e0f238ea8f5f0b4815ddbec9a2a296`
   (24,035,336 bytes). Enforce both before extraction and use only that job-local
   executable. Do not install or change the executor's system tooling.
2. Set `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`,
   `GIT_TERMINAL_PROMPT=0` and an empty credential helper. Initialize a new
   repository, enable cone sparse checkout and shallow-fetch the exact reviewed
   `SOURCE_COMMIT` from public HTTPS using `--depth=1 --filter=blob:none`.
   The selected paths are `scripts`, `packaging` and `packages/channel-bridges`.
   Checkout detached, confirm `HEAD == SOURCE_COMMIT` and require clean status.
3. Confirm both `pyproject.toml` and the public module version are `0.1.0b19`.
   Run the canonical wheel command with a new empty `JOB/out` directory.
4. Require one wheel named
   `openagent_channel_bridges-0.1.0b19-py3-none-any.whl` and `manifest.json`.
   The manifest must identify the exact public commit, `dirty_snapshot: false`,
   exactly one component/version and matching size/SHA-256. Verify every shipped
   package source and metadata entry against the clean selected tree; reject
   symlinks, extra distributions and private payloads.
5. Retain the transient service's exit status, log, peak memory/CPU counters,
   canonical manifest and artifact hashes. Retrieve these small public outputs
   without retrieving executor credentials or application files.

This plan does not claim the 128 MiB limit has been qualified. A bounded failed
attempt is a result to review, not permission to retry with more resources.

## Qualification and publication boundaries

The beta19 candidate source suite has **363 tests and 86 subtests passing with
zero skips** on the declared Core/SQLite beta42 minimum, using Python 3.11.6.
It performs no real provider requests. See the
[source receipt](channel-history-preparation-source-2026-11-06.json).

After the remote wheel exists, qualify the exact normally installed wheel, not a
source overlay. Publication is a separate reviewed operation: create the unused
`channel-bridges-v0.1.0-beta.19` prerelease at the reviewed source commit with
the exact wheel, manifest, qualification and checksums. Independently fetch the
anonymous public bytes and compare all sizes/digests before a consumer pins it.
No App/native rebuild, SDK conversion or provider configuration change is part
of this wheel plan. Live Discord provider testing is not part of this scope.
