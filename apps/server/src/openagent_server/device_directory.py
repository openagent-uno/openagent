"""Standalone device inventory and session-use metadata; never capability authority."""
from contextlib import asynccontextmanager
import asyncio
import json
import os
from pathlib import Path
import time
import aiosqlite


class DeviceDirectory:
    def __init__(self, path):
        self.path = str(path)
        self.lock = asyncio.Lock()

    @asynccontextmanager
    async def connection(self):
        async with self.lock:
            from openagent_core.private_paths import require_private_file
            candidate=Path(self.path).absolute()
            if candidate.is_symlink():
                raise ValueError("Device metadata must be a literal private file")
            descriptor=os.open(candidate,os.O_RDWR|os.O_CREAT|getattr(os,"O_NOFOLLOW",0),0o600)
            try:
                require_private_file(descriptor)
            finally:
                os.close(descriptor)
            async with aiosqlite.connect(self.path) as db:
                db.row_factory = aiosqlite.Row
                await db.executescript('''
                    CREATE TABLE IF NOT EXISTS devices (
                        tenant TEXT NOT NULL, owner TEXT NOT NULL, device TEXT NOT NULL,
                        instance TEXT NOT NULL, label TEXT NOT NULL, modules TEXT NOT NULL,
                        last_seen REAL NOT NULL, PRIMARY KEY(tenant, owner, device, instance));
                    CREATE TABLE IF NOT EXISTS session_devices (
                        tenant TEXT NOT NULL, session TEXT NOT NULL, device TEXT NOT NULL,
                        instance TEXT NOT NULL, label TEXT NOT NULL,
                        first_used REAL NOT NULL, last_used REAL NOT NULL,
                        PRIMARY KEY(tenant, session, device, instance));
                ''')
                yield db
                await db.commit()

    async def remember(self, conn):
        if not conn.owner_handle or conn.owner_kind != 'user':
            return
        async with self.connection() as db:
            await db.execute('INSERT OR REPLACE INTO devices VALUES(?,?,?,?,?,?,?)',
                (conn.network_id, conn.owner_handle, conn.device_id, conn.client_instance_id,
                 conn.device_label, json.dumps(sorted(conn.catalog)), conn.last_seen_at))
            await db.execute('''DELETE FROM devices WHERE tenant=? AND owner=? AND device=?
                AND instance NOT IN (SELECT instance FROM devices WHERE tenant=? AND owner=? AND device=?
                                     ORDER BY last_seen DESC LIMIT 1)''',
                (conn.network_id, conn.owner_handle, conn.device_id,
                 conn.network_id, conn.owner_handle, conn.device_id))

    async def used(self, conn, session):
        if not conn.network_id:
            return
        now = time.time()
        async with self.connection() as db:
            await db.execute('''INSERT INTO session_devices VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(tenant,session,device,instance) DO UPDATE SET
                label=excluded.label,last_used=excluded.last_used''',
                (conn.network_id, session, conn.device_id, conn.client_instance_id,
                 conn.device_label, now, now))

    async def devices(self, identity, registry):
        live = {(c.device_id, c.client_instance_id): c for c in registry.owned_connections(identity)}
        async with self.connection() as db:
            rows = await (await db.execute('SELECT * FROM devices WHERE tenant=? AND owner=? ORDER BY label LIMIT 4096',
                                          (identity.tenant_id, identity.handle))).fetchall()
        # Cards represent certified devices; calls retain exact process identities.
        grouped = {}
        for row in rows:
            previous = grouped.get(row['device'])
            if previous is None or row['last_seen'] > previous['last_seen']:
                grouped[row['device']] = row
        result = []
        for device_id, row in grouped.items():
            hosts = [c for (device, _), c in live.items() if device == device_id]
            conn = max(hosts, key=lambda c: c.last_seen_at) if hosts else None
            result.append(dict(device_id=device_id, client_instance_id=conn.client_instance_id if conn else row['instance'],
                label=conn.device_label if conn else row['label'], online=bool(hosts),
                modules=sorted({name for c in hosts for name in c.catalog}) if hosts else json.loads(row['modules']),
                last_seen_at=conn.last_seen_at if conn else row['last_seen']))
        return sorted(result, key=lambda r: (not r['online'], r['label']))

    async def session_devices(self, tenant, session, registry):
        async with self.connection() as db:
            rows = await (await db.execute('SELECT * FROM session_devices WHERE tenant=? AND session=? ORDER BY first_used LIMIT 4096',
                                          (tenant, session))).fetchall()
        grouped = {}
        for row in rows:
            record = grouped.setdefault(row['device'], dict(device_id=row['device'],
                client_instance_id=row['instance'], label=row['label'],
                first_used_at=row['first_used'], last_used_at=row['last_used']))
            record['first_used_at'] = min(record['first_used_at'], row['first_used'])
            if row['last_used'] >= record['last_used_at']:
                record.update(label=row['label'], client_instance_id=row['instance'], last_used_at=row['last_used'])
        return list(grouped.values())

    async def forget_session(self, session):
        async with self.connection() as db:
            await db.execute('DELETE FROM session_devices WHERE session=?', (session,))



def directory_for(gateway):
    directory = getattr(gateway, 'device_directory', None)
    if directory is None:
        directory = gateway.device_directory = DeviceDirectory(str(gateway.agent.memory_db.db_path) + '.devices.sqlite3')
    return directory
