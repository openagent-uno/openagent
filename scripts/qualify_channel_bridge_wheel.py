#!/usr/bin/env python3
"""Build one public component remotely and verify its exact tracked payload."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import venv
import xml.etree.ElementTree as ET
import tarfile
import tempfile
import tomllib
import urllib.request
import zipfile

UV_URL = "https://github.com/astral-sh/uv/releases/download/0.11.14/uv-x86_64-unknown-linux-gnu.tar.gz"
UV_SHA256 = "f3b623eb0e6141a7053d571d59a0bdc341e0f238ea8f5f0b4815ddbec9a2a296"
UV_BYTES = 24_035_336
MAX_ARTIFACT_BYTES = 240 << 10


def git(source: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=source, timeout=30)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    revision, version = os.environ["SOURCE_SHA"], os.environ["EXPECTED_VERSION"]
    assert re.fullmatch(r"[a-f0-9]{40}", revision)
    assert git(source, "rev-parse", "HEAD").decode().strip() == revision
    assert not git(source, "status", "--porcelain")
    package = source / "packages/channel-bridges"
    assert tomllib.loads((package / "pyproject.toml").read_text())["project"]["version"] == version
    assert not output.exists(), "Use a new output directory"

    # Download only the reviewed public tool; no account, secret, SDK overlay,
    # provider request or application data is involved in this component build.
    with tempfile.TemporaryDirectory(prefix="channel-wheel-tool-") as directory:
        tool = Path(directory)
        with urllib.request.urlopen(UV_URL, timeout=40) as response:
            data = response.read(UV_BYTES + 1)
        assert len(data) == UV_BYTES and hashlib.sha256(data).hexdigest() == UV_SHA256
        archive = tool / "uv.tar.gz"
        archive.write_bytes(data)
        with tarfile.open(archive) as tar:
            member = tar.getmember("uv-x86_64-unknown-linux-gnu/uv")
            assert member.isfile() and not member.issym()
            executable = tool / "uv"
            executable.write_bytes(tar.extractfile(member).read())
            executable.chmod(0o700)
        env = {**os.environ, "PATH": str(tool) + os.pathsep + os.environ["PATH"]}
        subprocess.run(
            [sys.executable, "scripts/workspace.py", "wheel", "channel-bridges", "--output", str(output)],
            cwd=source, env=env, check=True, timeout=240,
        )

    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["repository_commit"] == revision and manifest["dirty_snapshot"] is False
    assert len(manifest["wheels"]) == 1
    entry = manifest["wheels"][0]
    assert entry["file"] == f"openagent_channel_bridges-{version}-py3-none-any.whl"
    assert entry["name"] == "openagent-channel-bridges" and entry["version"] == version
    wheel = output / entry["file"]
    assert wheel.stat().st_size == entry["bytes"]
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == entry["sha256"]
    names = git(source, "ls-files", "-z", "--", "packages/channel-bridges").decode().split("\0")
    expected = {}
    for name in filter(None, names):
        file = source / name
        assert file.is_file() and not file.is_symlink()
        expected[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    assert manifest["sources"] == expected
    with zipfile.ZipFile(wheel) as archive:
        for name in archive.namelist():
            if name.endswith("/") or ".dist-info/" in name:
                continue
            file = package / "src" / name
            assert file.is_file() and file.read_bytes() == archive.read(name), name
    assert not git(source, "status", "--porcelain")
    # Qualify the actual installed wheel. Tests live in the selected public
    # source tree, but imports must resolve to the new normal virtualenv install.
    with tempfile.TemporaryDirectory(prefix="channel-wheel-installed-") as directory:
        testroot = Path(directory)
        venv.create(testroot / "venv", with_pip=True)
        interpreter = testroot / "venv/bin/python"
        dependencies = [
            ("openagent_core-1.1.0b45-py3-none-any.whl", 1781753, "fab14b44355438baefe282c2447fca7ab6ad0c8dbf62534ab0ffc1458b03cd99"),
            ("openagent_storage_sqlite-1.1.0b45-py3-none-any.whl", 60956, "299eb3f5e08c23107057fa727c2ed667926e835c4341fbab1766f31edf6fa675"),
        ]
        paths = []
        for name, size, digest in dependencies:
            url = "https://github.com/openagent-uno/openagent-core/releases/download/v1.1.0-beta.45/" + name
            with urllib.request.urlopen(url, timeout=40) as response:
                payload = response.read(size + 1)
            assert len(payload) == size and hashlib.sha256(payload).hexdigest() == digest
            dependency = testroot / name
            dependency.write_bytes(payload)
            paths.append(str(dependency))
        testenv = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        subprocess.run([str(interpreter), "-m", "pip", "install", "--disable-pip-version-check", str(wheel) + "[test,slack,discord,telegram]", *paths], env=testenv, check=True, timeout=180)
        imported = subprocess.check_output([str(interpreter), "-c", "import openagent_channel_bridges;print(openagent_channel_bridges.__file__)"], cwd=testroot, env=testenv, text=True).strip()
        assert Path(imported).is_relative_to(testroot / "venv")
        junit = testroot / "tests.xml"
        subprocess.run([str(interpreter), "-m", "pytest", str(package / "tests"), "-q", "-rs", "--junitxml=" + str(junit)], cwd=testroot, env=testenv, check=True, timeout=180)
        suites = list(ET.parse(junit).getroot().iter("testsuite"))
        counts = {key: sum(int(suite.attrib.get(key, 0)) for suite in suites) for key in ("tests", "failures", "errors", "skipped")}
        assert counts["tests"] >= 360 and counts["failures"] == counts["errors"] == counts["skipped"] == 0
        qualification = {"scope": "normally installed wheel; provider-free full component suite", "source": revision, "wheelSha256": entry["sha256"], "core": "1.1.0b45", "sqlite": "1.1.0b45", "counts": counts, "providerAcceptance": False, "deployment": False}
        (output / "qualification.json").write_text(json.dumps(qualification, indent=2) + "\n")
    receipt = {
        "state": "PUBLIC_COMPONENT_WHEEL_BUILT_REMOTELY",
        "source": revision,
        "wheel": entry,
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "workflowRunId": os.environ.get("GITHUB_RUN_ID"),
        "workflowSha": os.environ.get("GITHUB_WORKFLOW_SHA"),
        "runner": "standard ubuntu-24.04",
        "providerCalls": False,
        "nativeBuild": False,
    }
    (output / "REMOTE-BUILD-RECEIPT.json").write_text(json.dumps(receipt, indent=2) + "\n")
    files = {file.name: file.read_bytes() for file in output.iterdir() if file.name != ".gitignore"}
    assert set(files) == {entry["file"], "manifest.json", "qualification.json", "REMOTE-BUILD-RECEIPT.json"}
    sums = "".join(hashlib.sha256(data).hexdigest() + "  " + name + "\n" for name, data in sorted(files.items()))
    (output / "SHA256SUMS").write_text(sums)
    files["SHA256SUMS"] = sums.encode()
    handoff = json.dumps({name: base64.b64encode(data).decode() for name, data in sorted(files.items())}, separators=(",", ":")).encode()
    assert len(handoff) <= MAX_ARTIFACT_BYTES
    # Job outputs avoid persistent Actions artifact/cache storage. Payload is
    # exclusively the small public wheel and public provenance, never secrets.
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        encoded = base64.b64encode(handoff).decode()
        for index in range(4):
            stream.write("payload_" + str(index) + "=" + encoded[index * 90000:(index + 1) * 90000] + "\n")
        stream.write("payload_sha256=" + hashlib.sha256(handoff).hexdigest() + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
