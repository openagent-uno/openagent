# OpenAgent

The standalone OpenAgent product: desktop app, CLI, server and MCP bridge.
The product consumes independently versioned OpenAgent Core and OpenAgent
Tools packages. Independent host applications consume the same libraries
through their public contracts and own their own deployments.

Start with [the documentation index](docs/README.md). Repository paths and
build entry points are listed by `python3.11 scripts/workspace.py list`.
The public guide and verified downloads are at
[openagent.uno](https://openagent.uno/); new coordinated product releases are
published only from this repository.

The beta56 Python source consumes independently released Core beta27 and channel
bridges beta7, including authoritative final replies and bounded historical
channel media. Its wheel qualification is recorded separately from native apps,
frozen servers and live provider acceptance. Existing updater endpoints stay
in place until every supported platform completes its signed transition chain.

## Official connectors

The standalone server integrates the shared OpenAgent Tools connector runner through managed Core capability sources. See [connector guide](docs/site/guide/connectors.md). Release server builds require an extracted `OPENAGENT_CONNECTORS_BUNDLE`; the manifest target/version and binary checksum are verified by the frozen build. Development can set `connectors.runner_path` or `OPENAGENT_CONNECTOR_RUNNER`. Credentials, identities and privacy inboxes remain in the server data directory. Common app enrollment stays gated until provider review and real product acceptance.

Acquire the pinned runner and wheel before provisioning the release environment (the connector wheel is a GitHub release asset):

```sh
python3 apps/server/scripts/acquire-connectors.py --platform darwin-arm64 --output build/connectors --wheelhouse build/wheelhouse
python3 -m pip install --find-links build/wheelhouse 'openagent-connectors==0.1.0'
export OPENAGENT_CONNECTORS_BUNDLE="$PWD/build/connectors"
```

Use `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64` or `win32-x64` for the matching target. `apps/server/connectors.lock.json` pins archive, wheel and source checksums; `--assets` allows the same checks against an offline release directory. Acquisition never installs or runs downloaded software.

New common-app consents are disabled unless the server explicitly lists providers in `connectors.official_providers` or `OPENAGENT_CONNECTOR_AUTH_PROVIDERS`. Own-app files enable their configured providers. Existing credentials continue to work independently of this enrollment setting. Shopify enrollment in the standalone is additionally disabled until privacy export/redaction of stored agent content is implemented.
