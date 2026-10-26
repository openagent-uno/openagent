from types import SimpleNamespace
import pytest
from openagent_core.core.public_errors import PUBLIC_MESSAGES
from openagent_server.public_run_errors import public_run_error, public_run_response

@pytest.mark.parametrize('code',['provider_not_configured','model_not_configured','auth','auth_expired','quota_exhausted','rate_limit','context_length','budget_exhausted'])
def test_ui_native_and_replayed_failure_use_only_public_category(code):
 record=SimpleNamespace(status='failed',output={'error_code':code,'error_public':'PRIVATE-KEY provider JSON','message':'PRIVATE-TOKEN'})
 error=public_run_error(record)
 assert error.code==code
 assert str(error)==PUBLIC_MESSAGES[code]
 assert public_run_response(record)==PUBLIC_MESSAGES[code]
 assert 'PRIVATE' not in str(error)

@pytest.mark.parametrize('output',[None,'PRIVATE-TOKEN',{'error_code':'PRIVATE-KEY','error_public':'PRIVATE-TOKEN'}])
def test_unknown_failure_cannot_publish_diagnostics(output):
 assert str(public_run_error(SimpleNamespace(status='failed',output=output)))==PUBLIC_MESSAGES['generic']

def test_timeout_is_not_reported_as_bad_credentials():
 assert public_run_error(SimpleNamespace(status='timed_out',output=None)).code=='timeout'
