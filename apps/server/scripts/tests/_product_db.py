"""A MemoryDB opened the way the standalone product opens it.

Core's ``MemoryDB.connect()`` creates Core's schema only. The product adds its
own migrations before connecting (``openagent_server.bootstrap.prepare_agent``
registers the dashboards' ``custom-views-v1``), so a test that exercises
product storage must do the same or it fails with "no such table: ui_views".
"""
from __future__ import annotations


async def product_memory_db(path: str):
    from openagent_core.memory.db import MemoryDB
    from openagent_dashboards.migration import ensure_custom_views_storage

    db = MemoryDB(str(path))

    async def dashboard_migration(connection) -> None:
        await ensure_custom_views_storage(connection, app_version="test")

    db.add_migration(dashboard_migration)
    await db.connect()
    return db
