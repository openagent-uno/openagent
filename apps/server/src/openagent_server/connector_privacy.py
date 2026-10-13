"""Product adapter from authenticated broker receipts to public Core privacy APIs.

The processor does not authenticate network payloads: it receives only the
immutable, encrypted receipt already validated by the shared runner and committed
by OfficialConnectors. No model arguments can choose provider/store/generation.
Canonical sink coverage is explicit and defaults to none. Never enroll Shopify
merely because this bridge is available.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib

from openagent_core.content_privacy import PrivacyRequest


def grant_generation(value: str) -> int:
    timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if timestamp.tzinfo is None:
        raise ValueError('An authenticated occurrence timestamp is required')
    # Avoid token-version coupling: one generation identifies the original
    # verified consent timestamp. Integer arithmetic preserves microseconds.
    elapsed = timestamp - datetime(1970,1,1,tzinfo=timezone.utc)
    return (elapsed.days * 86400 + elapsed.seconds) * 1_000_000 + elapsed.microseconds


def _provider_id(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError('A provider-validated numeric identity is required')
    identifier = str(value)
    if not identifier.isascii() or not identifier.isdecimal() or not 0 < int(identifier) < 2**64:
        raise ValueError('A provider-validated numeric identity is required')
    return str(int(identifier))


class ConnectorPrivacyProcessor:
    def __init__(self, store, *, sinks=(), covered_surfaces=frozenset(), exports=None, prepare=None):
        self.store, self.sinks = store, tuple(sinks)
        self.covered_surfaces = frozenset(covered_surfaces)
        self.exports, self.prepare = exports, prepare

    async def process(self, receipt, connections):
        topic = receipt['topic']
        if topic == 'app/uninstalled':
            # Immediate credential disconnection is performed atomically by the
            # host receiver. Shopify's later shop/redact carries the data-erasure
            # mandate; uninstall must not erase newer reauthorized content.
            return 'credential_revoked'
        if topic not in {'shop/redact', 'customers/redact', 'customers/data_request'}:
            return 'blocked'
        subjects = ()
        payload = receipt['payload']
        if topic.startswith('customers/'):
            customer = payload.get('customer')
            if not isinstance(customer, dict):
                raise ValueError('Customer privacy receipt has no verified identity')
            values = ['customer:'+_provider_id(customer.get('id'))]
            order_key = 'orders_to_redact' if topic == 'customers/redact' else 'orders_requested'
            orders = payload.get(order_key, [])
            if not isinstance(orders,list) or len(orders)>4096:
                raise ValueError('Customer privacy order selection exceeds its bound')
            values.extend('order:'+_provider_id(order) for order in orders)
            subjects = tuple(sorted(set(values)))
        cutoff = grant_generation(receipt['occurred_at'])
        scopes = {(row['tenant_id'],row['app_id']) for row in connections
                  if row.get('provider') == 'shopify' and row.get('app_id')
                  and row.get('group_id') == receipt['group']}
        if not scopes:
            # A missing historical recipient is not proof there is no derived
            # content. Keep the durable receipt for repair/legacy reconciliation.
            return 'blocked'
        completed = True
        for tenant, app_id in sorted(scopes):
            request_id = hashlib.sha256((receipt['id']+'\0'+tenant+'\0'+app_id).encode()).hexdigest()
            request = PrivacyRequest(request_id,tenant,'shopify/'+app_id,receipt['group'],cutoff,
                                     'export' if topic=='customers/data_request' else 'redact', subjects)
            await self.store.enqueue(request)
            if self.prepare is not None and (await self.store.progress(request_id)).status != 'complete':
                # Enqueue installs the source fence first. Cache draining is
                # a real host action, and its failure must retain the job.
                await self.prepare(request)
            progress = await self.store.process(request_id,self.sinks,covered_surfaces=self.covered_surfaces)
            done = progress.status == 'complete'
            if request.operation == 'export' and done:
                # Canonical staging completion is not delivery. Export data
                # stays encrypted locally until the current owner retrieves
                # and acknowledges the authorized delivery through product API.
                done = bool(self.exports is not None and await self.exports.seal(request)
                            and await self.exports.delivered(request_id))
            completed = completed and done
        return 'complete' if completed else 'blocked'


def install_local_privacy(service, runtime, *, covered_surfaces=frozenset()):
    """Bind the host-owned encrypted spool to public canonical Core services.

    Called before admission. Coverage is supplied by product assembly only
    after its writers/fences and legacy-data checks have been qualified.
    """
    import os
    # Fail startup for an opted-in installation with an older public SDK.
    # Continuing without source callbacks would lose the required provenance.
    from openagent_connectors.privacy import invocation_selection, result_fragments
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from openagent_core.content_privacy import (
        ToolResultPrivacyPublisher, EngineContentPrivacyWriter, SessionJournalPrivacyWriter)
    from openagent_core.session_control import SessionControl
    from openagent_storage_sqlite.content_privacy import SqliteContentPrivacyStore
    from openagent_storage_sqlite.runtime_privacy import SqliteToolResultPrivacyPublisher, SqliteRuntimeContentPrivacySink
    from openagent_storage_sqlite.engine_privacy import SqliteEngineContentPrivacy
    from openagent_storage_sqlite.journal_privacy import SqliteSessionJournalContentPrivacy
    from openagent_storage_sqlite.privacy_exports import EncryptedPrivacyExports
    from openagent_storage_sqlite.search import SqliteOperationalSearchPrivacy
    canonical = runtime.services.store
    ledger = SqliteContentPrivacyStore(canonical.path)
    publisher = SqliteToolResultPrivacyPublisher(canonical, ledger)
    class Cipher:
        def encrypt(self, aad, value):
            nonce = os.urandom(12)
            return nonce + AESGCM(service.key).encrypt(nonce, value, aad)
        def decrypt(self, aad, value):
            return AESGCM(service.key).decrypt(value[:12], value[12:], aad)
    async def authorize(request, context):
        await service.check(context)
        if context.tenant_id != request.tenant_id or context.audience != (context.initiator,):
            return False
        import aiosqlite
        # These are product-owned connection identities, including disconnected
        # historical recipients. Core content/schema is never queried here.
        async with aiosqlite.connect(service.db_path) as db:
            rows = await (await db.execute('''SELECT app_id FROM official_connector_connections
                WHERE tenant_id=? AND owner_key=? AND provider='shopify' AND group_id=?''',
                (context.tenant_id, context.initiator.key, request.group_id))).fetchall()
        return any(request.source_id == 'shopify/' + row[0] for row in rows if row[0])
    async def authorize_revision(request, revision, context):
        if not await authorize(request, context):
            return False
        try:
            # A later export may include an earlier encrypted copy. Resolve
            # exact immutable parents with a strict bound, never a caller label.
            for _ in range(16):
                if revision.sink_id != 'privacy-export-spool':
                    resource = await publisher.resource_for_revision(revision)
                    await runtime.authorize(context, 'run.read', resource, audience=context.audience)
                    return True
                revision = await exports.source_for_revision(revision)
        except PermissionError:
            return False
        return False
    exports = EncryptedPrivacyExports(service.db_path.parent / 'connector-privacy-exports.sqlite',
                                     ledger, cipher=Cipher(), authorize=authorize,
                                     authorize_revision=authorize_revision)
    search = SqliteOperationalSearchPrivacy(canonical, service.agent.memory_db)
    run_sink = SqliteRuntimeContentPrivacySink(canonical, ledger, export=exports.export, search_privacy=search)
    engine_sink = SqliteEngineContentPrivacy(canonical, ledger, publisher, export=exports.export, search_privacy=search)
    journal_sink = SqliteSessionJournalContentPrivacy(canonical, ledger, publisher, export=exports.export)
    runtime.services.registry.bind(ToolResultPrivacyPublisher, publisher)
    runtime.services.registry.bind(EngineContentPrivacyWriter, engine_sink)
    runtime.services.registry.bind(SessionJournalPrivacyWriter, journal_sink)
    async def prepare(request):
        if request.operation == 'redact':
            control = SessionControl(service.agent)
            for session_id in await publisher.sessions_for_request(request):
                await control.invalidate_context(session_id)
    processor = ConnectorPrivacyProcessor(ledger, sinks=(run_sink, engine_sink, journal_sink, exports),
                                          exports=exports, prepare=prepare, covered_surfaces=covered_surfaces)
    processor.publisher = publisher
    service.privacy_processor = processor
    return publisher
