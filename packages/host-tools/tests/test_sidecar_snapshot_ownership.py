"""Release catalog checks must be complete and leave installed SDK files immutable."""
import copy
import importlib.util
import json
from pathlib import Path
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/snapshot_sidecar_manifests.py"
spec = importlib.util.spec_from_file_location("owned_sidecar_snapshot", SCRIPT)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


def test_default_capture_belongs_to_product_source():
    assert snapshot.SNAPSHOT == snapshot.ROOT / "src/openagent_host_tools/sidecar-manifests.json"
    assert snapshot._capture_destination(None).is_relative_to(snapshot.ROOT)


def test_capture_writes_owned_source_and_never_installed_package(tmp_path, monkeypatch):
    installed = tmp_path / "site-packages"
    installed.mkdir()
    sdk_file = installed / "sidecar-manifests.json"
    sdk_file.write_text("immutable-public-sdk")
    owned = tmp_path / "owned-source.json"
    monkeypatch.setattr(snapshot, "SNAPSHOT", owned)
    monkeypatch.setattr(snapshot.site, "getsitepackages", lambda: [str(installed)])
    monkeypatch.setattr(snapshot.site, "getusersitepackages", lambda: str(installed))
    async def probe(bundle):
        return {"owned": {"tools": []}}
    monkeypatch.setattr(snapshot, "_probe", probe)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), str(tmp_path)])
    snapshot.main()
    assert json.loads(owned.read_text()) == {"owned": {"tools": []}}
    assert sdk_file.read_text() == "immutable-public-sdk"
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), str(tmp_path), "--output", str(sdk_file)])
    with pytest.raises(SystemExit, match="must not modify installed SDK"):
        snapshot.main()
    assert sdk_file.read_text() == "immutable-public-sdk"


def test_check_uses_materialized_dependency_contract_and_never_capture_file(tmp_path, monkeypatch):
    expected = snapshot._expected_contracts()
    monkeypatch.setattr(snapshot, "SNAPSHOT", tmp_path / "must-not-read-or-write.json")
    async def probe(bundle):
        return copy.deepcopy(expected)
    monkeypatch.setattr(snapshot, "_probe", probe)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), str(tmp_path), "--check"])
    snapshot.main()
    assert not snapshot.SNAPSHOT.exists()
    changed = copy.deepcopy(expected)
    first = next(iter(changed.values()))["tools"][0]
    first["input_schema"]["additionalProperties"] = "changed-contract"
    async def drift(bundle):
        return changed
    monkeypatch.setattr(snapshot, "_probe", drift)
    with pytest.raises(SystemExit, match="catalog drift"):
        snapshot.main()


def test_diagnostic_hash_preserves_all_protocol_fields():
    from openagent_host_tools.manifests import contract_payload, manifest_sha256
    from openagent_host_tools.types import HostMcpManifest, ToolClassification, ToolManifest
    original = HostMcpManifest("owned", "1", "owned", (
        ToolManifest("test", "owned", {"type": "object"}, ToolClassification.MUTATING,
            classification_by_argument={"action": {"read": ToolClassification.READ_ONLY}},
            metadata={"ui": {"resourceUri": "ui://owned/fixture"}}),), resource_protocol="mcp-app-resources/1")
    payload = contract_payload(original)
    assert contract_payload(snapshot._manifest_for_hash(payload)) == payload
    assert manifest_sha256(snapshot._manifest_for_hash(payload)) == manifest_sha256(original)
    for field in ("classification_by_argument", "_meta"):
        changed = copy.deepcopy(payload)
        del changed["tools"][0][field]
        assert manifest_sha256(snapshot._manifest_for_hash(changed)) != manifest_sha256(original)
    changed = copy.deepcopy(payload)
    del changed["resource_protocol"]
    assert manifest_sha256(snapshot._manifest_for_hash(changed)) != manifest_sha256(original)

@pytest.mark.parametrize('directory', ['site-packages', 'dist-packages'])
def test_capture_rejects_other_environments_before_running_probe(tmp_path, monkeypatch, directory):
    foreign = tmp_path / 'another-environment/lib/python3.12' / directory / 'sdk/snapshot.json'
    async def forbidden(bundle):
        raise AssertionError('Must reject an installed package destination before starting a peer')
    monkeypatch.setattr(snapshot, '_probe', forbidden)
    monkeypatch.setattr(sys, 'argv', [str(SCRIPT), str(tmp_path), '--output', str(foreign)])
    with pytest.raises(SystemExit, match='must not modify installed SDK'):
        snapshot.main()
    assert not foreign.exists()
