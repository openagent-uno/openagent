# Official connector pane source qualification

This isolated harness loads the actual connector pane with React 19 and mocked React Native primitives, authenticated transport and connection-store state. It checks four asynchronous state regressions (management-action serialization, permission-cache invalidation, A → B → A target changes, and stopped OAuth polling) and the approved/rejected own-app authorization origins. It also transpiles the actual pane and API client for TypeScript syntax diagnostics.

Run on a disposable remote worker. It starts no app, model or server and makes no provider requests. It is source-unit evidence, **not** a complete TypeScript typecheck, native/visual acceptance or real OAuth qualification. Dependencies belong to a separate worker directory; the product dependency set is unchanged.

```sh
# Set these to an existing source checkout and an owned temporary worker directory.
SOURCE_ROOT=/path/to/openagent
QA_DEPS=/path/to/disposable-worker-dependencies
npm install --prefix "$QA_DEPS" --ignore-scripts --no-audit --no-fund --save-exact \
  typescript@5.9.3 react@19.0.0 react-test-renderer@19.0.0
NODE_OPTIONS=--max-old-space-size=512 NODE_PATH="$QA_DEPS/node_modules" \
  node "$SOURCE_ROOT/docs/qualification/official-connectors-pane.test.cjs" \
  "$SOURCE_ROOT" "$QA_DEPS/pane-receipt.json"
```

The optional second argument writes a small JSON receipt; success/failure also appears on stdout/stderr. Keep the receipt before removing only the owned temporary dependency directory. This command does not install dependencies into the app or add an automatic CI workflow.
