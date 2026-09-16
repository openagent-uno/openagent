# Scheduler & Dream Mode

## Scheduler

Cron tasks stored in SQLite — survive reboots. Runs as part of `openagent serve`
whenever a database is attached. Changes take effect within ~30 seconds
(the scheduler's next tick) without needing a restart.

Manage tasks via:

- the **Tasks** tab in the desktop / universal app (reads and writes
  `/api/scheduled-tasks` on the gateway);
- the `scheduler` MCP server (from inside an agent chat — `create_scheduled_task`,
  `update_scheduled_task`, etc.);
- the REST API (`POST /api/scheduled-tasks`, `GET /api/scheduled-tasks`, etc.).

## Dream Mode

Nightly maintenance task, run through the same tick loop as any other
scheduled task. It works two missions:

- **Mission 1 — curate the vault.** Merge duplicates, cross-link notes with
  wikilinks, reconcile contradictions, keep `tags:` consistent.
- **Mission 2 — analyze the last day of logs and fix what is broken.** Read
  ~24h of `events.jsonl` and act on broken scheduled tasks (fix, reschedule,
  or retire them), failed or stalled workflows, and recurring model / MCP /
  federation / channel errors.

The receipt lands in the vault at `dream-logs/dream-log-YYYY-MM-DD.md`.

```yaml
dream_mode:
  enabled: true
  time: "3:00"
  timezone: "Europe/Rome"   # omit → UTC
```

::: warning `time` is UTC unless you say otherwise
Crons evaluate in **UTC**, not in the host's local zone — an untagged
`3:00` fires at 03:00 UTC on every machine, which is 05:00 in Rome in
summer. Name a `timezone` (any IANA zone) to get the wall-clock hour you
actually meant, and DST is handled for you.

Set `scheduler.timezone` to make that the default for every new task.
It is materialised into each task when it is created and never re-applied
to tasks that already exist, so setting it never silently re-aims a cron
you already hand-converted to UTC.
:::

## Auto-Update

The second built-in task: check GitHub releases, download, and let the
launcher pick up the new binary on the next restart. **Off unless you
enable it.** Once enabled the check defaults to a daily `0 4 * * *` cron;
override it with `check_interval`.

```yaml
auto_update:
  enabled: true
  mode: auto                  # auto | notify | manual
  check_interval: "0 4 * * *" # default; any 5-field cron
```

See [Deployment → Auto-Update](./deployment.md#auto-update) for the mode
semantics and restart behaviour.

## Built-in tasks

There are exactly two built-in scheduled tasks — `dream-mode` and
`auto-update`, both above. Everything else on the schedule is one you
created.

::: warning `manager_review` was retired
The weekly **Manager Review** task no longer exists. Its duties were folded
into Dream Mode's Mission 2, which runs nightly rather than weekly.

There is no `manager_review` config section — setting one has no effect. On
every boot the server **hard-deletes** any leftover `manager-review` row from
`scheduled_tasks`, so an old install stops running the stale prompt without
you needing to clean up. The `manager-reviews/` receipts a previous version
wrote to your vault are left alone; Dream Mode writes to `dream-logs/` now.
:::
