"""Real coordinator/member/device wire: fresh authorization on every HTTP request."""
import asyncio
import json
import statistics
import time
from pathlib import Path
import tempfile
import unittest
from aiohttp import web, ClientSession, ClientTimeout
from openagent_core.engine import MemoryDB
from openagent_identity.identity import Identity
from openagent_identity.iroh_node import IrohNode, NetworkAlpn
from openagent_identity.state import NetworkState
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.auth.middleware import make_auth_middleware
from openagent_identity.auth.device_cert import issue_cert
from openagent_identity.transport.aiohttp_iroh_site import IrohSite
from openagent_identity.client.session import SessionDialer, NetworkBinding, LoopbackProxy

class MemberGatewayIrohTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_member_http_reuses_transport_and_honors_revocation_and_outage(self):
        with tempfile.TemporaryDirectory(prefix='member-gateway-wire-') as temporary:
            root = Path(temporary)
            coordinator_db = MemoryDB(str(root / 'coordinator.sqlite'))
            member_db = MemoryDB(str(root / 'member.sqlite'))
            await coordinator_db.connect(); await member_db.connect()
            store = CoordinatorStore(coordinator_db)
            await store.set_network_role(role='coordinator', network_id='fixture-network', name='Fixture')
            coordinator = await NetworkState.from_db(db=coordinator_db, identity_path=root / 'coordinator.key')
            member = client = runner = proxy = dialer = None
            handled = []; live_checks = []; dials = []
            original_lookup = store.get_active_device
            async def lookup(key):
                live_checks.append(time.perf_counter()); return await original_lookup(key)
            # NetworkState constructed its own store; count the authoritative RPC handler.
            coordinator.coordinator_service._store.get_active_device = lookup
            try:
                await coordinator.start()
                coordinator_id = await coordinator.node_id()
                coordinator_hints = await coordinator.iroh_node.local_node_addr()
                await CoordinatorStore(member_db).set_network_role(role='member', network_id='fixture-network', name='Fixture', coordinator_node_id=coordinator_id, coordinator_pubkey=coordinator.identity.public_bytes)
                member = await NetworkState.from_db(db=member_db, identity_path=root / 'member.key')
                await store.create_user(handle='alice', pake_record=b'fixture', pake_algo='fixture')
                await store.register_agent(handle='member', node_id=member.identity.public_hex, owner_handle='alice')
                native_dial = member.iroh_node.dial
                async def member_dial(node_id, alpn, **hints):
                    if alpn == NetworkAlpn.COORDINATOR:
                        dials.append(time.perf_counter())
                        hints = {'relay_url':coordinator_hints[0], 'addresses':list(coordinator_hints[1])}
                    return await native_dial(node_id, alpn, **hints)
                member.iroh_node.dial = member_dial
                app = web.Application(middlewares=[make_auth_middleware(member.auth_state)])
                async def catalog(request):
                    handled.append(request['user_handle'])
                    return web.json_response({'providers': [], 'authorized': request['user_handle']})
                app.router.add_get('/api/providers', catalog)
                runner = web.AppRunner(app); await runner.setup()
                site = IrohSite(runner, member.iroh_node)
                member.iroh_node.register_handler(NetworkAlpn.GATEWAY, site._handle_stream)
                await member.start(); await site.start()
                member_id = await member.node_id()
                member_hints = await member.iroh_node.local_node_addr()
                device = Identity.generate(); client = IrohNode(device); await client.start()
                await store.add_device(device_pubkey=device.public_bytes, user_handle='alice')
                cert = issue_cert(coordinator_key=coordinator.identity._private_key, handle='alice', device_pubkey=device.public_bytes, network_id='fixture-network')
                client_dial = client.dial
                async def direct(node_id, alpn, **hints):
                    if node_id == member_id: hints = {'relay_url':member_hints[0], 'addresses':list(member_hints[1])}
                    return await client_dial(node_id, alpn, **hints)
                client.dial = direct
                dialer = SessionDialer(node=client, binding=NetworkBinding('fixture-network','Fixture',coordinator_id,coordinator.identity.public_bytes,'alice'), cert_wire=cert)
                proxy = LoopbackProxy(dialer=dialer, target_node_id=member_id); await proxy.start()
                async with ClientSession(timeout=ClientTimeout(total=15)) as http:
                    async def read(expected=200):
                        started = time.perf_counter()
                        async with http.get(proxy.base_url + '/api/providers') as response:
                            text = await response.text(); self.assertEqual(response.status, expected, text)
                            if expected == 200: self.assertEqual(json.loads(text)['authorized'], 'alice')
                        return (time.perf_counter() - started) * 1000
                    cold = await read()
                    before = len(live_checks)
                    serial = [await read() for _ in range(8)]
                    concurrent = await asyncio.gather(*(read() for _ in range(8)))
                    self.assertGreaterEqual(len(live_checks) - before, 16)
                    self.assertEqual(len(handled), 17)
                    self.assertEqual(len(dials), 1)
                    print('OPENAGENT_REAL_MEMBER_PERFORMANCE ' + json.dumps({'cold_ms':cold, 'serial_median_ms':statistics.median(serial), 'serial_total_ms':sum(serial), 'concurrent_median_ms':statistics.median(concurrent), 'coordinator_dials':len(dials), 'http_requests':len(handled), 'live_checks':len(live_checks)}))
                    await store.revoke_device(device.public_bytes)
                    await read(401); self.assertEqual(len(handled), 17)
                    await store.add_device(device_pubkey=device.public_bytes, user_handle='alice')
                    await read(); self.assertEqual(len(handled), 18)
                    await coordinator.stop()
                    await read(503); self.assertEqual(len(handled), 18)
            finally:
                if proxy: await proxy.stop()
                if dialer: await dialer.close()
                if client: await client.stop()
                if runner: await runner.cleanup()
                if member: await member.stop()
                await coordinator.stop()
                await member_db.close(); await coordinator_db.close()
