# Scheduler and Dream Mode

Scheduler and Vault are independent optional modules in OpenAgent v1.1. The
standalone full profile enables both and registers an integration that schedules
Vault's dream maintenance. A product can enable Scheduler without Vault, Vault
without Scheduler, or neither.

## Scheduler

`openagent-module-scheduler` owns schedule definitions, timezone handling,
firings, deduplication and its worker. Its `agent_tools` surface provides the
`schedule_*` tools; its `host_api` surface lets the product manage schedules
without exposing manager tools to the model.

A schedule can start a normal agent run directly. If Workflows is also active,
it can target a specific workflow version. Workflows is not a dependency of
Scheduler.

```python
ModuleConfig(
    surfaces={"service", "agent_tools", "host_api", "workers"},
)
```

Every firing revalidates its durable delegation and target references. Device
capabilities supplied by an App or CLI turn are not persisted. Timezone, DST,
pending occurrences and event deduplication remain durable across restarts.

If disabling a module would invalidate active schedules, reconfiguration
preflight returns the affected references. The host must cancel the change or
explicitly pause those schedules; nothing is deleted automatically.

## Dream Mode

Dream Mode belongs to `openagent-module-vault`. It starts a real child session
that consolidates notes, repairs links, records provenance and writes a durable
receipt. The standalone and initial GlassPalace profiles preserve the existing
default cadence and reminder behavior.

```yaml
dream_mode:
  enabled: true
  time: "3:00"
  timezone: "Europe/Rome"
```

Name an IANA timezone when the schedule should follow local wall-clock time and
DST. Without one, cron expressions use UTC.

Removing Vault removes Dream tools, hooks, reminders and prompt instructions.
Disabling Scheduler does not delete Vault data, and Vault can still run a
manually requested maintenance child session.

## Auto-update

Product updates belong to the standalone product rather than the Core Scheduler
contract. During the v1.1 beta transition, installed 0.x clients retain their
historical updater endpoints while new coordinated artifacts are published from
[`openagent`](https://github.com/openagent-uno/openagent/releases). See
[Deployment](./deployment.md#auto-update) for the currently qualified path.
