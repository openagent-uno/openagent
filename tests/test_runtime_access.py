from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from openagent_core.contracts import ExecutionContext, PrincipalRef, ResourceRef, RunRequest
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.runtime_access import NativeRuntimeAuthorizer


class Request(dict):
    def __init__(self, gateway, handle):
        certificate = SimpleNamespace(network_id="network", handle=handle,
                                      device_pubkey_hex=f"device-{handle}", capabilities=())
        super().__init__(device_cert=certificate, network_id="network", user_handle=handle,
                         client_id=f"device-{handle}", auth_kind="device_cert", device_auth_epoch=1)
        self.app = {"gateway": gateway}


class RuntimeAccessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "state.sqlite3"
        self.store = SqliteRuntimeStore(self.path)
        await self.store.start()
        self.revoked = set()

        async def authorized(request, certificate):
            return certificate.handle not in self.revoked

        self.gateway = SimpleNamespace(agent=SimpleNamespace(name="test-agent"),
                                       _request_device_still_authorized=authorized)
        self.policy = NativeRuntimeAuthorizer(self.gateway, self.path)
        self.alice = PrincipalRef("openagent", "network", "alice")
        context = ExecutionContext(self.alice, self.alice, self.alice, "session", "test-agent", (self.alice,))
        await self.store.accept(RunRequest("seed", "session", "seed", "hello"), context)
        self.alice_identity = await self.policy.bind_request(Request(self.gateway, "alice"))
        self.bob_identity = await self.policy.bind_request(Request(self.gateway, "bob"))

    async def asyncTearDown(self):
        await self.store.close()
        self.directory.cleanup()

    async def test_other_author_cannot_borrow_the_previous_authority(self):
        alice = await self.policy.context_for_identity(self.alice_identity, "session")
        bob = await self.policy.context_for_identity(self.bob_identity, "session")
        resource = ResourceRef("session", "network", "session")
        self.assertTrue(await self.policy.authorize(alice, "run.execute", resource))
        self.assertFalse(await self.policy.authorize(bob, "run.execute", resource))
        self.assertFalse(await self.policy.authorize(replace(alice, initiator=bob.initiator), "run.read", resource))

    async def test_current_revocation_applies_to_an_already_built_context(self):
        context = await self.policy.context_for_identity(self.alice_identity, "session")
        self.revoked.add("alice")
        self.assertFalse(await self.policy.authorize(context, "run.publish", ResourceRef("session", "network", "session")))

    async def test_shared_grant_changes_result_audience_and_revocation_invalidates_it(self):
        connection = self.store.connection
        connection.execute("INSERT INTO resource_acl(tenant_id, resource_type, resource_id, principal_type, principal_id, permission, acl_version, granted_at_ms) VALUES('network','session','session','user','bob','admin',1,1)")
        context = await self.policy.context_for_identity(self.bob_identity, "session")
        self.assertEqual({p.subject_id for p in context.audience}, {"alice", "bob"})
        resource = ResourceRef("session", "network", "session")
        self.assertTrue(await self.policy.authorize(context, "run.execute", resource))
        connection.execute("DELETE FROM resource_acl WHERE principal_id='bob'")
        self.assertFalse(await self.policy.authorize(context, "run.publish", resource))

    async def test_unknown_historical_author_is_not_reassigned(self):
        self.store.connection.execute("UPDATE sessions_v2 SET owner_principal_id='unmapped-history' WHERE id='session'")
        with self.assertRaisesRegex(PermissionError, "Historical"):
            await self.policy.context_for_identity(self.alice_identity, "session")

    async def test_reauthentication_does_not_restore_a_revoked_run_binding(self):
        old_context = await self.policy.context_for_identity(self.alice_identity, "session")
        async def authorized(request, certificate):
            return request.get("device_auth_epoch") == 2
        self.gateway._request_device_still_authorized = authorized
        request = Request(self.gateway, "alice")
        request["device_auth_epoch"] = 2
        identity = await self.policy.bind_request(request)
        new_context = await self.policy.context_for_identity(identity, "session")
        resource = ResourceRef("session", "network", "session")
        self.assertNotEqual(old_context.ingress_id, new_context.ingress_id)
        self.assertFalse(await self.policy.authorize(old_context, "run.publish", resource))
        self.assertTrue(await self.policy.authorize(new_context, "run.execute", resource))

    async def test_unknown_capability_does_not_inherit_session_write_permission(self):
        context = await self.policy.context_for_identity(self.alice_identity, "session")
        self.assertFalse(await self.policy.authorize(context, "tool.call", ResourceRef("tool", "network", "personal-mail/read")))


if __name__ == "__main__":
    unittest.main()
