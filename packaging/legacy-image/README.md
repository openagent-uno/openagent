# Historical machine-image assets

This directory retains imported binary/network assets for source provenance. It
is not a supported image build context. The retired build recipe, supervisor
template and vendored subscription proxy were removed on 19 November 2026;
their original bytes remain in Git history (`legacy/image/` refs and the
source import recorded in `packaging/source-history.json`). Retained binaries
are historical artifacts, not the current runtime or an updater destination.

Use a verified canonical standalone release and its installer for current
servers and clients. The supported ephemeral image is built from
[`apps/server/deploy/task-runner`](../../apps/server/deploy/task-runner/README.md).
Subscription protocol implementations and the optional explicit shared-custody
HTTP host belong to the public `openagent-core[subscription-host]` package;
see the [Core subscription contract](https://github.com/openagent-uno/openagent-core/blob/main/docs/subscriptions.md).

An installed historical machine needs a deliberate operator migration. Drain its
writers and preserve identities, grants, agent data, network policy and updater
configuration. Removing these obsolete source recipes does not modify any
installed machine or authorize deleting its data.
