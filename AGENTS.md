# OpenAgent product workspace

Start with `docs/README.md` and `docs/site/vision.md`. Keep documentation and
component receipts updated with implementation changes.

This repository assembles the standalone OpenAgent product. Reusable engine
code belongs in the independently versioned `openagent-core` dependency;
autonomous computer tools belong in `openagent-tools`. Never add a core fork,
package overlay, or source mutation during installation.

Use `python3.11 scripts/workspace.py list` for component paths. Component
commands run from the component directory; imported `.github` workflows are
historical reference until explicitly ported into the root `.github` directory.

Preserve installed application IDs, protocol schemes, identity keys, agent
directories and device consent. Release compatibility is a verified bridge,
not a silent change of updater URLs. No production cutover before the tests
and backup/restore gates in the architecture plan pass.
