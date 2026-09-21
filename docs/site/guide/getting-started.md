# Getting Started

OpenAgent can be used as the complete standalone product or embedded as a
library. The current public product build is **v1.1.0-beta.2**; see the
[downloads page](../downloads) for its qualification status and available
platforms.

## Desktop app

<ReleaseDownloads target="desktop" />

Install the `.dmg`, launch OpenAgent, and connect it to an existing standalone
server. The current beta desktop artifact supports Apple Silicon macOS. The app
registers dashboard and local-computer capabilities only for its authenticated
device turns; Telegram, scheduled work and other clients do not inherit them.

## Standalone server and CLI

<ReleaseDownloads target="server" />

<ReleaseDownloads target="cli" />

The beta server and CLI are Python 3.11+ wheels. Their dependencies span the
three independently versioned repositories, so download one verified
wheelhouse before installing either component:

```bash
# Standalone server
curl -fsSL https://openagent.uno/install.sh | sh

# CLI
curl -fsSL https://openagent.uno/install.sh | sh -s -- --cli

# Download and verify every first-party wheel without installing
curl -fsSL https://openagent.uno/install.sh | sh -s -- --check
```

The installer pins the three release tags below, checks every first-party wheel
against its published manifest, creates an isolated virtual environment and
refuses to overwrite an unrelated command. The equivalent manual procedure is:

```bash
mkdir openagent-1.1-beta && cd openagent-1.1-beta

gh release download v1.1.0-beta.2 \
  --repo openagent-uno/openagent --pattern '*.whl'
gh release download v1.1.0-beta.1 \
  --repo openagent-uno/openagent-core --pattern '*.whl'
gh release download v1.0.0-beta.1 \
  --repo openagent-uno/openagent-tools --pattern '*.whl'

python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --pre --find-links . \
  openagent-framework==1.1.0b2 openagent-cli==1.1.0b2
```

The release manifests publish the expected SHA-256 for every first-party wheel:

- [product manifest](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.2/product-release-manifest.json)
- [Core manifest](https://github.com/openagent-uno/openagent-core/releases/download/v1.1.0-beta.1/manifest.json)
- [Tools manifest](https://github.com/openagent-uno/openagent-tools/releases/download/v1.0.0-beta.1/manifest.json)

Start a standalone agent from any folder:

```bash
.venv/bin/openagent serve ./my-agent
```

The folder contains the product configuration, SQLite state, vault and logs.
On first run the standalone identity package bootstraps the configured network
and prints an invite ticket. Connect the CLI with that verified ticket:

```bash
.venv/bin/openagent-cli connect oa1abc123...
```

## Embed Core in another product

Products install only the Core packages and modules they select. The host owns
authentication, authorization, credentials, infrastructure and deployment:

```python
profile = RuntimeProfile(modules={
    "sessions": ModuleConfig(surfaces={"service", "agent_tools", "host_api"}),
    "vault": ModuleConfig(surfaces={"service", "agent_tools"}),
    "mcp": ModuleConfig(
        surfaces={"service", "host_api"},
        options={"catalog_mode": "managed"},
    ),
})

runtime = Runtime(settings=settings, services=services, profile=profile)
await runtime.start()
```

GlassPalace follows this model: it builds its own worker image from pinned
packages and owns its pods, sandbox, volumes and identity adapters. It does not
download or patch the standalone OpenAgent repository at runtime.

## Next steps

- [Understand the modular architecture](./architecture)
- [Configure the standalone product](./config-reference)
- [Choose models](./models)
- [Configure MCP mode](./mcp)
- [Connect a channel](./channels)
