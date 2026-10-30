from __future__ import annotations

import json
import time
from dataclasses import replace

import pytest

from openagent_host_tools import CapabilityHost, HostError, HostPaths
from openagent_tool_protocol.types import ServerManifest, ToolClassification, ToolManifest, ToolResult


class Computer:
    manifest = ServerManifest('computer-control', 'test', '', (
        ToolManifest('computer_accessibility_snapshot', 'snapshot', {}, ToolClassification.READ_ONLY),
        ToolManifest('computer_accessibility_action', 'action', {}, ToolClassification.MUTATING),
    ))

    def __init__(self):
        self.actions = 0
        self.used = False

    async def call(self, tool, args):
        if tool == 'computer_accessibility_snapshot':
            self.used = False
            return ToolResult.text(json.dumps({'snapshot_id': 'owned-snapshot', 'expires_in_ms': 120000}))
        if self.used:
            return ToolResult.text('stale_snapshot', is_error=True)
        self.used = True
        self.actions += 1
        return ToolResult.text('{"ok":true,"requires_fresh_snapshot":true}')

    async def close(self):
        pass


@pytest.fixture
async def fixture(tmp_path):
    host = CapabilityHost(paths=HostPaths.discover(tmp_path/'state'), builtin_names=())
    await host.start()
    await host.set_consent(True)
    computer = Computer()
    host._servers['computer-control'] = computer
    host._inventory['computer-control'] = replace(computer.manifest, available=True)
    host._health['computer-control'] = {'available': True, 'source': 'test'}
    try:
        yield host, computer
    finally:
        await host.close()


@pytest.mark.asyncio
async def test_snapshot_cannot_be_used_by_another_account_or_device(fixture):
    host, computer = fixture
    owner = {'client_instance_id': 'device-one', 'account_id': 'account-a', 'generation': 1}
    await host.call('computer-control', 'computer_accessibility_snapshot', {'window_id': 1, 'pid': 2}, principal=owner)
    args = {'snapshot_id': 'owned-snapshot', 'element_id': 'element-1', 'action': 'press'}
    for other in [dict(owner, account_id='account-b'), dict(owner, client_instance_id='device-two'), dict(owner, generation=2)]:
        with pytest.raises(HostError) as error:
            await host.call('computer-control', 'computer_accessibility_action', args, principal=other)
        assert error.value.code == 'resource_owner_mismatch'
    assert computer.actions == 0
    first = await host.call('computer-control', 'computer_accessibility_action', args, principal=owner, idempotency_key='owned-action')
    replay = await host.call('computer-control', 'computer_accessibility_action', args, principal=owner, idempotency_key='owned-action')
    assert not first.is_error
    assert replay.meta['openagent/replayed'] is True
    assert computer.actions == 1
    stale = await host.call('computer-control', 'computer_accessibility_action', args, principal=owner, idempotency_key='second-action')
    assert stale.is_error
    assert computer.actions == 1


@pytest.mark.asyncio
async def test_expiry_and_principal_release_revoke_snapshot_access(fixture):
    host, computer = fixture
    args = {'snapshot_id': 'owned-snapshot', 'element_id': 'element-1', 'action': 'press'}
    await host.call('computer-control', 'computer_accessibility_snapshot', {}, principal='owner')
    host._accessibility_owners['owned-snapshot'] = ('owner', time.monotonic()-1)
    with pytest.raises(HostError) as expired:
        await host.call('computer-control', 'computer_accessibility_action', args, principal='owner')
    assert expired.value.code == 'resource_owner_mismatch'
    await host.call('computer-control', 'computer_accessibility_snapshot', {}, principal='owner', idempotency_key='new-snapshot')
    await host.release_principal('owner')
    with pytest.raises(HostError) as released:
        await host.call('computer-control', 'computer_accessibility_action', args, principal='owner')
    assert released.value.code == 'resource_owner_mismatch'
    assert computer.actions == 0
