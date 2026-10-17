"""Release acquisition fails closed before trusting archive paths or binaries."""
import hashlib
import importlib.util
import io
import json
import errno
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


def test_wheel_publication_stays_on_target_filesystem(tmp_path, monkeypatch):
    source, lock = assets(tmp_path)
    wheelhouse = tmp_path / "separate-filesystem" / "wheels"
    replace = acquisition._module.os.replace
    replacements = []

    def same_filesystem_replace(src, dst):
        src, dst = Path(src), Path(dst)
        if src.parent != dst.parent:
            raise OSError(errno.EXDEV, "Cross-device link")
        assert src.stat().st_mode & 0o077 == 0
        replacements.append((src, dst))
        return replace(src, dst)

    monkeypatch.setattr(acquisition._module.os, "replace", same_filesystem_replace)
    bundle = acquisition.acquire(lock, "linux-x64", tmp_path / "verified", wheelhouse, source)
    assert bundle.is_dir()
    assert len(replacements) == 1
    wheel = wheelhouse / "openagent_connectors-0.1.0-py3-none-any.whl"
    assert wheel.read_bytes() == b"fixture-wheel-never-installed"
    assert set(wheelhouse.iterdir()) == {wheel}


def test_identical_existing_wheel_is_not_replaced(tmp_path, monkeypatch):
    source, lock = assets(tmp_path)
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    wheel = wheelhouse / "openagent_connectors-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"fixture-wheel-never-installed")
    inode = wheel.stat().st_ino

    def never_replace(*args):
        pytest.fail("Identical wheel must not be replaced")

    monkeypatch.setattr(acquisition._module.os, "replace", never_replace)
    acquisition.acquire(lock, "linux-x64", tmp_path / "verified", wheelhouse, source)
    assert wheel.stat().st_ino == inode
    assert set(wheelhouse.iterdir()) == {wheel}


def test_different_existing_wheel_is_preserved_without_bundle_promotion(tmp_path):
    source, lock = assets(tmp_path)
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    wheel = wheelhouse / "openagent_connectors-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"existing-other-wheel")
    with pytest.raises(ValueError, match="Existing connector wheel differs"):
        acquisition.acquire(lock, "linux-x64", tmp_path / "rejected", wheelhouse, source)
    assert wheel.read_bytes() == b"existing-other-wheel"
    assert set(wheelhouse.iterdir()) == {wheel}
    assert not (tmp_path / "rejected").exists()


@pytest.mark.parametrize("failure", ["partial-copy", "corrupt-copy", "fsync", "replace"])
def test_failed_wheel_publication_leaves_no_partial_wheel_or_bundle(tmp_path, monkeypatch, failure):
    source, lock = assets(tmp_path)
    wheelhouse = tmp_path / "wheels"
    copy = acquisition._module.shutil.copyfileobj

    def copying(src, dst, *args):
        if Path(dst.name).parent == wheelhouse:
            assert Path(dst.name).stat().st_mode & 0o077 == 0
            if failure == "partial-copy":
                dst.write(b"partial")
                raise OSError("Fixture copy interrupted")
            if failure == "corrupt-copy":
                dst.write(b"fixture-wheel-never-installeX")
                return
        return copy(src, dst, *args)

    def fail(*args):
        raise OSError("Fixture publication interrupted")

    monkeypatch.setattr(acquisition._module.shutil, "copyfileobj", copying)
    if failure in ("fsync", "replace"):
        monkeypatch.setattr(acquisition._module.os, failure, fail)
    with pytest.raises((OSError, ValueError)):
        acquisition.acquire(lock, "linux-x64", tmp_path / "rejected", wheelhouse, source)
    assert list(wheelhouse.iterdir()) == []
    assert not (tmp_path / "rejected").exists()
