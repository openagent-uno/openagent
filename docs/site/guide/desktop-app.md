# Desktop App

OpenAgent ships an Electron desktop app that connects to any OpenAgent instance via the public gateway. It is an independent client application: it does not bundle the Agent Server, and it expects a running OpenAgent runtime to connect to. The app also registers dashboard, filesystem, editor, shell, computer-control and agent-in-chrome capabilities for its authenticated device context. Other channels and durable automation do not inherit them.

Download published builds from the canonical [OpenAgent release](../downloads.md).

## Quick Start

```bash
cd apps/app
./setup.sh              # install dependencies (universal + desktop)
./start.sh macos        # start Electron in dev mode
```

## Screens

- **Login** — connect to local (`localhost:8765`) or remote OpenAgent via host/port/token
- **Chat** — ChatGPT-style interface with multi-session support, real-time status updates
- **Vault** *(coming soon)* — Obsidian-style graph view + markdown editor
- **Config** *(coming soon)* — visual editor for openagent.yaml, MCP management

## Building

```bash
./build.sh macos        # → app/desktop/release/*.dmg
./build.sh windows      # → app/desktop/release/*.exe
./build.sh linux        # → app/desktop/release/*.AppImage
./build.sh web          # → app/universal/dist/ (static web)
```

## Auto-Update

The desktop app uses `electron-updater` with GitHub Releases. New coordinated
product releases are published from
[`openagent`](https://github.com/openagent-uno/openagent/releases). Historical
`openagent-app` endpoints remain available only for the verified updater
transition; they are not the source repository for new development.

## Architecture

Following the Mixout-Client monorepo pattern:

```
apps/app/
├── universal/          # Shared React Native + Web codebase
│   ├── app/            #   Expo Router screens (Login, Chat, ...)
│   ├── stores/         #   Zustand state (connection, chat, vault)
│   └── services/       #   WebSocket client, REST API, storage
├── desktop/            # Electron wrapper
│   └── src/            #   main.ts + auto-updater, preload.ts, services/
└── common/             # Shared TypeScript types (WS protocol, API)
```

## Shell Scripts

| Script | Purpose |
|--------|---------|
| `./setup.sh` | Install deps (universal + desktop) |
| `./start.sh web\|macos\|windows\|linux\|ios\|android` | Dev server |
| `./build.sh web\|macos\|windows\|linux\|ios\|android` | Production build |
| `./test.sh` | Lint + type check + unit tests |
