from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from test_channel_agent_identity import owner_channel, SENDER
from openagent_core import SessionRef
from openagent_core import RunRequest
from openagent_core.runtime import execution_scope
from openagent_server.bridges.telegram import TelegramBridge
from openagent_server.messaging_tools.adapters import build_runtime_toolkit


@pytest.mark.parametrize('owner_channel', ['telegram'], indirect=True)
async def test_accepted_telegram_tool_message_is_filed_once_in_the_same_reply_session(owner_channel):
    f = owner_channel
    broadcasts = []
    f.gateway.broadcast_session = lambda action, sid: broadcasts.append((action, sid))
    bridge = TelegramBridge('123456:fixture', allowed_users=[SENDER])
    bridge._context_bot = SimpleNamespace(id=123456,
        get_chat=AsyncMock(return_value=SimpleNamespace(id=int(SENDER), type='private')))
    f.gateway._bridges = [bridge]
    pool = SimpleNamespace(agent_runtime=f.agent, gateway_runtime=f.gateway)
    toolkit = build_runtime_toolkit(pool=pool, env={'TELEGRAM_BOT_TOKEN': '123456:fixture'})
    receipt = {'ok': True, 'result': {'message_id': 80, 'date': 1_700_000_000,
        'from': {'id': 123456}, 'chat': {'id': int(SENDER), 'type': 'private'}, 'text': 'Delivery violet-27'}}
    await f.service.runtime.start()
    try:
        with patch('openagent_server.messaging_tools.adapters._json_post', new=AsyncMock(return_value=receipt)) as send:
            with execution_scope(f.service.runtime, f.context, 'seed'):
                result = await toolkit.async_functions['telegram_send_message'].entrypoint(chat_id=SENDER, text='Delivery violet-27')
            send.assert_awaited_once()
        assert result['ok'] is True and result['openagent_session']['recorded'] is True
        assert result['openagent_session']['session_id'] == f.context.session_id
        reference = SessionRef('openagent', 'network', 'Friday', f.context.session_id)
        page = await f.store.read_session(reference, f.context, limit=100)
        delivered = [message for message in page['messages'] if message['text'] == 'Delivery violet-27']
        assert len(delivered) == 1 and delivered[0]['role'] == 'assistant'
        assert broadcasts == [('updated', f.context.session_id)]
    finally:
        await bridge.stop()
        await f.service.runtime.close()


@pytest.mark.parametrize('owner_channel', ['telegram'], indirect=True)
async def test_history_failure_never_reports_an_accepted_send_as_unsent(owner_channel):
    f = owner_channel
    toolkit = build_runtime_toolkit(pool=SimpleNamespace(gateway_runtime=f.gateway),
                                    env={'TELEGRAM_BOT_TOKEN': '123456:fixture'})
    receipt = {'ok': True, 'result': {'message_id': 81, 'chat': {'id': int(SENDER), 'type': 'private'}}}
    with patch('openagent_server.messaging_tools.adapters._json_post', new=AsyncMock(return_value=receipt)) as send:
        result = await toolkit.async_functions['telegram_send_message'].entrypoint(chat_id=SENDER, text='already sent')
    send.assert_awaited_once()
    assert result['ok'] is True and result['openagent_session']['message_sent'] is True
    assert result['openagent_session']['recorded'] is False
    assert 'Do not resend' in result['openagent_session']['notice']


@pytest.mark.parametrize('owner_channel', ['telegram'], indirect=True)
async def test_proactive_tool_message_returns_to_recipient_chat_instead_of_the_job_session(owner_channel):
    f = owner_channel
    f.gateway.broadcast_session = lambda *_: None
    bridge = TelegramBridge('123456:fixture', allowed_users=[SENDER])
    bridge._context_bot = SimpleNamespace(id=123456,
        get_chat=AsyncMock(return_value=SimpleNamespace(id=int(SENDER), type='private')))
    f.gateway._bridges = [bridge]
    toolkit = build_runtime_toolkit(pool=SimpleNamespace(gateway_runtime=f.gateway),
                                    env={'TELEGRAM_BOT_TOKEN': '123456:fixture'})
    source = await f.service.authorizer.context_for_identity(f.actor, 'scheduled-fixture')
    await f.store.accept(RunRequest('scheduled-source', source.session_id, 'scheduled-source', 'scheduled fixture'), source)
    receipt = {'ok': True, 'result': {'message_id': 82, 'date': 1_700_000_002, 'from': {'id': 123456},
                'chat': {'id': int(SENDER), 'type': 'private'}, 'text': 'Scheduled fixture reminder'}}
    await f.service.runtime.start()
    try:
        with patch('openagent_server.messaging_tools.adapters._json_post', new=AsyncMock(return_value=receipt)):
            with execution_scope(f.service.runtime, source, 'scheduled-source'):
                result = await toolkit.async_functions['telegram_send_message'].entrypoint(chat_id=SENDER, text='Scheduled fixture reminder')
        assert result['openagent_session']['recorded'] is True
        assert result['openagent_session']['session_id'] == f.context.session_id
        assert result['openagent_session']['session_id'] != source.session_id
    finally:
        await bridge.stop()
        await f.service.runtime.close()
