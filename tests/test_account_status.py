"""Each serving account says whether it works, is rate-limited, or needs a new sign-in."""
from openagent_server.gateway.api.accounts import _normalise_account, account_status, provider_status

NOW = 1_800_000_000_000


def test_a_revoked_sign_in_reads_as_expired_not_as_a_limit():
    raw = {"id": "a", "limited": True, "last_error": 'HTTP 401: {"code": "refresh_token_invalidated"}'}
    assert account_status(raw, NOW) == "auth_expired"
    assert account_status({"id": "b", "expires_at_ms": NOW - 1, "has_refresh_token": False}, NOW) == "auth_expired"


def test_a_limit_that_has_not_ended_is_rate_limited():
    assert account_status({"id": "a", "limited": True, "limited_until_ms": NOW + 60_000}, NOW) == "rate_limited"
    assert account_status({"id": "a", "limited": True, "limited_until_ms": NOW - 1}, NOW) == "ok"


def test_the_error_text_is_used_only_to_classify():
    out = _normalise_account({"id": "a", "last_error": "session has ended, secret-ish detail"}, NOW)
    assert out["status"] == "auth_expired" and "last_error" not in out


def test_provider_status_is_the_best_account_state():
    assert provider_status({"reachable": False, "accounts": []}) == "unreachable"
    assert provider_status({"reachable": True, "accounts": [{"status": "auth_expired"}, {"status": "ok"}]}) == "ok"
    assert provider_status({"reachable": True, "accounts": [{"status": "auth_expired"}, {"status": "rate_limited"}]}) == "rate_limited"
    assert provider_status({"reachable": True, "accounts": [{"status": "auth_expired"}]}) == "auth_expired"


async def test_native_inventory_is_bounded_parallel_and_preserves_management_capabilities():
    import asyncio,json
    from types import SimpleNamespace
    from unittest.mock import AsyncMock,patch
    import httpx
    from openagent_server.gateway.api.accounts import handle_list
    providers=[{'id':i,'name':'fixture-'+str(i),'enabled':True,
                'metadata':{'access':'subscription','subscription_remote':True}} for i in range(1,10)]
    active=0; maximum=0
    async def subscription(context,pid,operation):
        nonlocal active,maximum
        if operation=='capabilities':return {'sign_in':pid%2==1}
        active+=1;maximum=max(maximum,active)
        try:
            await asyncio.sleep(.02)
            if pid==3:raise httpx.ConnectError('private upstream diagnostic')
            return [{'id':str(pid),'name':'Account '+str(pid),'enabled':True}]
        finally:active-=1
    admin=SimpleNamespace(subscription=subscription)
    request=SimpleNamespace(app={'gateway':SimpleNamespace(agent=SimpleNamespace(memory_db=SimpleNamespace(list_providers=AsyncMock(return_value=providers))))})
    with patch('openagent_server.provider_management.for_request',AsyncMock(return_value=(admin,object()))):
        response=await handle_list(request)
    entries=json.loads(response.text)['providers']
    assert [e['provider_id'] for e in entries]==list(range(1,10))
    assert maximum==4
    assert entries[0]['sign_in'] is True and entries[1]['sign_in'] is False
    assert entries[2]['reachable'] is False and entries[2]['sign_in'] is False
    assert 'private upstream diagnostic' not in response.text
