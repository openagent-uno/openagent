# Telegram command-menu recovery: source qualification

Date: 3 November 2026. Component candidate: `openagent-channel-bridges 0.1.0b17`.
Product base: `b4cb9645`. Core source: `be81ad0` (`1.1.0b44`).
Python 3.11; python-telegram-bot 22.8. No provider credentials or provider API
calls were used. This receipt qualifies source behavior, not a public wheel,
an installed host, a deployed bot or Telegram client acceptance.

## Reproduced defects and correction

Before the change, registration ran once before polling. A transient network
failure set a five-minute retry timestamp, but a healthy polling loop never
called registration again. The `/` picker could remain empty until reconnect.
The successful-registration flag also hid later negotiated catalogue changes.
With the SDK's `PTB_TIMEDELTA` mode, converting `RetryAfter.retry_after` directly
to `float` raised `TypeError` and interrupted startup.

Registration is now checked from healthy polling, with the existing backoff
guard preventing provider calls before the deadline. Successful registrations
remember the actual negotiated catalogue. Changed catalogues are registered
again. Both numeric and `timedelta` retry values are accepted, retaining the
minimum sixty-second provider backoff. The logged count is the actual menu size.

The four new cases use the real SDK command/error classes, a fake clock and an
SDK application fixture. Three failed against the original implementation and
all four passed after the correction. The application test verifies recovery
without rebuilding the SDK application or restarting polling.

## Shared reset contract

Core already owns `/new`, `/clear` and `/reset`. The reviewed beta44 source uses
`stop_runs` → `release_session` → `rotate_session` for a retaining deferred host.
The host must claim the provider command once, bind its original actor/session,
apply every action and report success only after completion. Stopping a run or
installing a newer bridge alone does not rotate a host session selector.
Long-term memory, the vault and retained previous conversations are preserved.

The shared command contract requires Core beta42 or newer and bridge beta16 or
newer, together with a conforming host advertising `core_commands` scopes.
Beta17 adds menu resilience; it is not a prerequisite for the beta16 reset path.
Core beta44 additionally contains the optional-import corrections reviewed in
that component's own release evidence.

The session menu, in order, is `new`, `clear`, `stop`, `status`, `context`,
`help`, `compact`, `model`. `reset` and `queue` remain accepted typed commands
but are hidden in the menu. Instance commands appear only if advertised by the
host. Empty negotiated capabilities do not imply that a host supports resets.

## Validation

- Full channel-bridges source suite: **344 passed, 86 subtests passed**.
- Core beta44 `test_chat_commands.py` and `test_engine_executor.py`:
  **22 passed, 3 subtests passed**.
- Core's reset regression uses real Runtime/SQLite storage, an active and queued
  run, delayed cancellation, bounded drain failure, old-session resource release,
  retained old records and an independently admitted fresh session.
- Expected SDK warnings: deprecated `audioop` and the currently supported numeric
  `RetryAfter` representation; no skipped cases or failed checks.

The bridge suite loaded the product's `packages/channel-bridges/src` together
with the exact reviewed Core runtime/storage source directories. The Core suite
loaded that component's runtime/storage source directories. Other dependencies
came from the existing isolated development environment. No installed runtime
source was patched, no host selector was mutated, and no package was published.
