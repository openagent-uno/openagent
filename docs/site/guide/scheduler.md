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

## Conversation goals and restarts

`/goal <objective>` (or the goal bar in the app) keeps the agent working in one
conversation until the goal is achieved, blocked or out of continuations. The
REST surface is `GET/PUT/PATCH/DELETE /api/sessions/{session_id}/goal`.

A restart of the server ends the turn that was working on a goal. About twenty
seconds after it starts (`OPENAGENT_GOAL_RECOVERY_DELAY_S`), the server looks
at every active goal whose last turn the restart interrupted:

- When the agent's owner set, edited or resumed the goal (from the app, the
  API or `/goal`), the server holds a durable delegation for that
  conversation and that exact objective, like the one a loop has. The goal
  starts again in the same conversation, uses one continuation, and the agent
  is told that its earlier turn was interrupted and to check the state before
  repeating anything. Like every deferred run, it cannot use a connected
  device.
- Otherwise the goal pauses and shows why ("The runtime restarted while
  working on this goal…"). Resume it or send a message to continue. This is
  the case for a goal set by another member, and for one whose objective was
  changed outside the app, the API and `/goal`.
- If the restart interrupted a turn that was already such a resume, the goal
  pauses instead of starting a third time, so a step that keeps crashing the
  server cannot loop.

Pausing, finishing or clearing a goal withdraws its delegation.

## Dream Mode

Dream Mode belongs to `openagent-module-vault`. It starts a real child session
that consolidates notes, repairs links, records provenance and writes a durable
receipt. The standalone profile preserves the existing default cadence and reminder
behavior; embedding hosts choose their own module configuration.

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
