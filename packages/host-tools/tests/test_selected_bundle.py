from pathlib import Path
import json
import os
import shlex
import sys
from unittest.mock import patch

import pytest
from openagent_host_tools import CapabilityHost, HostPaths


@pytest.mark.asyncio
async def test_explicit_bundle_uses_only_selected_tools_without_sidecar_discovery(tmp_path: Path):
    with patch('openagent_host_tools.host.discover_sidecars', side_effect=AssertionError('unselected sidecars must not be discovered')):
        host = CapabilityHost(paths=HostPaths(tmp_path/'profile'),cwd=tmp_path,builtin_names=('shell',),
                              process_environment={'PATH':os.defpath,'HOME':str(tmp_path)})
        try:
            await host.start()
            await host.set_consent(True)
            assert [server['name'] for server in await host.catalog()] == ['shell']
            command = shlex.quote(sys.executable)+" -c "+shlex.quote("import os,json; print(json.dumps(dict(os.environ)))")
            with patch.dict(os.environ, {'PRIVATE_FIXTURE_CREDENTIAL':'must-not-cross'}):
                result = await host.call('shell','shell_exec',{'command':command},principal='fixture',idempotency_key='environment')
            assert not result.is_error
            encoded = json.dumps(result.to_wire())
            assert 'must-not-cross' not in encoded
            assert 'PRIVATE_FIXTURE_CREDENTIAL' not in encoded
        finally:
            await host.close()


def test_invalid_duplicate_bundle_is_rejected_before_io(tmp_path: Path):
    for selection in (('shell','shell'), ('unknown',)):
        with pytest.raises(ValueError):
            CapabilityHost(paths=HostPaths(tmp_path/'uncreated'),builtin_names=selection)
        assert not (tmp_path/'uncreated').exists()
