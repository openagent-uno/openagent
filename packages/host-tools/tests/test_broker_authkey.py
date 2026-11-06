from openagent_host_tools.local_broker import _load_or_create_authkey
from openagent_host_tools.paths import HostPaths


def test_binary_authkey_roundtrip_preserves_line_feed_bytes(tmp_path, monkeypatch):
    secret = b"\n\r\x1a\x00" * 8
    monkeypatch.setattr("openagent_host_tools.local_broker.secrets.token_bytes", lambda size: secret)
    paths = HostPaths.discover(tmp_path)
    assert _load_or_create_authkey(paths) == secret
    assert paths.broker_authkey.read_bytes() == secret
    assert _load_or_create_authkey(paths) == secret
