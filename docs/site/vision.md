# OpenAgent

*An agnostic AI agent system that runs as a self-hosted server, communicates with users and other agents over a peer-to-peer network, and treats every input — text, audio, video, files, images — as a single unified stream.*

---

This document is OpenAgent's vision. It describes what the system is meant to be, not necessarily what any particular release contains. When the implementation and this document diverge, this document is the source of truth and the implementation is what needs to change.

Both human developers and the agent itself are expected to read this document and orient themselves by it. Design choices, code contributions, feature proposals, and the agent's own self-understanding all derive from the principles and capabilities described below.

---

## 1. Identity

OpenAgent is an agnostic AI agent system. It is agnostic of model, provider, framework, channel, and host: any reasoning engine can drive it, any platform can speak to it, any machine can run it.

OpenAgent is server-shaped. A single long-running process owns the agent's memory, sessions, scheduled work, capabilities, and identity. Clients — the desktop app, the CLI, third-party integrations — are thin attachment points that connect to this server and surface it on a screen, in a terminal, or inside another platform.

Every user runs their own OpenAgent. Each agent has its own identity, its own memory vault, its own configured set of models and capabilities, and its own history. Agents discover one another and communicate directly, peer-to-peer, without any central authority mediating between them.

## 2. The Stream Model

All input flows through one unified stream abstraction. Text typed in a chat, audio captured from a microphone, frames from a webcam, files dropped into a conversation, images pasted from a clipboard — every form of input travels the same way and is interpreted by the same pipeline.

Users can send fast bursts of input without losing coherence. A rapid sequence of short messages, optionally interleaved with file attachments, is coalesced into a single turn so the agent reasons over the user's complete intent rather than fragmenting its response. Ordering is preserved; nothing is dropped.

Voice and video are streams in the same sense. A live microphone or webcam feed produces a continuous bidirectional stream, supporting real-time conversation with the agent — comparable to a video call. The agent can speak while the user is still listening and stop mid-sentence when the user begins to speak again; interrupt and barge-in are first-class behaviors, not afterthoughts.

The same stream backs every channel. Whether a message arrives from the native client, the command-line interface, Telegram, Discord, WhatsApp, Slack, or a future integration, it enters the stream at the same point and is handled by the same logic. A message is a message regardless of where it came from.

When a conversation approaches a model's context limit, the session compacts in place. The agent rewrites earlier turns into a summary, preserves the salient details, and continues without forcing the user to restart. Sessions are durable; conversations are long.

## 3. Models and Providers

Any LLM provider can be added to OpenAgent. Hosted APIs (Anthropic, OpenAI, Google, Mistral, anything else), framework-driven runtimes that wrap a subscription product or a third-party agent CLI, local models running on the host machine, and any future provider that a developer chooses to wire up all coexist within the same agent.

The set of available models lives in the agent's database as the source of truth. Configuration files describe how to bring the agent up; they do not enumerate models. Models are added, enabled, disabled, and reconfigured at runtime through the agent's own management surfaces.

Each model is registered with a **scope** — a natural-language description of what it is good at. Scopes are not categories from a fixed taxonomy; they are sentences. "Best for long-context reasoning on large codebases." "Cheap and fast classifier suitable for routing decisions." "Vision-capable for screenshots and diagrams." "Local model, free to run, suitable for sensitive content that should not leave the host." The agent reads scopes and reasons about them like any other text.

::: tip Shipped as `tier_hint`
Scopes exist today under a different name. A model's scope is the free-form `tier_hint` column on its `models` row: `_build_role_blurb` (`src/models/dispatcher.py`) turns it into the natural-language role the team leader reads when routing a turn, and each specialist receives it as a `── Role ──` block appended to its system prompt. Set it via `model-manager`, `PUT /api/models`, or the Models screen. The concept is implemented; only the name diverges from this document.
:::

One model is the **entry model** — the router. By default the router is the first model enabled; it can be explicitly pinned. Every user turn arrives at the router first.

The router decides how each turn is handled. It may answer directly, or it may delegate parts of the work to other registered models whose scopes match the task at hand. Delegation produces sub-agents that run in parallel or in sequence. The router gathers their outputs and synthesizes the final response.

## 4. Sub-Agents

A sub-agent is a scoped execution of another registered model, invoked by the router to handle part of the current turn. It is not a separate identity and not a separate process — but it *is* a separate, durable piece of state: every sub-agent runs as its own **child session**.

A child session is a real session, linked to the parent it was spawned from. It shares the parent's world — the same memory vault, the same MCP pool, the same access to the files and images on the turn — and it runs with the full framework prompt and user persona, exactly like a turn the user typed. What it does *not* share is the parent's transcript: the child owns its own message history, seeded by the task the parent handed it. The only thing that varies between the router and a sub-agent is the model performing the reasoning.

Because a sub-agent is a full session, it is first-class everywhere sessions are. It appears in the session list tagged with its origin, it is navigable — the parent transcript shows each delegation as a card that opens the child session — and it can be continued: a user can drop into a sub-agent's session and send it a follow-up message. The same is true at any depth; a sub-agent that delegates further spawns child sessions of its own, and the lineage is explicit. Sub-agents may run in parallel when the work is independent and in sequence when one step feeds the next, scaling to hundreds of concurrent child sessions; the router decides the shape and synthesizes their results.

Delegation is still cheap — a child session is a spawn, not a setup, and inherits the parent's capabilities wholesale — but it is no longer ephemeral. Decomposition leaves a durable, inspectable trail rather than vanishing into a single turn.

Sub-agents are preferred over workflows for one-off decomposition. When a task naturally splits into "this part is best for model A, this part for model B," the router decomposes and delegates instead of scripting a multi-step chain. Workflows are for repeatable structure; sub-agents are for intelligent decomposition of a single turn.

## 5. Memory Vault

The agent's long-term memory is a graph-shaped wiki. Notes are atomic: one fact, one decision, one observation, one preference per note. Notes have human-readable names and are connected to each other through wiki-links (`[[name]]`).

The vault is queryable as a graph and renders like Obsidian. Backlinks, graph view, tags, full-text search, and the usual affordances of a personal knowledge base are all available. Memory is not a hidden vector store and not an opaque database — it is human-inspectable Markdown that the user can read, edit, and reorganize directly.

That constraint is about the **store**, not the **index**. What the agent *knows* lives in the Markdown, and nothing else is authoritative. But retrieval — how the agent *finds* the right note — may be accelerated by a derived index: a full-text index, or an embedding index for semantic recall so that "the ship date we agreed" finds the note titled "launch deadline." Such an index is a **rebuildable cache** over the Markdown, never a second source of truth: delete it and the next sync reconstructs it, and the agent forgets nothing. The prohibition is on memory that lives *only* in vectors, unreadable and unowned — not on using vectors to search memory that lives, in full, as files the user can open. An embedding index is opt-in and provider-agnostic (a local model suffices), consistent with §17.

The agent maintains the vault automatically as it learns. New facts produce new notes. Related notes are cross-linked the moment a connection is recognized. Contradictions between an existing note and a new observation are flagged and reconciled rather than silently overwritten. The vault grows in the same shape regardless of which model wrote the entry.

Before acting on any non-trivial question, the agent consults the vault. After any meaningful learning, the agent writes to the vault. This is the agent's discipline, not an optional behavior.

## 6. MCPs (Capabilities)

The agent's capabilities beyond reasoning — file editing, shell execution, web search, browser control, calendar access, anything that touches the world — are delivered through MCPs (Model Context Protocol servers).

A small set of MCPs is built in and always available. These include shell and bash execution, web search, file editing, browser/agent-in-Chrome control, and a handful of internal management surfaces (vault, scheduler, workflow manager, MCP manager, model manager, tool search). The built-in set is the floor of what an OpenAgent can do.

Users can register custom MCPs at any time, by command, URL, or marketplace pick. The agent re-discovers tools on the next turn and uses them as soon as they appear; no restart is required. Removing an MCP cleanly removes its tools.

A marketplace exposes vetted MCPs for easy discovery and installation. The marketplace is part of the OpenAgent experience, not an external add-on. Adding capabilities to an OpenAgent never requires modifying its source code.

MCPs are loaded into model context lazily. Tool schemas are deferred by default — the agent does not pay token cost for capabilities it is not currently using. A single discovery MCP, **tool-search**, is always injected; it is the agent's index into every other MCP available to it, both built-in and user-registered. When the agent needs a capability, it queries tool-search to load the relevant tool schemas on demand. The framework system prompt may include brief notes about a handful of high-traffic built-in tools to shortcut the most common discoveries, but the schemas themselves are still pulled through tool-search at the moment they are used.

## 7. Scheduled Tasks

Any prompt can be scheduled. A scheduled task is a full agent run on a cron expression, with the same capabilities as a live chat turn — the same memory vault, the same MCPs, the same sub-agent delegation, the same access to files and images.

Tasks are first-class objects. They can be created by the user from any channel, by the agent on its own initiative when it notices recurring work, or by other agents through federation. They are stored durably and survive restarts. A task can also be fired on demand — by the user from any client, or by the agent through its own tools — running immediately and out of band from its cron schedule, without disturbing the schedule or requiring the task to be enabled; an on-demand firing is recorded in the same run history as a scheduled one. A firing that is already in flight, however it was triggered, can be stopped the same way: the run is hard-stopped and recorded, while the schedule itself is left intact.

A scheduled task is not a degraded version of chat. It is chat with the user's seat empty. The agent fires the prompt, reasons over it with the full system around it, and writes any results back to the vault, the logs, or the user — exactly as it would for a turn the user typed in person.

## 8. Workflows

Workflows compose multi-step actions explicitly. A workflow is a directed graph of blocks: triggers, conditionals, loops, parallel fan-out, MCP invocations, AI prompts, error branches. Workflows execute deterministically, retry on configured errors, and produce a run history that can be replayed and audited.

Workflows exist for repeatable routine tasks that benefit from explicit structure. When a process must run the same way every time, must be inspectable step by step, or must coordinate work between multiple systems with strict ordering, a workflow is the right shape.

When the agent authors a workflow for itself, it prefers a small workflow that delegates to sub-agents over a large workflow that hand-codes every step. Workflows are scaffolding; intelligence stays in the models. A workflow that calls a single AI block with a clear prompt and lets sub-agents do the work is healthier than a sprawling chain of micro-decisions.

Workflows can be triggered manually, on a schedule, by other workflows, or by the agent's own reasoning when it decides a routine has emerged.

## 8.5 Events

An **event** is a first-class inbound trigger. Scheduled tasks fire when the clock says so; workflows run when the agent says so, in a fixed shape; events fire when the *world* says so — an external service or a peer reaches in and the agent does bound work.

An event is a durable object: a name, an inbound "type" (the shape of the caller — a generic webhook, a specific provider), a description of the payload it expects, a credential that authenticates the caller, and a binding to what should happen. The binding is one of three things the rest of the system already knows how to run: an existing workflow, an existing scheduled task, or a fresh chat session seeded with a prompt. The delivered payload flows into whichever it is — as workflow inputs, as task context, or templated into the prompt. Prompt events may optionally bind a payload field, such as an external ticket or thread id, to the event-run session: the external value is only a lookup key, while OpenAgent stores and resumes its own internal session id. With that flag disabled, every delivery creates a new event-run session.

Events are reachable two ways, both authenticated. From outside, an HTTP webhook the agent exposes (§9) lets any service call in with the event's own secret. From inside, a member or a federated peer can fire an event over the peer-to-peer network with their device identity — no shared secret, consistent with §11. However it was triggered, a firing is a durable, inspectable delivery, and the run it produces surfaces in history exactly like every other execution (§16): a chat-prompt event owns a real session shown from the event run screen, while workflow and task events link their runs. The payload is untrusted input — it is contained as data, never obeyed as instructions.

Events are first-class everywhere the other automation objects are. A user creates them from any client; the agent creates, edits, and fires them through its own tools, proposing one when it notices a "when X happens elsewhere, do Y" pattern (§15). Removing the webhook channel, or any single provider, leaves the rest of the event system working with what remains (§17).

## 9. Channels

OpenAgent is reachable from many surfaces. The native desktop and command-line clients, Telegram, Discord, WhatsApp, Slack, and any future integration all expose the same agent.

Channels are stateless adapters. They translate platform-specific events into the unified stream and translate outbound responses back into platform-native form. A Telegram message becomes a text input on the stream; a Discord voice note becomes audio input on the stream. Outbound text becomes a chat message in the appropriate platform; outbound audio becomes a voice reply.

Most channels are outbound — the agent dials out to a platform. One channel is inbound: the **webhook**. It exposes an authenticated HTTP endpoint that an external service, or a peer agent, can call to reach *in* and start work. It is a doorway like any other — one more way the world speaks to the one agent — but it carries no conversation of its own; what it triggers is an event (§8.5).

The agent's identity, memory, sessions, and history do not depend on the channel. A conversation can begin on the desktop client, continue in Telegram, and resume in the CLI, and the agent is the same agent throughout. There is no "Telegram-agent" or "WhatsApp-agent" — there is one agent with many doorways.

A channel may carry a personality overlay — a tone preset such as casual, technical, terse, or playful — that adjusts how the agent expresses itself in that surface without changing what it knows or how it reasons.

## 10. The Gateway

A single gateway exposes the agent to the outside world. WebSocket connections carry live streams in and out; REST endpoints handle management actions such as configuring models, registering MCPs, listing sessions, editing the vault, and inspecting logs.

First-party clients and third-party clients use the same gateway with the same authentication. There is no privileged internal API parallel to a reduced external API; the contract is the same for everyone.

The gateway is the only public surface of the agent. Everything else — the model dispatcher, the MCP pool, the scheduler, the workflow executor, the vault, the logs — is internal and never spoken to directly. This keeps the security boundary, the schema, and the permission model in one place.

## 11. Network, Identity, and Federation

Users and agents authenticate over the Iroh peer-to-peer network. There is no central server, no public IP requirement, no port forwarding, no DNS dependency. A self-hosted OpenAgent on a laptop behind NAT is reachable from anywhere with an Iroh ticket.

Users are members of an agent's network. Membership is cryptographic: a device holds a certificate signed by the agent acting as coordinator, and the certificate proves the device's identity at the transport layer before any application-level traffic flows. A user can have multiple devices on the same network; the identity is stable across them.

Agents can connect to other agents. Federation uses the same Iroh substrate: peer-to-peer, cryptographically authenticated, no central authority. Agents on different networks can exchange messages, collaborate on tasks, and share context with explicit permission from their owners. A federated agent appears to its peers as something like a colleague — a named, reachable other.

An agent may act as a coordinator for its own network, issuing certificates to its users' devices and to other agents it invites. This role is part of the agent itself, not a separate service.

## 12. Dream Mode

The agent runs a scheduled "dream" task that maintains its memory vault. Dreaming consolidates duplicate notes into single canonical ones, strengthens wiki-links between related notes, prunes stale or contradictory entries, and writes a dream-log that records what was reorganized and why.

Dream mode is toggleable but not removable. A user may choose when it runs and how aggressively it operates, but cannot disable it permanently. An agent without dreaming degrades over time as its memory accumulates noise, redundancy, and broken cross-references; dreaming is the system's antidote to that decay.

Dream mode runs while the agent is otherwise idle — nightly by default, at a time the user can adjust. It does not compete with user-facing work, and any in-flight tasks take priority.

## 13. Auto-Update

The agent checks for new releases at `github.com/openagent-uno/openagent-server` and installs them automatically. Updates are platform-aware (macOS package, Linux tarball, Windows archive), checksum-verified during download, and rollback-safe — a failed install does not leave the agent broken.

Auto-update is configurable but on by default. The user can change the check interval, pin to a specific release, or pause updates during sensitive work. An agent that cannot update itself is a dead branch.

## 14. Unified Logging

Every event the agent produces writes to a single structured log. User turns, model calls, MCP invocations, sub-agent delegations, scheduled-task fires, workflow steps, federation messages, errors, and lifecycle events all share the same log stream and the same event schema.

The log is queryable in three directions. Developers read it to debug. Other agents read it over federation to observe shared work. The agent itself reads it as a tool to diagnose its own behavior — answering questions like "what went wrong yesterday?", "why did this scheduled task fail?", or "which MCP call is slowing me down?" by consulting the log directly.

The log is local by default. Aggregation, remote forwarding, and retention policies are user-configurable, but the default is that an agent's operational history stays with the agent.

## 15. Built-in System Prompt

A framework system prompt is injected into every conversation. It describes OpenAgent to the agent itself: the vault, the MCPs, the sub-agent model, the scheduler, the workflow engine, the network, the logs — every lever the agent can pull.

This prompt is non-removable. A user-defined persona prompt — declared in the agent's YAML configuration — is layered on top of it, shaping the agent's voice and character; the framework prompt underneath establishes the agent's awareness of its own system. The user defines who the agent is; the framework defines what the agent has.

The same two-layer prompt — framework underneath, user persona on top — is loaded into every AI execution within OpenAgent, not just live chat turns. Sub-agents at any depth of delegation (team leaders and team members alike), AI blocks fired inside a workflow, and scheduled tasks all run with the same framework prompt, the same user persona, and the same deferred-MCP setup: tool-search injected, every other capability discoverable through it. There is no reduced or alternate baseline for non-interactive execution paths — the agent is the same agent wherever it runs. Each of these runs is a child session in the sense of §4 — a delegated team member, a workflow AI block, a scheduled firing each get their own durable, navigable session — and the prompt that seeds it is recorded as an agent-authored message, distinct from a message a human sent, so the trail shows not just what was said but who said it.

An OpenAgent agent knows what it is and what it can do. When asked a question, it does not guess at its own capabilities. When given a task, it does not improvise around its tools — it knows them, reaches for them deliberately, and surfaces them to the user when relevant.

The agent is expected to be proactive. It surfaces patterns it notices — recurring work that could be scheduled, manual loops that could be workflows, gaps in the vault that should be filled — and proposes automations rather than waiting to be asked. This proactivity is part of what the framework prompt establishes.

## 16. Sessions and Continuity

Every conversation is a session. Sessions are stored durably with full fidelity: every message in both directions, every file sent or received, every MCP tool call, every sub-agent delegation, every model output, every reasoning step that was made visible. Every message carries its author — which human (by network identity, so a session shared between several people attributes each message correctly) or, for a seed prompt the agent gave itself, the agent. A session is not an anonymous "user vs. assistant" stream; it records who said what.

Sessions can be resumed at any time from any channel. Resuming restores not just the text history but the attachments and the tool history that produced it; an agent picking up a week-old conversation has the same view of it as the user does.

The session abstraction is transparent to users and developers. Conversations are long-lived objects, not ephemeral chat windows. Closing a client does not close a session; opening a new client does not lose one.

## 17. Self-Hosted by Design

OpenAgent is built to be self-hosted. Individuals run it on their own laptops; small teams run it on a shared server; organizations run it on private infrastructure. None of these configurations are second-class.

The system does not depend on any single vendor's cloud, model, or protocol. Removing any single provider — any LLM API, any MCP, any channel — must leave the agent operational with what remains. This rules out architectures in which a particular cloud service is structurally required.

Peer-to-peer networking, local memory, and local logging together mean that an OpenAgent instance can run fully offline — modulo the specific models the user has chosen to wire up — and still be itself. An agent configured with only local models, local MCPs, and local channels is a complete OpenAgent.

## 18. Principles for Contributors and Agents

The sections above describe what OpenAgent does. The principles below describe how to think when designing within it. They apply equally to human contributors writing code and to the agent itself making decisions in its own loop.

- **Streams over messages.** Inputs flow continuously; design for streams, not discrete requests.
- **Sub-agents over workflows.** Delegate to a model when the decision is intelligent; script a workflow only when the decision is routine.
- **Atomic notes over monolithic context.** A vault of small linked notes outperforms a single large file every time.
- **Scopes over hardcoded routing.** A model's role is a sentence the router reads, not a switch statement in code.
- **Peer-to-peer over central servers.** Reach for direct connections; treat any required central authority as a bug.
- **Markdown over opaque stores.** Anything a user might want to read should be in a format they can read.
- **Self-extension over hardcoding.** New capabilities arrive as MCPs and registered models, not as patches to the core.
- **The agent's awareness of itself is a feature, not metadata.** The system prompt, the logs, and the vault exist so the agent can reason about its own operation; treat that visibility as load-bearing.
