"""Public routing contract; no provider, host identity, database or model IO."""
from dataclasses import FrozenInstanceError, asdict, replace
import hashlib
import json
from pathlib import Path

import pytest

from openagent_channel_bridges import (
    BridgeCommand, BridgeContext, BridgeMessage, BridgePart, describe_conversation,
)
from openagent_channel_bridges.wire import ArtifactStore, to_wire


def context(**changes):
    values = dict(binding_id='binding', provider='slack', account_id='team',
                  actor_id='alice', conversation_id='channel', event_id='event',
                  conversation_kind='channel', audience_ids=('bob', 'alice'),
                  audience_complete=True, audience_verified_at=1_700_000_000.0)
    return BridgeContext(**(values | changes))


def test_shared_actor_event_order_and_proof_time_do_not_fork_a_channel():
    first = context()
    second = replace(first, actor_id='bob', event_id='later',
                     audience_ids=('alice', 'bob'), audience_verified_at=1_700_000_010.0)
    assert first.conversation == second.conversation
    assert first.conversation.private_actor_id is None
    assert first.actor_id == 'alice' and second.actor_id == 'bob'
    assert first.deduplication_key != second.deduplication_key
    assert len(first.conversation.session_key.encode()) < 128


@pytest.mark.parametrize('changes', [
    {'binding_id':'binding2'}, {'provider':'discord'}, {'account_id':'team2'},
    {'conversation_id':'channel2'},
    {'conversation_kind':'thread','thread_id':'thread1'},
    {'audience_ids':('alice','bob','new')}, {'audience_ids':('alice',)},
])
def test_session_identity_isolates_binding_account_channel_thread_and_membership(changes):
    assert context().conversation.session_key != context(**changes).conversation.session_key


def test_distinct_threads_and_actor_private_direct_messages():
    a = context(conversation_kind='thread', thread_id='t1')
    assert a.conversation.mode == 'thread'
    assert a.conversation != replace(a, thread_id='t2').conversation
    assert a.conversation == replace(a, actor_id='bob').conversation
    direct = context(conversation_kind='direct', audience_ids=('alice',))
    assert direct.conversation.mode == 'private'
    assert direct.conversation.private_actor_id == 'alice'
    assert direct.conversation != replace(direct, actor_id='bob', audience_ids=('bob',)).conversation
    assert direct.conversation != replace(direct, thread_id='dm-thread').conversation


@pytest.mark.parametrize('changes', [
    {'audience_complete':False}, {'audience_verified_at':None}, {'audience_ids':()},
    {'audience_ids':('other',)}, {'conversation_kind':'unknown'},
    {'conversation_kind':'thread'}, {'thread_id':'ambiguous-channel-thread'},
    {'conversation_kind':'direct'},
])
def test_unattested_or_ambiguous_context_cannot_describe_a_resumable_session(changes):
    assert describe_conversation(context(**changes)) is None


def test_message_command_and_wire_derive_descriptor_without_caller_override():
    c = context()
    message = BridgeMessage(c, (BridgePart(text='literal untrusted history'),))
    command = BridgeCommand(c, 'status')
    assert message.conversation == command.conversation == c.conversation
    with pytest.raises(TypeError):
        BridgeMessage(c, (), conversation=replace(c.conversation, account_id='foreign'))
    with pytest.raises(FrozenInstanceError):
        message.conversation.private_actor_id = 'owner'
    store = ArtifactStore();store.begin('wire')
    try:
        wire = to_wire(message, store, 'wire')
        assert wire['context']['actor_id'] == 'alice'
        assert wire['conversation'] == asdict(c.conversation) | {'audience_ids':['alice','bob']}
        assert wire['conversation']['private_actor_id'] is None
        assert wire['context']['audience_verified_at'] == c.audience_verified_at
    finally:
        store.end('wire');store.close()


def test_utf8_framing_vectors_are_stable_and_delimiter_collision_free():
    path = Path(__file__).with_name('conversation-v1-vectors.json')
    for vector in json.loads(path.read_text()):
        actual = BridgeContext(**vector['context']).conversation
        assert asdict(actual) | {'audience_ids':list(actual.audience_ids)} == vector['conversation']
    left = context(binding_id='a:b', account_id='c')
    right = context(binding_id='a', account_id='b:c')
    assert left.conversation.session_key != right.conversation.session_key


@pytest.mark.asyncio
async def test_a_new_member_cannot_receive_an_answer_started_in_an_older_epoch():
    from openagent_channel_bridges.base import BaseBridge
    from openagent_channel_bridges.contracts import BridgeCapabilities, BridgeReply

    members = ['alice', 'bob']
    class Transport:
        async def start(self): return BridgeCapabilities()
        async def stop(self): pass
        async def authorize_context(self, value): return True
        async def authorize_delivery(self, value): return True
        async def send(self, request, *, on_event=None):
            members.append('new-recipient')
            return BridgeReply((BridgePart(text='old cohort answer'),))
    class Channel(BaseBridge):
        name = 'slack'
        async def _run(self): pass
        async def _delivery_context(self, value):
            return replace(value, audience_ids=tuple(members), audience_complete=True,
                           audience_verified_at=1_700_000_010.0)
    bridge = Channel(transport=Transport(), binding_id='binding')
    try:
        with pytest.raises(PermissionError, match='epoch changed'):
            await bridge.send_message('question', context=context())
        # New ingress starts a new epoch. Reordering the complete audience
        # does not make another epoch or lose its admitted scope.
        fresh = context(audience_ids=tuple(members))
        assert (await bridge._prepare_delivery_context(fresh)).conversation == fresh.conversation
    finally:
        await bridge.stop()
