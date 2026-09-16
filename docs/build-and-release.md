# Build and release contracts

Use Python 3.11 or newer. All commands resolve paths relative to the workspace,
so they also work when launched from another directory.

```sh
python3.11 scripts/workspace.py list
python3.11 scripts/workspace.py verify-history
python3.11 scripts/workspace.py run cli -- python -m pytest
python3.11 scripts/workspace.py wheel mcp-bridge --output dist/wheels
python3.11 scripts/workspace.py release-manifest --artifacts dist/artifacts --output dist/release-manifest.json
```

The wheel command builds the selected component with `pip wheel --no-deps`.
Runtime dependencies are resolved by the consuming product's locked build;
they are not silently fetched as unpinned source checkouts. Packaging a wheel
does not claim a runnable, signed desktop release.

`packaging/workspace.json` preserves public distribution and command names,
artifact prefixes, legacy update repositories, app ID, URL scheme and user
paths. Imported component release workflows remain under their original
subtrees as reference. Only explicitly ported root workflows execute in the
monorepo.

The generated release manifest records the exact product commit, individual
component versions, SHA-256 and size of every supplied artifact, source
history and compatibility flags. It rejects symbolic links and ambiguous or
unknown artifact ownership. The caller must supply separate protocol,
storage and signing evidence in a qualification receipt before publishing a
coordinated `v1.0.0-beta.N` release. A development manifest is not a signature
or a qualification claim.

Never change production update endpoints solely because source moved.
Publish a separately qualified transition release in each old repository,
preserving historical assets and immutable tags. Verify the entire installed
version → transition → new distribution → next update chain before retiring
old development. User identity keys, application IDs and consent files retain
their existing paths throughout.
