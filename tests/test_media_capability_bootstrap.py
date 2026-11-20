"""Installed standalone composition preserves existing media capability policy."""
import asyncio


def test_default_media_generation_is_seeded_and_explicit_disable_is_preserved(tmp_path) -> None:
    # Regression: standalone module composition omitted Core's default image tool.
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from openagent_core.memory.db import MemoryDB
    from openagent_server.bootstrap import prepare_agent, standalone_spec_resolver

    async def check():
        db = MemoryDB(str(tmp_path / "agent.sqlite"))
        agent = SimpleNamespace(memory_db=db, set_capability_pool=lambda pool: None,
                                load_model_catalog=AsyncMock())
        try:
            await prepare_agent(agent, {})
            rows = [row for row in await db.list_mcps() if row["name"] == "media-gen"]
            assert len(rows) == 1
            assert rows[0]["enabled"]
            assert standalone_spec_resolver({})(rows[0], db.db_path)["name"] == "media-gen"
            await db.upsert_mcp("media-gen", kind="custom", enabled=False, command=["operator-owned"])
            await db.close()
            db = MemoryDB(str(tmp_path / "agent.sqlite"))
            agent.memory_db = db
            await prepare_agent(agent, {})
            row = next(row for row in await db.list_mcps() if row["name"] == "media-gen")
            assert not row["enabled"] and row["kind"] == "custom"
            assert row["command"] == ["operator-owned"]
        finally:
            await db.close()
    asyncio.run(check())


def test_media_generation_alias_preserves_operator_disabled_state(tmp_path) -> None:
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from openagent_core.memory.db import MemoryDB
    from openagent_server.bootstrap import prepare_agent

    async def check():
        db = MemoryDB(str(tmp_path / "agent.sqlite"))
        try:
            await db.connect()
            await db.upsert_mcp("images", kind="default", builtin_name="media-gen",
                                enabled=False, source="operator-configured")
            before = await db.list_mcps()
            await db.close()
            db = MemoryDB(str(tmp_path / "agent.sqlite"))
            agent = SimpleNamespace(memory_db=db, set_capability_pool=lambda pool: None,
                                    load_model_catalog=AsyncMock())
            await prepare_agent(agent, {})
            media_rows = [row for row in await db.list_mcps()
                          if row["name"] == "media-gen" or row.get("builtin_name") == "media-gen"]
            assert media_rows == before
        finally:
            await db.close()
    asyncio.run(check())


