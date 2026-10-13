"""The release closure refuses substituted artifacts before installation."""
import hashlib
import importlib.util
import io
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'prepare_public_wheels.py'
spec = importlib.util.spec_from_file_location('prepare_public_wheels', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_verified_download_preserves_exact_bytes(monkeypatch, tmp_path):
    payload = b'qualified-wheel'
    monkeypatch.setattr(module.urllib.request, 'urlopen', lambda *args, **kw: io.BytesIO(payload))
    target = tmp_path/'fixture.whl'
    actual = module.fetch('https://example.invalid/', target.name,
                          hashlib.sha256(payload).hexdigest(), target, len(payload))
    assert actual == payload == target.read_bytes()


@pytest.mark.parametrize('digest,size', [('0'*64, 15), (hashlib.sha256(b'qualified-wheel').hexdigest(), 14)])
def test_substituted_digest_or_size_leaves_no_installable_file(monkeypatch, tmp_path, digest, size):
    monkeypatch.setattr(module.urllib.request, 'urlopen', lambda *args, **kw: io.BytesIO(b'qualified-wheel'))
    target = tmp_path/'fixture.whl'
    with pytest.raises(ValueError, match='reviewed digest/size'):
        module.fetch('https://example.invalid/', target.name, digest, target, size)
    assert not target.exists()


def test_unsafe_locator_rejected_before_network(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        raise AssertionError('Network must not run for an unsafe locator')
    monkeypatch.setattr(module.urllib.request, 'urlopen', forbidden)
    with pytest.raises(ValueError, match='locator'):
        module.fetch('https://example.invalid/', '../fixture.whl', '0'*64, tmp_path/'fixture.whl')
