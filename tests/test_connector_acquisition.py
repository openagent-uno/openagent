"""Release acquisition fails closed before trusting archive paths or binaries."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "apps/server/scripts/acquire-connectors.py"
spec = importlib.util.spec_from_file_location("connector_acquisition", SCRIPT)
acquisition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acquisition)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def assets(tmp_path, malicious=None, binary_digest=None):
    source = tmp_path / "assets"
    source.mkdir()
    binary = b"fixture-binary-never-executed"
    metadata = {"format": 1, "version": "0.1.0", "platform": "linux-x64",
                "source_commit": "a" * 40, "dirty_snapshot": False,
                "files": {"bin/openagent-connector-runner": {"bytes": len(binary), "sha256": binary_digest or sha(binary)}}}
    metadata_bytes = json.dumps(metadata).encode()
    archive = source / "openagent-connectors-0.1.0-linux-x64.tar.gz"
    with tarfile.open(archive, "w:gz") as stream:
        for name, data in [("manifest.json", metadata_bytes), ("bin/openagent-connector-runner", binary)]:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            stream.addfile(member, io.BytesIO(data))
        if malicious:
            member = tarfile.TarInfo(malicious)
            member.size = 1
            stream.addfile(member, io.BytesIO(b"x"))
    wheel = source / "openagent_connectors-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"fixture-wheel-never-installed")
    file_map = {path.name: {"bytes": path.stat().st_size, "sha256": sha(path.read_bytes())} for path in (archive, wheel)}
    manifest = {"version": "0.1.0", "source_commit": "a" * 40, "dirty_snapshot": False, "files": file_map}
    manifest_bytes = json.dumps(manifest).encode()
    (source / "manifest.json").write_bytes(manifest_bytes)
    lock = {"format": 1, "version": "0.1.0", "source_ref": "connectors-v0.1.0",
            "source_repository": "openagent-uno/openagent-tools", "source_commit": "a" * 40,
            "manifest_sha256": sha(manifest_bytes), "assets": file_map,
            "platforms": {"linux-x64": {"manifest_sha256": sha(metadata_bytes)}}}
    lock_path = tmp_path / "lock.json"
    lock_path.write_text(json.dumps(lock))
    return source, lock_path


def test_pinned_acquisition_and_binary_tampering(tmp_path):
    source, lock = assets(tmp_path)
    bundle = acquisition.acquire(lock, "linux-x64", tmp_path / "verified", tmp_path / "wheels", source)
    assert (bundle / "bin/openagent-connector-runner").read_bytes() == b"fixture-binary-never-executed"
    archive = source / "openagent-connectors-0.1.0-linux-x64.tar.gz"
    archive.write_bytes(archive.read_bytes() + b"tampering")
    with pytest.raises(ValueError, match="checksum mismatch"):
        acquisition.acquire(lock, "linux-x64", tmp_path / "rejected", tmp_path / "wheels", source)
    assert not (tmp_path / "rejected").exists()


@pytest.mark.parametrize("member", ["../outside", "/absolute", "bin\\..\\outside", "C:alternate-stream"])
def test_unsafe_paths_rejected_even_in_hash_matching_archive(tmp_path, member):
    source, lock = assets(tmp_path, malicious=member)
    with pytest.raises(ValueError, match="Unsafe connector archive"):
        acquisition.acquire(lock, "linux-x64", tmp_path / "rejected", tmp_path / "wheels", source)
    assert not (tmp_path / "outside").exists()
    assert not (tmp_path / "rejected").exists()


def test_manifest_cannot_cover_changed_binary(tmp_path):
    source, lock = assets(tmp_path, binary_digest="0" * 64)
    with pytest.raises(ValueError, match="binary checksum mismatch"):
        acquisition.acquire(lock, "linux-x64", tmp_path / "rejected", tmp_path / "wheels", source)


def test_existing_bundle_is_reverified_and_tampering_or_symlinks_are_rejected(tmp_path):
    source, lock = assets(tmp_path)
    bundle = acquisition.acquire(lock, "linux-x64", tmp_path / "verified", tmp_path / "wheels", source)
    data = json.loads(lock.read_text())
    assert acquisition.verify_bundle(data, "linux-x64", bundle) == bundle
    binary = bundle / "bin/openagent-connector-runner"
    original = binary.read_bytes()
    binary.write_bytes(b"changed")
    with pytest.raises(ValueError, match="binary checksum"):
        acquisition.verify_bundle(data, "linux-x64", bundle)
    binary.unlink()
    outside = tmp_path / "outside-binary"
    outside.write_bytes(original)
    binary.symlink_to(outside)
    with pytest.raises(ValueError, match="symbolic"):
        acquisition.verify_bundle(data, "linux-x64", bundle)


def test_packaged_consumer_lock_matches_the_release_build_lock():
    packaged = SCRIPT.parents[1] / "src/openagent_server/connectors.lock.json"
    assert packaged.read_bytes() == (SCRIPT.parents[1] / "connectors.lock.json").read_bytes()
