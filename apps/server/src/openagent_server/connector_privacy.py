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
    def __init__(self, store, *, sinks=(), covered_surfaces=frozenset()):
        self.store, self.sinks = store, tuple(sinks)
        self.covered_surfaces = frozenset(covered_surfaces)

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
            progress = await self.store.process(request_id,self.sinks,covered_surfaces=self.covered_surfaces)
            completed = completed and progress.status == 'complete'
        return 'complete' if completed else 'blocked'
