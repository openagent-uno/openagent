#!/usr/bin/env python3
"""Acquire the consumer-pinned connector runner and Python wheel, without installing."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import urllib.request

PLATFORMS = {f"{system}-{arch}" for system in ("darwin", "linux", "win32") for arch in ("arm64", "x64")}
MAX_BYTES = 64 * 1024 * 1024


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(data)
    return value.hexdigest()


def verify_bundle(lock: dict, target: str, bundle: Path) -> Path:
    """Verify an installed immutable bundle before reuse or executable lookup."""
    if bundle.is_symlink() or any(path.is_symlink() for path in bundle.rglob("*")):
        raise ValueError("Connector bundle cannot contain symbolic links")
    if digest(bundle / "manifest.json") != lock["platforms"][target]["manifest_sha256"]:
        raise ValueError("Connector bundle manifest differs from consumer lock")
    metadata = json.loads((bundle / "manifest.json").read_text())
    if metadata.get("version") != lock["version"] or metadata.get("platform") != target or metadata.get("source_commit") != lock["source_commit"] or metadata.get("dirty_snapshot") is not False:
        raise ValueError("Connector bundle identity mismatch")
    files = metadata["files"]
    actual = {path.relative_to(bundle).as_posix() for path in bundle.rglob("*") if path.is_file() and path.name != "manifest.json"}
    if actual != set(files):
        raise ValueError("Connector bundle file set mismatch")
    for relative, entry in files.items():
        path = bundle / relative
        if path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
            raise ValueError("Connector binary checksum mismatch")
    return bundle


def acquire(lock_path: Path, target: str, output: Path, wheelhouse: Path, assets: Path | None = None) -> Path:
    lock = json.loads(lock_path.read_text())
    if target not in PLATFORMS or lock.get("format") != 1 or lock.get("source_repository") != "openagent-uno/openagent-tools" or lock.get("source_ref") != f"connectors-v{lock.get('version')}":
        raise ValueError("Invalid connector consumer lock or platform")
    if output.exists():
        raise ValueError("Use a new output directory for each verified bundle")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="connector-acquire-", dir=output.parent) as temporary:
        staging = Path(temporary)

        def fetch(name: str, expected: str) -> Path:
            if PurePosixPath(name).name != name or len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected):
                raise ValueError("Invalid connector asset identity")
            destination = staging / name
            if assets is not None:
                shutil.copyfile(assets / name, destination)
            else:
                url = f"https://github.com/{lock['source_repository']}/releases/download/{lock['source_ref']}/{name}"
                request = urllib.request.Request(url, headers={"User-Agent": "openagent-connectors-acquisition"})
                with urllib.request.urlopen(request, timeout=45) as response, destination.open("wb") as stream:
                    size = 0
                    while data := response.read(1024 * 1024):
                        size += len(data)
                        if size > MAX_BYTES:
                            raise ValueError("Connector release asset exceeds size limit")
                        stream.write(data)
            if destination.stat().st_size > MAX_BYTES or digest(destination) != expected:
                raise ValueError("Connector asset checksum mismatch: " + name)
            return destination

        manifest = json.loads(fetch("manifest.json", lock["manifest_sha256"]).read_text())
        if manifest.get("version") != lock["version"] or manifest.get("source_commit") != lock["source_commit"] or manifest.get("dirty_snapshot") is not False:
            raise ValueError("Connector release does not match the clean pinned source")
        archive_name = f"openagent-connectors-{lock['version']}-{target}.tar.gz"
        wheel_name = f"openagent_connectors-{lock['version']}-py3-none-any.whl"
        for name in (archive_name, wheel_name):
            if manifest["files"].get(name) != lock["assets"].get(name):
                raise ValueError("Connector release asset disagrees with consumer lock")
        archive = fetch(archive_name, lock["assets"][archive_name]["sha256"])
        wheel = fetch(wheel_name, lock["assets"][wheel_name]["sha256"])
        bundle = staging / "bundle"
        bundle.mkdir()
        with tarfile.open(archive, "r:gz") as stream:
            members = stream.getmembers()
            names = set()
            size = 0
            for member in members:
                path = PurePosixPath(member.name.replace("\\", "/"))
                size += member.size
                if path.is_absolute() or ".." in path.parts or not path.parts or ":" in member.name or "\\" in member.name or member.name in names or not (member.isfile() or member.isdir()) or size > MAX_BYTES:
                    raise ValueError("Unsafe connector archive member")
                names.add(member.name)
            # Do not import archive ownership or permissions. Only the regular
            # files validated above are written into the fresh private directory.
            for member in members:
                destination = bundle / member.name
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with stream.extractfile(member) as source, destination.open("xb") as target_file:
                        shutil.copyfileobj(source, target_file)
                    destination.chmod(0o755 if member.name.startswith("bin/") else 0o644)
        verify_bundle(lock, target, bundle)
        wheelhouse.mkdir(parents=True, exist_ok=True)
        existing = wheelhouse / wheel_name
        if existing.exists() and digest(existing) != lock["assets"][wheel_name]["sha256"]:
            raise ValueError("Existing connector wheel differs from the consumer lock")
        os.replace(wheel, existing)
        os.rename(bundle, output)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=Path(__file__).with_name("connectors.lock.json"))
    parser.add_argument("--platform", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--assets", type=Path, help="Verified release directory for offline builds")
    args = parser.parse_args()
    print(acquire(args.lock, args.platform, args.output.resolve(), args.wheelhouse.resolve(), args.assets))
