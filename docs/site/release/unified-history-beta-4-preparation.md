# Server Beta 4 candidate evidence and preparation

Status: replacement source pre-tag verified; intent frozen; Beta 4 tag and
GitHub Release absent

The published `v0.20.0-beta.3` package reached the Friday dogfood gate and was
stopped because two legacy sessions could not be projected. The immutable
result is recorded in
[`unified-history-beta-3-friday-failure.yaml`](./unified-history-beta-3-friday-failure.yaml).
This page separates the accepted replacement evidence from the rejected source
record. The canonical freeze record is
[`unified-history-beta-4-intent.yaml`](./unified-history-beta-4-intent.yaml).
Its SHA-256 is
`338ea5f00f88fde99c10e7f2452c7204e3429b209ed12c5e78ae9de677beac7a`.
No tag, release or deployment is performed by this documentation commit.

## Accepted replacement candidate

The frozen Beta 4 source is
`b9d8ab50619ce89129146027c7ec21f83ce4f337`. It includes readiness-cache fix
`ec859dfe943f2da2af3a9554a1909160ad94687c` and the deterministic regression at
the candidate tip, while retaining storage repair
`ebcfedc3779421f874a1e0d079bb06b002fa79f9`.

Exact-source gates are green:

- local full suite `1653/0/46` in `213.6s`, log SHA-256
  `731e3f59c9cebe9893b1faa5471e5cf62d2239a25ec26f984dedf87f9e26c2f1`;
- branch Tests `32982520288`, job `98222391421`: success;
- Supply chain `32982520375`, job `98222392469`: success;
- exact-source Friday rehearsal: complete, search ready and SQLite checks clean.

The tag `v0.20.0-beta.4` remains unused and the GitHub Release is absent.

## Rejected pre-tag candidate

The first Beta 4 source was
`699ffe8fa20d960e90ce7ade45a440301085e72a`, including storage repair commit
`ebcfedc3779421f874a1e0d079bb06b002fa79f9`. It remained based on frozen
`v0.19.27` (`ea6acc52e2cb4b07e733075bc6469a6479e11cd1`) and prepared package
version `0.20.0-beta.4` / `0.20.0b4`.

Local gates passed: full suite `1653/0/46` in `164.0s` with log SHA-256
`2c996ff5243b7caae43ee02bb6709aff3d3741837ba129f2ff2ceb37a15d7b89`,
targeted storage/API `32/32`, updater `29/29`, and Beta 4 selfcheck. Supply-chain
run `32981309094` also passed.

Branch Tests run `32981309012` did not pass: it recorded `1647` passed, one
failed and `51` skipped because of a search-cache readiness race. This is a
real pre-tag failure, so source `699ffe8…` is rejected even though its storage
rehearsal passed. No `v0.20.0-beta.4` tag or GitHub Release was created; the tag
and version are therefore not burned. The immutable sanitized record is
[`unified-history-beta-4-ci-failure.yaml`](./unified-history-beta-4-ci-failure.yaml).

## Frozen candidate fields

The intent records:

- exact replacement source SHA
  `b9d8ab50619ce89129146027c7ec21f83ce4f337`;
- confirmation that the still-unused Beta 4 tag points nowhere;
- normalized Python package version;
- unchanged frozen base `v0.19.27` at
  `ea6acc52e2cb4b07e733075bc6469a6479e11cd1`, unless a separately reviewed
  train change explicitly replaces it;
- exact checksum of every runtime SQL migration; the current storage-v2 hash is
  `ce406057aec3d3b0076e3750045ae24ab50f7829396809ae8f72defdd2111863`
  and the additive tool-context repair hash is
  `14fc8629dee90415e58807825b7d32492fb51b4dbb7ee31909396d21a648fd46`;
- complete local-suite result and log digest for the replacement SHA;
- successful branch test and supply-chain run/job IDs for that same SHA;
- expected package filenames; exact post-build digests belong to the later
  evidence index because those bytes do not exist pre-tag;
- the existing beta-only authorization reference.

`unified-history-beta-3-intent.yaml` and its checksum sidecar remain unchanged.
The rejected source's local/targeted results remain attributed to that source;
the accepted intent uses only exact-source full/CI/rehearsal evidence as release
gates.

## Projection-repair evidence

The accepted source preserves the storage behavior below through its full suite
and exact-source Friday rehearsal:

- two invocations with the same provider `tool_call_id` in different
  `session_run_id` contexts are distinct canonical invocations and both project;
- a duplicate within the same canonical run is still rejected or handled by the
  documented idempotency rule;
- an already migrated Beta 3 database accepts the repair through a new,
  checksum-ledgered additive migration; the original storage-v2 migration and
  its recorded checksum are not rewritten;
- the obsolete root-only uniqueness rule is removed and replacement indexes
  preserve the documented non-session fallback semantics;
- every legacy session missing from v2 is requeued exactly once, while an
  already pending legacy-change journal row is not duplicated;
- a retry is resumable and idempotent after interruption;
- `failed_sessions` describes the current unresolved set rather than retaining
  a stale cumulative failure count;
- message-to-tool search projection joins through the canonical run context, so
  a repeated provider call ID cannot anchor to a message in another run;
- storage readiness stays fail-closed until set parity, pending journal count,
  and failed-session count are all healthy.

## Exact Beta 3 database rehearsal

Source `b9d8ab5…` was run against a fresh SQLite Backup API copy of Friday's
current stable database, on Friday and without copying user content into docs
or CI logs. The source database digest remained
`526df4fc85ba8b3f6fbb1a88ecf52a1b4240d69eccb7129a82a847afe32e99cd`
before and after rehearsal.

The repaired copy contained `586/586`, complete, zero failed/pending and zero
anti-join gaps. Search was ready, caught up and pending zero. The exact legacy
canary was searchable, all eight collision groups and their `16` distinct
invocations were preserved, both base/repair ledger entries were complete, and
SQLite quick/foreign-key checks were clean.

The synthetic canary is removed by its exact recorded identifier only after its
projection and searchability have been proved. Never use a broad delete.

## Remaining release and Friday gate

After review of the frozen intent:

1. push the unused immutable Beta 4 tag pointing at its exact source SHA;
2. require the full native package matrix, exact asset-set verifier,
   attestations, hidden-draft digest check, `prerelease=true`, and
   `make_latest=false`;
3. download the exact published Linux asset on Friday and verify its sibling
   checksum plus authenticated GitHub asset digest;
4. stop the named service and prove its cgroup is empty before replacing the
   executable and sidecar;
5. re-enable only the captured beta-channel drop-in, keep storage in `shadow`,
   and wait for truthful history/search readiness;
6. run the authenticated five-scope/nine-target gateway smoke with a temporary
   principal and sanitized evidence;
7. repeat the stable binary downgrade/write/re-upgrade reconciliation drill;
8. clean the temporary principal, device, ticket, synthetic resources, and the
   exact legacy canary, then leave Friday on the successor beta only if every
   gate remains green.

App tag `v0.17.0-beta.1` and CLI tag `v0.16.0-beta.1` were dispatched in
parallel after the intent freeze; runs `32983788693` and `32983586871` are in
progress and no app/CLI release is published at this snapshot. Installation,
live E2E and train promotion remain subordinate to the server Friday gate. Beta
3 stays immutable and non-promotable; it is not repaired by moving its tag or
replacing any release asset.
