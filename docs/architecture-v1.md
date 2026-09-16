# OpenAgent v1 architecture and migration

The approved target has three independently versioned repositories:

| Repository | Owns |
| --- | --- |
| `openagent-core` | Runtime, public contracts and SDKs, framework instructions, reusable modules, persistence, optional gateway and capability host |
| `openagent-tools` | Standalone filesystem, editor, shell, web search and native computer/browser tools |
| `openagent` | App, CLI, server, MCP bridge, identity, dashboards, product configuration, optional integrations and distribution |

GlassPalace imports a pinned Core package into its own Python worker. Its Go
control plane owns authentication, authorization, delivery, computers and
Kubernetes infrastructure. A Core update does not require a standalone
OpenAgent release. Replio is another possible consumer with its own identity
and a fixed catalog.

## Runtime and capabilities

Core receives explicit settings, services and modules. Construction has no
listener, user creation, MCP installation or model download side effects.
Runtime resources and credentials belong to an instance, never to a global
active-agent directory. Core sees abstract principals; each host establishes
the authenticated execution context and authorizes actions and result
audiences.

One uniform catalog binds opaque tool references to exact sources, executors
and generations. App and CLI advertise device capabilities only for their
authenticated originating turn. App injects dashboard capabilities itself;
keeping the persistent dashboard service in the server does not advertise
those tools to Telegram, another client, or a scheduled task. Disconnect and
revocation invalidate further calls, without selecting another computer.

Every actual agent run uses the same mandatory framework and enabled-module
instructions. Product persona and configurable system prompts add to them.
Vault recall, successful-save accounting, reminders, quality checks, linked
notes, provenance, Git versions and dream child sessions migrate together.
Dynamic MCP documentation never becomes an authoritative framework block.

## History and data

Seven repositories have been imported with their complete ancestry and
non-squash subtree merges. Original source repositories and worktrees were
left unchanged. Legacy tags have component namespaces; exact source commits
are recorded in `packaging/source-history.json`. The old image repository's
large binaries are retained as LFS pointers and are historical inputs, not
new release artifacts.

Migration initially preserves physical databases, operational IDs, authors,
ancestry, model pins, credentials, dashboard definitions and user paths.
Before an installed agent is cut over: stop admissions, drain or cancel the
exact run, stop the old writer, acquire a consistent backup including WAL,
files and keys, migrate and verify, start one writer, reconcile requests and
cursors, then reopen ingress. After new writes, rollback requires a verified
reverse migration or coordinated restoration; changing a binary digest alone
is insufficient.

## Current status

The repository-history import and workspace/release tooling are implemented.
Server composition, identity, dashboards, support and product prompts have
been relocated into product packages; engine source has been removed from
this repository. The host-tools compatibility package delegates to the
independent tool packages. CLI identity and transport implementations now
share product packages instead of generated copies. Product wheels build.
Standalone runtime/gateway admission and native release qualification remain
in progress; package builds do not establish end-to-end readiness. The v1
runtime, product and client integration gates must pass before this document
can state that the migration is complete. No production repository, release
asset, installed application or persistent agent directory has been changed
by this import.

Release qualification includes installed-wheel tests outside source trees,
two isolated runtimes, multiuser and multidevice attribution, channel
capability isolation, managed catalog enforcement, durable run retries and
cancellation, prompt/vault parity, provider and automation compatibility,
real authenticated client E2E and backup restoration. Deterministic tests and
real-provider/platform evidence must be reported separately.
