# OpenAgent product workspace

Start with `docs/README.md` and `docs/site/vision.md`. Keep documentation and
component receipts updated with implementation changes.

For UI, capability and data-service design, also read
`docs/site/guide/application-composition.md`. Preserve multi-account/source
composition, typed extensible views/actions and independent durable state/sync
boundaries. Its reference applications are acceptance cases, not features to
implement without a separate request.

This repository assembles the standalone OpenAgent product. Reusable engine
code belongs in the independently versioned `openagent-core` dependency;
autonomous computer tools belong in `openagent-tools`. Never add a core fork,
package overlay, or source mutation during installation.

Use `python3.11 scripts/workspace.py list` for component paths. Component
commands run from the component directory; imported `.github` workflows are
historical reference until explicitly ported into the root `.github` directory.

Preserve installed application IDs, protocol schemes, identity keys, agent
directories and device consent. The owner explicitly chose manual migration from retired updater URLs on
2 November 2026; follow `docs/release-consolidation.md` and qualify the new builds. No production cutover before the tests
and backup/restore gates in the architecture plan pass.

## Upstream ownership

Read `docs/PROJECT.md`. All agent features and fixes, including tools, channels,
runners and capabilities, belong in the owning OpenAgent component, even when
its architecture needs correction. Consumers inherit public versioned contracts;
no product-local patches, overrides, embedded forks or copied agent behavior.

## Agnostic software — mandatory

Read `docs/AGNOSTICISM.md`, `docs/COMPONENTS.md` and `docs/USAGE.md`.
OpenAgent must contain no references to embedding projects/external consuming
clients and no consumer-specific feature, fix, default, prompt or identity branch.
Use neutral fixtures and public generic contracts. Correct architecture upstream
when needed; consumers inherit versioned capabilities without local patches.
Domain data, branding, authorization and deployment adapters stay outside OpenAgent.
This applies to every OpenAgent repository and its maintained docs/examples/tests.
