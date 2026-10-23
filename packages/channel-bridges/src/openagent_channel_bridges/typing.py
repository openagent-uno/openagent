"""Best-effort native indicators, bounded to one authorized processing turn.

No content is sent here. Providers own the native primitive; the bridge supplies
fresh authorization before every request. Ending always cancels and joins the
pulse task, including while a provider request is waiting on rate limiting.
"""
from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Awaitable, Callable


@dataclass(frozen=True)
class TypingSpec:
    pulse: Callable[[], Awaitable[None]]
    interval: float = 7.0
    clear: Callable[[], Awaitable[None]] | None = None


class TypingRateLimited(Exception):
    def __init__(self, retry_after: float):
        self.retry_after = retry_after


class ProcessingIndicator:
    request_timeout = 5.0
    max_lifetime = 1800.0

    def __init__(self, spec: TypingSpec, authorize: Callable[[], Awaitable[None]]):
        self.spec, self.authorize = spec, authorize
        self.task: asyncio.Task | None = None
        self.users = 1
        self.closed = False
        self.started = False

    async def _pulse(self):
        async with asyncio.timeout(self.request_timeout):
            await self.authorize()
            await self.spec.pulse()
            self.started = True

    async def begin(self):
        # Start in a task so callers can immediately own/cancel the entire
        # lifecycle, including the first slow HTTP request.
        self.task = asyncio.create_task(self._run(), name="channel-native-typing")
        await asyncio.sleep(0)

    async def _run(self):
        failures = 0
        try:
            async with asyncio.timeout(self.max_lifetime):
                while not self.closed:
                    try:
                        await self._pulse()
                        failures = 0
                        delay = self.spec.interval
                    except TypingRateLimited as error:
                        failures += 1
                        # Never hammer a forbidden/rate-limited surface. Only
                        # two bounded retries; a longer Retry-After disables it.
                        if failures > 2 or not 0 < error.retry_after <= 30:
                            return
                        delay = max(self.spec.interval, error.retry_after)
                    await asyncio.sleep(delay)
        except (PermissionError, TimeoutError):
            return
        except Exception:
            # Unsupported scopes, forbidden surfaces and network failures are
            # indicator failures, never a reason to fail an agent request.
            return

    async def end(self, *, clear=True):
        if self.closed:
            return
        self.closed = True
        if self.task is not None:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
        if clear and self.started and self.spec.clear is not None:
            with contextlib.suppress(Exception):
                async with asyncio.timeout(self.request_timeout):
                    await self.authorize()
                    # Recheck after asynchronous authorization: another turn
                    # may have started while membership/policy was refreshed.
                    if not callable(clear) or clear():
                        await self.spec.clear()
