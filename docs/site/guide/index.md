# Documentation

OpenAgent is a persistent AI agent framework. You run an **Agent Server** on a machine you control, then talk to it from the **Desktop App** or **CLI** — all pointing at the same agent, sharing the same memory and tools.

It's model-agnostic: Claude, GLM, Ollama, LM Studio, vLLM, or any OpenAI-compatible provider. Swap the model without losing memory or tool state. Run multiple independent agents side-by-side, each in its own folder.

## Start here

- [Getting Started](./getting-started.md) — download, install, first run
- [Configuration reference](./config-reference.md)

## Core concepts

- [Invitation System & Networking](./invitation-system.md) — Iroh P2P transport, coordinator, device certs, invite tickets
- [Models](./models.md) — pick a provider
- [MCP tools](./mcp.md) — filesystem, editor, browser, web search, and more
- [Gateway](./gateway.md) — WebSocket + REST surface over Iroh QUIC
- [Channels](./channels.md) — Telegram, Discord, WhatsApp, Webhook
- [Events](./events.md) — inbound webhook triggers for workflows, tasks, and chats
- [Memory & vault](./memory.md) — the markdown-based Obsidian vault
- [Scheduler & Dream Mode](./scheduler.md) — recurring tasks and background work

## Clients & operations

- [Desktop App](./desktop-app.md)
- [Architecture](./architecture.md) — component map and system flow
- [Deployment](./deployment.md)

## Examples

- [Example `openagent.yaml`](/examples/openagent-yaml)
- [Example `workspace-mcp.service`](/examples/workspace-mcp-service)
