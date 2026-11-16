"""A person's consent for one automation to use one of their devices.

By default a connected device's tools serve only the turns its owner starts.
An automation (a scheduled task, including a loop bound to a conversation)
runs on the authority its approver granted and never sees a device. A row
here lets exactly one automation definition use exactly one device of the
person who approved it, while that device is connected:

- it is keyed by tenant, owner, device, kind and definition id, so it follows
  the automation across edits but only applies while the automation's active
  grant still belongs to the same owner;
- it never widens what the device offers (its own consent and modules still
  apply) and never reaches another person's device;
- revoking it, or the owner's device or grant, ends it.
"""
from __future__ import annotations

import time

import aiosqlite

_SCHEMA = """
CREATE TABLE IF NOT EXISTS automation_device_consents (
    tenant_id TEXT NOT NULL,
    owner_subject_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    device_label TEXT,
    created_at REAL NOT NULL,
    PRIMARY KEY (tenant_id, owner_subject_id, device_id, kind, definition_id)
)
"""


class AutomationDeviceConsents:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._ready = False

    async def _connect(self):
        conn = await aiosqlite.connect(self.db_path)
        if not self._ready:
            await conn.execute(_SCHEMA)
            await conn.commit()
            self._ready = True
        return conn

    async def grant(self, *, tenant_id: str, owner: str, device_id: str, kind: str,
                    definition_id: str, device_label: str | None = None) -> None:
        conn = await self._connect()
        try:
            await conn.execute(
                "INSERT OR REPLACE INTO automation_device_consents "
                "(tenant_id, owner_subject_id, device_id, kind, definition_id, device_label, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (tenant_id, owner, device_id, kind, definition_id, device_label, time.time()),
            )
            await conn.commit()
        finally:
            await conn.close()

    async def revoke(self, *, tenant_id: str, owner: str, device_id: str, kind: str,
                     definition_id: str) -> bool:
        conn = await self._connect()
        try:
            cursor = await conn.execute(
                "DELETE FROM automation_device_consents WHERE tenant_id=? AND owner_subject_id=? "
                "AND device_id=? AND kind=? AND definition_id=?",
                (tenant_id, owner, device_id, kind, definition_id),
            )
            await conn.commit()
            return cursor.rowcount > 0
        finally:
            await conn.close()

    async def devices(self, *, tenant_id: str, owner: str, kind: str,
                      definition_id: str) -> list[dict]:
        conn = await self._connect()
        try:
            rows = await (await conn.execute(
                "SELECT device_id, device_label, created_at FROM automation_device_consents "
                "WHERE tenant_id=? AND owner_subject_id=? AND kind=? AND definition_id=? ORDER BY created_at",
                (tenant_id, owner, kind, definition_id),
            )).fetchall()
        finally:
            await conn.close()
        return [{"device_id": r[0], "device_label": r[1], "created_at": r[2]} for r in rows]

    async def for_device(self, *, tenant_id: str, owner: str, device_id: str) -> list[tuple[str, str]]:
        """Every (kind, definition_id) this owner lent this device to."""
        conn = await self._connect()
        try:
            rows = await (await conn.execute(
                "SELECT kind, definition_id FROM automation_device_consents "
                "WHERE tenant_id=? AND owner_subject_id=? AND device_id=? ORDER BY created_at",
                (tenant_id, owner, device_id),
            )).fetchall()
        finally:
            await conn.close()
        return [(r[0], r[1]) for r in rows]

    async def allows(self, *, tenant_id: str, owner: str, device_id: str, kind: str,
                     definition_id: str) -> bool:
        return any(row["device_id"] == device_id for row in await self.devices(
            tenant_id=tenant_id, owner=owner, kind=kind, definition_id=definition_id))
