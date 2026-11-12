"""File accepted tool messages in the verified recipient conversation."""
from __future__ import annotations

import logging

from openagent_core.deliveries import ConfirmedDelivery
from openagent_core.contracts import ResourceRef
from openagent_core.runtime import current_execution_context, current_run_id, current_runtime
from openagent_channel_bridges.contracts import BridgeContext
from openagent_channel_bridges.base import _legacy_session_hint

logger = logging.getLogger(__name__)


class MessagingDeliveryRecorder:
    def __init__(self, pool, values):
        self.pool, self.values = pool, values

    async def record(self, provider, destination, text, receipt):
        if not isinstance(receipt, dict):
            return receipt
        if provider == "telegram" and receipt.get('ok') is not True:
            return receipt
        if provider == "whatsapp" and not isinstance(receipt.get('idMessage'), str):
            return {**receipt, "openagent_session": {"recorded": False, "message_sent": False,
                    "notice": "The provider did not acknowledge this message."}}
        try:
            saved = await self._record(provider, destination, text, receipt)
        except Exception as exc:
            # The provider already accepted the effect. A recording failure
            # must never claim it was unsent and encourage a duplicate send.
            logger.warning("Accepted messaging delivery needs history reconciliation (%s)", type(exc).__name__)
            saved = {"recorded": False, "message_sent": True,
                     "notice": "Message sent; conversation recording is unavailable. Do not resend."}
        return {**receipt, "openagent_session": saved}

    async def _record(self, provider, destination, text, receipt):
        gateway = getattr(self.pool, 'gateway_runtime', None)
        service = getattr(gateway, 'runtime_service', None)
        runtime = current_runtime()
        origin = current_execution_context()
        if service is None or runtime is not service.runtime or origin is None:
            raise PermissionError('No admitted messaging host')
        if not text:
            raise ValueError('A delivered message requires visible text')
        if provider == 'telegram':
            message = receipt.get('result') or {}
            chat = message.get('chat') or {}
            sender = message.get('from') or {}
            account, conversation, event = str(sender.get('id') or ''), str(chat.get('id') or ''), str(message.get('message_id') or '')
            if chat.get('type') != 'private' or not account or not conversation or not event:
                raise PermissionError('A verified private Telegram receipt is required')
            requested = str(destination)
            if requested.startswith('@'):
                if requested[1:].lower() != str(chat.get('username') or '').lower():
                    raise PermissionError('Telegram receipt belongs to another destination')
            elif requested != conversation:
                raise PermissionError('Telegram receipt belongs to another destination')
            actor, hint = conversation, 'tg:' + conversation
            sent_at = int(message.get('date') or 0) * 1000
            text = message.get('text') or message.get('caption') or text
        elif provider == 'whatsapp':
            account = str(self.values.get('GREEN_API_ID') or '')
            conversation = str(destination)
            event = str(receipt.get('idMessage') or '')
            if not account or not event or not conversation.endswith('@c.us'):
                raise PermissionError('A private WhatsApp receipt is required')
            actor = conversation.removesuffix('@c.us')
            hint, sent_at = 'wa:' + actor, 0
        else:
            raise PermissionError('This destination needs an attested channel mapping')
        bridges = getattr(gateway, '_bridges', ())
        bridge = next((bridge for bridge in bridges if bridge.name == provider and
            ((provider == 'telegram' and bridge.token == self.values.get('TELEGRAM_BOT_TOKEN')) or
             (provider == 'whatsapp' and str(bridge.instance_id) == account and bridge.api_token == self.values.get('GREEN_API_TOKEN')))), None)
        if bridge is None:
            raise PermissionError('No matching configured bot account')
        if provider == 'telegram' and getattr(bridge, '_context_bot', None) is None:
            bot = getattr(getattr(bridge, '_app', None), 'bot', None)
            if bot is None or str(bot.id) != account:
                raise PermissionError('The Telegram account is not initialized')
            bridge._context_bot = bot
        external = BridgeContext(bridge.binding_id, provider, account, actor, conversation, event,
                                 conversation_kind='direct')
        external = await bridge.attest_context(external)
        if external.audience_complete is not True or external.audience_ids != (actor,):
            raise PermissionError('The complete delivery recipient is not attested')
        transport = bridge.transport
        resolve = getattr(transport, '_execution', None)
        if callable(resolve):
            context = await resolve(external)
        else:
            token = _legacy_session_hint.set(hint)
            try:
                session_id = transport._session_for_context(external)
            finally:
                _legacy_session_hint.reset(token)
            context = await service.authorizer.context_for_bridge_delivery(provider, session_id)
        if context.tenant_id != origin.tenant_id:
            raise PermissionError('Recipient belongs to another network')
        # Revalidate source and destination independently. The source's device
        # or scheduler identity never becomes the recipient's session owner.
        await runtime.authorize(origin, 'run.publish', ResourceRef(
            'session', origin.tenant_id, origin.session_id), audience=origin.audience)
        delivery = ConfirmedDelivery(provider, account, conversation, event, text, sent_at)
        result = await runtime.record_delivery(delivery, context, source_run_id=current_run_id())
        gateway.broadcast_session('updated', context.session_id)
        return {**result, 'session_id': context.session_id}
