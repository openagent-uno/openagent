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
- **Chat** — ChatGPT-style interface with multi-session support, real-time status updates.
  Long transcripts scroll infinitely in both directions: the view renders a bounded
  window (at most 160 rows) and pages canonical history by message id as the reader
  nears either edge, keeping the reading position fixed. A rail of dots on the left
  marks every human prompt of the session (primary for your own, text colour for other
  participants); hovering previews the prompt and clicking jumps to it, loading the
  surrounding page when needed. Auto-scroll detaches only on a real upward gesture
  (wheel, drag, keyboard, scrollbar), never on programmatic layout corrections.
- **Recent sidebar** — sessions, workflow, scheduled and event runs that are actively
  working show the same shine sweep as a running tool card.
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

## Keep sessions running

In **Settings → Controls**, **Keep computer awake during active sessions** is
on by default in the desktop app. It prevents idle system sleep while visible
or background work is running on connected agents. The display may turn off,
and screen locking is unchanged. Disable the option to follow ordinary system
sleep preferences. It does not keep an explicitly quit app running.

On macOS 13 or later, **Continue with lid closed** is a separate opt-in. macOS
must approve the bundled OpenAgent power service in System Settings → General →
Login Items & Extensions. The app requests registration only when you enable
this setting. Until approved, ordinary idle-sleep protection still works but
closed-lid operation is unavailable. Revoke the service in macOS settings when
needed; switching the option off releases its power override immediately.

The closed-lid service temporarily disables system sleep while work is active.
It restores the preceding setting when work ends, on disconnect or app exit,
and after a lost client lease (at most 47 seconds). It also releases its own
override at critical thermal pressure or 5% battery while unplugged. An existing
global sleep override remains unchanged: OpenAgent cannot restore ordinary sleep
if it was already disabled by another application or administrator. Avoid changing
the same global sleep flag from another utility while OpenAgent owns an override.

Activity belongs to the desktop main process, so changing agent, opening another
window or navigating away from Chat does not stop protection. Active accounts
retain their transport until work ends; explicit logout releases the background
hold without disconnecting sibling windows. A failed observation preserves the
last known running state until activity can be verified again or you disconnect.

Current servers expose the stateless, authenticated `GET /api/history/active`
boolean probe. It checks canonical run state against the viewer's current session
permissions and creates no history pagination snapshots. Older servers fall back
to a bounded recent-session list and local renderer activity; remote work outside
that legacy list cannot be discovered reliably. Upgrade the server for complete
background activity detection.

The feature's [qualification receipt](../../qualification/desktop-power-2026-11-12.json)
distinguishes source tests from signed-service and physical closed-lid validation.
A source change does not update an already installed app.

## Architecture

The standalone monorepo keeps the App sources together:

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

## Provider connectors and the MCP marketplace

The candidate connector release combines provider integrations and registry
MCP cards in **Connectors → Browse**, using the same responsive card/grid and
the official provider logos. It adds no dedicated Official tab,
badge or separator. Setup and local enable/reconnect/disconnect controls open
from the card; custom MCP registration remains available.

Read [the usage guide](./connectors.md), [configuration/recovery](./connector-operations.md)
and [release status](./connector-status.md) before assuming this candidate UI is
present in a currently installed public build. OAuth availability is decided by
the authenticated receiving server and provider configuration.
