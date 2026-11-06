"""Persisted heads cannot point at absent definitions; reads never guess."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openagent_core.memory.db import MemoryDB
from openagent_core.memory.operational.access import AccessContext
from openagent_dashboards.migration import ensure_custom_views_storage
from openagent_dashboards.repository import CustomViewRepository, CustomViewRevisionUnavailable, CustomViewNotFound
from openagent_server.gateway.api.custom_views import _map_error


class RevisionIntegrityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = MemoryDB(str(Path(self.temp.name) / 'state.sqlite3'))
        async def migrate(conn):
            await ensure_custom_views_storage(conn, app_version='test')
        self.db.add_migration(migrate)
        await self.db.connect()
        self.conn = await self.db._ensure_connected()
        self.repo = CustomViewRepository(self.db)
        self.access = AccessContext('tenant','user:alice','user','alice','device',
            frozenset({'user:alice'}),frozenset({('user','user:alice')}))
        self.view = await self.repo.create(self.access, surface='sidebar', title='Dashboard',
            markup='<text>Hello</text>',
            sources={'seed': {'driver':'static','config':{'value':{'count':7}}}})

    async def asyncTearDown(self):
        await self.db.close()
        self.temp.cleanup()

    async def test_database_rejects_a_head_without_its_revision(self):
        with self.assertRaises(sqlite3.IntegrityError):
            await self.conn.execute('UPDATE ui_views SET latest_revision=2 WHERE id=?', (self.view['id'],))
        await self.conn.rollback()
        self.assertEqual((await self.repo.get(self.view['id'], self.access))['revision'], 1)

    async def test_update_source_and_reactivation_publish_complete_revisions(self):
        view = await self.repo.update(self.view['id'], self.access, expected_revision=1, title='Updated')
        self.assertEqual(view['revision'],2)
        await self.repo.configure_source(view['id'],'seed',{'driver':'static','config':{'value':8}}, self.access, expected_revision=2)
        self.assertEqual((await self.repo.get(view['id'],self.access))['revision'],3)
        await self.repo.reactivate(view['id'],self.access,expected_revision=3)
        self.assertEqual((await self.repo.get(view['id'],self.access))['revision'],4)
        self.assertEqual((await (await self.conn.execute('SELECT count(*) FROM ui_view_revisions WHERE view_id=?',(view['id'],))).fetchone())[0],4)

    async def test_legacy_missing_head_is_diagnosed_without_rewriting_data_or_disclosing_existence(self):
        await self.conn.execute('DROP TRIGGER ui_views_revision_head_guard')
        await self.conn.execute('UPDATE ui_views SET latest_revision=2 WHERE id=?',(self.view['id'],))
        await self.conn.commit()
        # Restart migration installs the guard, preserving historical state.
        await ensure_custom_views_storage(self.conn,app_version='test')
        with self.assertRaises(CustomViewRevisionUnavailable) as raised:
            await self.repo.get(self.view['id'],self.access)
        response = _map_error(raised.exception)
        self.assertEqual(response.status,503)
        self.assertEqual(json.loads(response.body)['error']['code'],'ui_revision_unavailable')
        outsider=AccessContext('tenant','user:bob','user','bob','other',frozenset({'user:bob'}),frozenset({('user','user:bob')}))
        with self.assertRaises(CustomViewNotFound):
            await self.repo.get(self.view['id'],outsider)
        row=await (await self.conn.execute('SELECT latest_revision FROM ui_views WHERE id=?',(self.view['id'],))).fetchone()
        self.assertEqual(row[0],2)
        self.assertEqual((await self.repo.get(self.view['id'],self.access,revision=1))['revision'],1)

    async def test_damaged_bundle_has_safe_recovery_error(self):
        folder=self.repo.bundles.revision_path(self.view['id'],1)
        (folder/'compiled.json').write_text('PRIVATE-SERVER-PATH')
        with self.assertRaises(CustomViewRevisionUnavailable) as raised:
            await self.repo.get(self.view['id'],self.access)
        response=_map_error(raised.exception)
        self.assertEqual(response.status,503)
        self.assertNotIn('PRIVATE',response.body.decode())
