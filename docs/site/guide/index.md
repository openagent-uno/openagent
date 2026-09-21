# Documentation

OpenAgent is both an embeddable modular agent runtime and a complete standalone
product. The standalone **Server**, **Desktop App** and **CLI** share sessions
and whichever optional modules the product profile enables. Other products can
import Core and supply their own identity, storage, tools and infrastructure.

It's model-agnostic: Claude, GLM, Ollama, LM Studio, vLLM, or any OpenAI-compatible provider. Swap the model without losing memory or tool state. Run multiple independent agents side-by-side, each in its own folder.

## Start here

- [Downloads](../downloads.md) — current canonical release artifacts
- [Getting Started](./getting-started.md) — install, first run and embedding
- [Configuration reference](./config-reference.md)

## Core concepts

- [Invitation System & Networking](./invitation-system.md) — Iroh P2P transport, coordinator, device certs, invite tickets
- [Models](./models.md) — pick a provider
- [MCP and capabilities](./mcp.md) — uniform tools, catalog modes and client sources
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
