"""Opt-in continuity never aliases another account, actor, group or forum."""
from dataclasses import replace
import pytest
from openagent_channel_bridges.contracts import BridgeContext
from openagent_channel_bridges.base import _legacy_session_hint
from openagent_server.bridges.gateway_transport import GatewayBridgeTransport
from openagent_server.bridges.session_identity import LegacyPrivateSessions
from openagent_server.bridges.telegram import TelegramBridge


def policy():
    return {'version':1,'binding_id':'telegram','account_id':'900','actor_ids':['101']}


def context():
    return BridgeContext('telegram','telegram','900','101','101','event',conversation_kind='direct')


def test_default_identity_stays_scoped_and_migration_is_explicit():
    transport = GatewayBridgeTransport()
    current = context()
    scoped = transport._session_for_context(current)
    assert scoped != 'tg:101'
    transport.configure_legacy_private_sessions(policy())
    assert transport._session_for_context(current) == 'tg:101'
    assert transport._session_for_context(replace(current,event_id='after-restart',audience_verified_at=4*86400)) == 'tg:101'
    assert transport._session_for_context(replace(current,actor_id='102',conversation_id='102')) != 'tg:101'


def test_same_actor_on_other_account_or_binding_is_not_aliased():
    migration = LegacyPrivateSessions.from_config(policy())
    for change in ({'account_id':'901'},{'binding_id':'other'},{'provider':'discord'}):
        with pytest.raises(PermissionError):
            migration.resolve(replace(context(),**change),None)
    for change in ({'conversation_kind':'group'},{'conversation_kind':'thread','thread_id':'topic'}, {'conversation_id':'102'}):
        assert migration.resolve(replace(context(),**change),None) is None


def test_exact_legacy_children_are_retained_but_other_actor_selectors_denied():
    transport = GatewayBridgeTransport(); transport.configure_legacy_private_sessions(policy())
    token = _legacy_session_hint.set('tg:101:explicit-new')
    try:
        assert transport._session_for_context(context()) == 'tg:101:explicit-new'
        _legacy_session_hint.set('tg:102')
        with pytest.raises(PermissionError):transport._session_for_context(context())
    finally:_legacy_session_hint.reset(token)


@pytest.mark.parametrize('change',[{'version':True},{'version':2},{'account_id':'900:secret'}, {'actor_ids':['101','101']},{'actor_ids':[101]}, {'extra':True}])
def test_malformed_operator_policy_is_rejected(change):
    with pytest.raises(ValueError):LegacyPrivateSessions.from_config(policy()|change)


def test_standalone_constructor_binds_the_exact_account_and_factory_configuration():
    bridge = TelegramBridge('900:synthetic',allowed_users=['101'],legacy_private_sessions=policy(),live=False)
    assert bridge.transport._session_for_context(context()) == 'tg:101'
    with pytest.raises(ValueError):TelegramBridge('901:synthetic',legacy_private_sessions=policy())


def test_normal_server_factory_passes_only_the_operator_configuration():
    from openagent_server.server import _build_bridges
    config = {'channels':{'telegram':{'token':'900:synthetic','allowed_users':['101'],
                                    'legacy_private_sessions':policy()}}}
    bridges = _build_bridges(config, {'telegram':'ws://127.0.0.1:1/ws'})
    assert len(bridges) == 1
    assert bridges[0].transport._session_for_context(context()) == 'tg:101'
