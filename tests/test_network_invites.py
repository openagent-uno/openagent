import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from openagent_identity.ticket import InviteTicket
from openagent_server.gateway.api.network import handle_mint_invitation


def fixture(node):
    store = SimpleNamespace(create_invitation=AsyncMock(return_value=SimpleNamespace(
        code="fixture-one-use-invitation", role="device", bind_to_handle="owner", expires_at=123456, uses_left=1,
    )))
    request = {"user_handle": "owner"}
    class Request(dict):
        app = {"gateway": SimpleNamespace(_network_state=SimpleNamespace(iroh_node=node))}
        json = AsyncMock(return_value={"handle": "owner", "ttl": 600})
    return Request(request), store, {"name": "fixture", "network_id": "fixture-network", "coordinator_node_id": "ab" * 32}


@pytest.mark.asyncio
async def test_invite_uses_live_instance_identity_and_current_addresses_without_global_workspace():
    node = SimpleNamespace(node_id=AsyncMock(return_value="ab" * 32),
                           local_node_addr=AsyncMock(return_value=(None, ("127.0.0.1:12345",))))
    request, store, row = fixture(node)
    with patch("openagent_server.gateway.api.network._store_or_404", AsyncMock(return_value=(store, row))), \
         patch("openagent_identity.cli_commands.resolve_invite_intent", AsyncMock(return_value=("device", "owner", "pair device"))), \
         patch("openagent_core.core.paths.get_agent_dir", side_effect=AssertionError("global workspace must not be read")):
        response = await handle_mint_invitation(request)
    assert response.status == 201
    result = json.loads(response.body)
    ticket = InviteTicket.decode(result["ticket"])
    assert ticket.coordinator_node_id == row["coordinator_node_id"]
    assert tuple(ticket.addresses) == ("127.0.0.1:12345",)
    assert ticket.bind_to == "owner"
    assert store.create_invitation.await_args.kwargs["ttl_seconds"] == 600


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["missing", "other-instance", "no-address", "transport-error"])
async def test_unavailable_or_wrong_coordinator_never_mints_or_exposes_transport_error(failure):
    node = SimpleNamespace(node_id=AsyncMock(return_value="ab" * 32),
                           local_node_addr=AsyncMock(return_value=(None, ("127.0.0.1:12345",))))
    if failure == "missing": node = None
    elif failure == "other-instance": node.node_id.return_value = "cd" * 32
    elif failure == "no-address": node.local_node_addr.return_value = (None, ())
    else: node.local_node_addr.side_effect = RuntimeError("private transport details")
    request, store, row = fixture(node)
    with patch("openagent_server.gateway.api.network._store_or_404", AsyncMock(return_value=(store, row))), \
         patch("openagent_identity.cli_commands.resolve_invite_intent", AsyncMock(return_value=("device", "owner", "pair device"))):
        response = await handle_mint_invitation(request)
    assert response.status == 503
    assert b"private transport details" not in response.body
    store.create_invitation.assert_not_awaited()
