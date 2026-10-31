from __future__ import annotations

import os
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory

import click

from ._product_db import product_memory_db
from ._framework import TestContext, test


@test("local_e2e", "local E2E mode requires a marked temporary fixture")
async def test_local_e2e_guard(ctx: TestContext) -> None:
    from openagent_server.cli import _enable_local_e2e

    previous = os.environ.get("OPENAGENT_IROH_DISCOVERY")
    try:
        fixture = ctx.test_dir / "local-e2e-guard"
        fixture.mkdir()
        config_path = fixture / "openagent.yaml"
        config_path.write_text("local_e2e_fixture: true\n", encoding="utf-8")
        config = {
            "local_e2e_fixture": True,
            "_config_path": str(config_path),
        }
        _enable_local_e2e(config, fixture)
        assert config["_local_e2e"] is True
        assert os.environ["OPENAGENT_IROH_DISCOVERY"] == "none"

        try:
            _enable_local_e2e({}, fixture)
        except click.ClickException:
            pass
        else:
            raise AssertionError("unmarked fixture was accepted")

        try:
            _enable_local_e2e(
                {
                    "local_e2e_fixture": True,
                    "_config_path": str(config_path),
                },
                Path.home(),
            )
        except click.ClickException:
            pass
        else:
            raise AssertionError("non-temporary agent directory was accepted")

        escaped_db = fixture / "openagent.db"
        escaped_db.symlink_to(Path.home() / "openagent.db")
        try:
            _enable_local_e2e(
                {
                    "local_e2e_fixture": True,
                    "_config_path": str(config_path),
                },
                fixture,
            )
        except click.ClickException:
            pass
        else:
            raise AssertionError("fixture with a database symlink was accepted")
    finally:
        if previous is None:
            os.environ.pop("OPENAGENT_IROH_DISCOVERY", None)
        else:
            os.environ["OPENAGENT_IROH_DISCOVERY"] = previous


@test("local_e2e", "Custom View seed warms searchable message and tool text")
async def test_local_e2e_view_seed_warms_message_and_tool_search(
    _ctx: TestContext,
) -> None:
    from scripts.seed_local_e2e_views import _access, seed
    from openagent_core.memory.db import MemoryDB
    from openagent_core.memory.operational.search import operational_search_status
    from openagent_core.memory.operational.service import OperationalSearchService
    from openagent_identity.coordinator.store import CoordinatorStore

    with TemporaryDirectory(prefix="openagent-view-seed-search-") as directory:
        root = Path(directory)
        (root / "openagent.yaml").write_text(
            "name: local-view-seed\nlocal_e2e_fixture: true\n",
            encoding="utf-8",
        )

        db = await product_memory_db(str(root / "openagent.db"))
        try:
            await CoordinatorStore(db).set_network_role(
                role="coordinator",
                network_id="local-view-seed-network",
                name="Local View Seed",
            )
        finally:
            await db.close()

        seeded = await seed(root, "Alice")

        db = await product_memory_db(str(root / "openagent.db"))
        try:
            status = await operational_search_status(db)
            outbox_head = int(
                (
                    await (
                        await db._conn.execute(
                            "SELECT COALESCE(MAX(seq), 0) FROM search_outbox"
                        )
                    ).fetchone()
                )[0]
            )
            assert status["ready"] is True
            assert int(status["pending"]) == 0
            assert int(status["seq"]) >= outbox_head

            result = await OperationalSearchService(db).search(
                access=_access(str(seeded["tenant"]), str(seeded["handle"])),
                query="remains useful older clients",
                scopes=("chats",),
                limit=10,
            )
            message_hits = [
                hit
                for hit in result["hits"]
                if hit["target"].get("kind") == "chat_message"
                and hit["target"].get("message_id")
                == "local-e2e-custom-view-message"
            ]
            assert result["ok"] is True
            assert len(message_hits) == 1
            assert message_hits[0]["target"]["session_id"] == seeded["session_id"]
            assert "remains" in message_hits[0]["snippet"].lower()
            assert "older" in message_hits[0]["snippet"].lower()

            tool_owner = await (
                await db._conn.execute(
                    "SELECT owner_principal_id FROM tool_invocations WHERE id=?",
                    (seeded["tool_invocation"],),
                )
            ).fetchone()
            assert tool_owner is not None
            assert str(tool_owner[0]) == "user:alice"

            tool_result = await OperationalSearchService(db).search(
                access=_access(str(seeded["tenant"]), str(seeded["handle"])),
                query="local_e2e_search_tool",
                scopes=("tools",),
                limit=10,
            )
            tool_hits = [
                hit
                for hit in tool_result["hits"]
                if hit["target"].get("kind") == "chat_tool"
                and hit["target"].get("tool_invocation_id")
                == seeded["tool_invocation"]
            ]
            assert tool_result["ok"] is True
            assert len(tool_hits) == 1
            assert tool_hits[0]["target"]["session_id"] == seeded["session_id"]
            assert (
                tool_hits[0]["target"]["message_id"]
                == "local-e2e-custom-view-message"
            )
        finally:
            await db.close()


@test("local_e2e", "local E2E product preparation migrates storage and preserves the injected pool")
async def test_local_e2e_agent_boot_is_hermetic(ctx: TestContext) -> None:
    from openagent_core.core.agent import Agent
    from openagent_core.memory.db import MemoryDB
    from openagent_server.bootstrap import prepare_agent
    from unittest.mock import AsyncMock, patch

    class ForbiddenPool:
        async def connect_all(self) -> None:
            raise AssertionError("MCP pool connected in local E2E mode")

    db = MemoryDB(str(ctx.test_dir / f"product-preparation-{uuid.uuid4().hex}.sqlite3"))
    pool = ForbiddenPool()
    agent = Agent(
        model=None,
        mcp_pool=pool,  # type: ignore[arg-type]
        config={"_local_e2e": True},
    )
    agent._db = db
    try:
        with patch.object(agent, "load_model_catalog", AsyncMock(side_effect=AssertionError("model hydration in QA preparation"))) as hydrate:
            await prepare_agent(agent, {"_local_e2e": True})
            hydrate.assert_not_awaited()
        assert agent.memory_db is db
        assert agent.capability_pool is pool
        assert db._conn is not None
        # Exercise the real standalone dashboard migration, not a connect spy.
        row = await (await db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='ui_views'"
        )).fetchone()
        assert row is not None and row[0] == "ui_views"
    finally:
        await db.close()


@test("local_e2e", "local E2E server omits every background writer")
async def test_local_e2e_server_boot_is_hermetic(ctx: TestContext) -> None:
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from openagent_server.server import AgentServer

    server = AgentServer(SimpleNamespace(name="fixture", model=None), {"_local_e2e": True})  # type: ignore[arg-type]
    bridge = SimpleNamespace(name="owned-bridge", start=AsyncMock(side_effect=AssertionError("bridge started")))
    server._bridges = [bridge]
    before = set(asyncio.all_tasks())
    with patch("openagent_server.bootstrap.start_voice_warmups", side_effect=AssertionError("voice warmup started")) as voice, \
         patch.object(server, "_start_scheduler", AsyncMock(side_effect=AssertionError("scheduler started"))) as scheduler:
        # Product writers are separate from the real gateway bootstrap. Test
        # their exclusion directly; a fake agent is not a gateway substitute.
        await server._start_product_services(True)
        voice.assert_not_called()
        scheduler.assert_not_awaited()
        bridge.start.assert_not_awaited()

    assert server._scheduler is None
    assert server._bridges == [bridge]
    assert server._bridge_tasks == []
    assert not server._warmup_tasks
    assert server._curator_task is None
    assert getattr(server, "_vault_autocommit_task", None) is None
    assert getattr(server, "_semantic_index_task", None) is None
    assert set(asyncio.all_tasks()) == before


@test("local_e2e", "serve re-packs one bootstrap invite only after address publication")
async def test_local_e2e_serve_ticket_has_address_hints(ctx: TestContext) -> None:
    import inspect

    from openagent_server import cli as cli_module
    from openagent_server.cli import _repack_serve_invites_after_start
    from openagent_core.memory.db import MemoryDB
    from openagent_identity.cli_commands import auto_init_if_standalone, mint_first_user_invite
    from openagent_identity.coordinator.store import CoordinatorStore
    from openagent_identity.coordinator_addr_cache import write_cache
    from openagent_identity.ticket import InviteTicket

    # Pin the actual CLI orchestration, not only the packer: entering the
    # AgentServer context publishes coordinator_addr.json, and no oa1 envelope
    # may be printed before it has been regenerated from that cache.
    serve_source = inspect.getsource(cli_module.serve.callback)
    entered = serve_source.index("async with server:")
    repacked = serve_source.index("await _repack_serve_invites_after_start", entered)
    printed = serve_source.index("print(ticket_str)", repacked)
    assert entered < repacked < printed

    root = ctx.test_dir / f"serve-ticket-order-{uuid.uuid4().hex}"
    root.mkdir(parents=True)
    config = {
        "name": "local-ticket-agent",
        "memory": {"db_path": str(root / "openagent.db")},
    }
    network = await auto_init_if_standalone(
        agent_dir=root,
        config=config,
        quiet=True,
    )
    assert network is not None and network["role"] == "coordinator"

    # This is the serve pre-flight: it creates the durable invitation before
    # the iroh node exists. Its provisional envelope cannot address a client.
    provisional = await mint_first_user_invite(
        agent_dir=root,
        config=config,
        network_row=network,
    )
    assert provisional is not None
    provisional_ticket = InviteTicket.decode(provisional[0])
    assert provisional_ticket.relay_url is None
    assert provisional_ticket.addresses is None

    db = await product_memory_db(str(root / "openagent.db"))
    try:
        # The real post-start packer borrows the running agent's migrated DB.
        # With discovery disabled it must still reject unpublished addresses.
        try:
            await _repack_serve_invites_after_start(
                agent_dir=root,
                config=config,
                network_row=network,
                db=db,
                require_address_hints=True,
            )
        except click.ClickException:
            pass
        else:
            raise AssertionError("serve accepted a local E2E ticket before address publication")

        direct_hint = "127.0.0.1:43123"
        write_cache(
            root,
            node_id=provisional_ticket.coordinator_node_id,
            relay_url=None,
            direct_addresses=[direct_hint],
        )
        bootstrap, active = await _repack_serve_invites_after_start(
            agent_dir=root,
            config=config,
            network_row=network,
            db=db,
            require_address_hints=True,
        )
        assert bootstrap is not None
        final_ticket = InviteTicket.decode(bootstrap[0])
        assert bootstrap[1]["code"] == provisional[1]["code"]
        assert final_ticket.addresses == (direct_hint,)
        assert final_ticket.coordinator_node_id == provisional_ticket.coordinator_node_id

        matching = [item for item in active if item["code"] == bootstrap[1]["code"]]
        assert len(matching) == 1
        assert InviteTicket.decode(matching[0]["ticket"]).addresses == (direct_hint,)

        invitations = await CoordinatorStore(db).list_invitations(include_expired=True)
        assert len(invitations) == 1
        assert invitations[0].code == bootstrap[1]["code"]
    finally:
        await db.close()
