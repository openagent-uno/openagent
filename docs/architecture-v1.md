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

Version 1.1 selects optional behavior through one descriptor/surface contract;
see [the standalone profile](modules-v1.1.md). Manager tools are the
`agent_tools` surface of their domain module rather than a privileged layer.

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

The repository-history import, workspace/release tooling and modular v1.1
runtime are implemented and published as beta releases.
Server composition, identity, dashboards, support and product prompts have
been relocated into product packages; engine source has been removed from
this repository. The host-tools compatibility package delegates to the
independent tool packages. CLI identity and transport implementations now
share product packages instead of generated copies. Product wheels build.
The native gateway now admits turns through one Runtime and canonical run
ledger, binds certificate identities and current result audiences, and exposes
App dashboard/device sources only in their exact originating context. Managed
MCP catalogs and automation definition changes use shared public services;
definition changes and durable grants commit atomically. The standalone product
and GlassPalace integration use public package boundaries without source
overlays. Product `v1.1.0-beta.4`, Core `v1.1.0-beta.1` and Tools
`v1.0.0-beta.1` are public. Native cross-platform updater qualification remains
in progress; the current product manifest is therefore
`development-unqualified` and advertises only the exact artifacts it contains.

Release qualification includes installed-wheel tests outside source trees,
two isolated runtimes, multiuser and multidevice attribution, channel
capability isolation, managed catalog enforcement, durable run retries and
cancellation, prompt/vault parity, provider and automation compatibility,
real authenticated client E2E and backup restoration. Deterministic tests and
real-provider/platform evidence are reported separately. After owner acceptance
of the public site and canonical downloads on 21 September 2026, the historical
source repositories were archived without deleting their tags, release assets
or updater endpoints. The full installed-client transition chain remains an
explicit release-qualification gate for the current beta.
