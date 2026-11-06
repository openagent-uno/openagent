#!/usr/bin/env python3
"""Publish one verified public component using an ephemeral workflow token."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def gh(*arguments: str) -> bytes:
    return subprocess.check_output(["gh", *arguments], timeout=60)


def main() -> None:
    repository = os.environ["GH_REPO"]
    revision, version = os.environ["SOURCE_SHA"], os.environ["EXPECTED_VERSION"]
    assert repository == "openagent-uno/openagent" and re.fullmatch(r"[a-f0-9]{40}", revision)
    assert re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:a[0-9]+|b[0-9]+|rc[0-9]+)?", version)
    tag_version = re.sub(r"b([0-9]+)$", r"-beta.\1", version)
    tag = "channel-bridges-v" + tag_version
    raw = base64.b64decode("".join(os.environ["WHEEL_PAYLOAD_" + str(i)] for i in range(4)), validate=True)
    assert len(raw) <= 240 << 10 and hashlib.sha256(raw).hexdigest() == os.environ["WHEEL_PAYLOAD_SHA256"]
    files = {name: base64.b64decode(data, validate=True) for name, data in json.loads(raw).items()}
    wheel = f"openagent_channel_bridges-{version}-py3-none-any.whl"
    assert set(files) == {wheel, "manifest.json", "qualification.json", "REMOTE-BUILD-RECEIPT.json", "SHA256SUMS"}
    manifest, qualification = json.loads(files["manifest.json"]), json.loads(files["qualification.json"])
    assert manifest["repository_commit"] == revision and manifest["dirty_snapshot"] is False
    assert len(manifest["wheels"]) == 1
    entry = manifest["wheels"][0]
    assert entry["file"] == wheel and entry["version"] == version
    assert entry["bytes"] == len(files[wheel]) and entry["sha256"] == hashlib.sha256(files[wheel]).hexdigest()
    counts = qualification["counts"]
    assert qualification["source"] == revision and qualification["wheelSha256"] == entry["sha256"]
    assert counts["tests"] >= 360 and counts["failures"] == counts["errors"] == counts["skipped"] == 0
    expected_sums = "".join(hashlib.sha256(data).hexdigest() + "  " + name + "\n" for name, data in sorted(files.items()) if name != "SHA256SUMS")
    assert files["SHA256SUMS"].decode() == expected_sums
    info = json.loads(gh("api", "repos/" + repository))
    assert info["private"] is False and info["visibility"] == "public"
    # Creating the tag is atomic and refuses an existing tag. Existing releases
    # and their assets are never overwritten, deleted or automatically retried.
    gh("api", "--method", "POST", "repos/" + repository + "/git/refs", "-f", "ref=refs/tags/" + tag, "-f", "sha=" + revision)
    with tempfile.TemporaryDirectory(prefix="public-channel-release-") as directory:
        folder = Path(directory)
        for name, data in files.items():
            (folder / name).write_bytes(data)
        notes = "Provider-free qualification of the normally installed component wheel passed on Core/SQLite beta45. Additional Slack and Discord history has an aggregate preparation deadline. This release does not claim live provider or deployment acceptance. Source: " + revision
        gh("release", "create", tag, "--repo", repository, "--verify-tag", "--draft", "--prerelease", "--title", "Channel bridges " + version, "--notes", notes)
        gh("release", "upload", tag, *(str(folder / name) for name in sorted(files)), "--repo", repository)
        downloaded = folder / "downloaded"
        downloaded.mkdir()
        gh("release", "download", tag, "--repo", repository, "--dir", str(downloaded))
        assert {file.name: file.read_bytes() for file in downloaded.iterdir()} == files
        actual = json.loads(gh("api", "repos/" + repository + "/git/ref/tags/" + tag))
        assert actual["object"]["type"] == "commit" and actual["object"]["sha"] == revision
        gh("release", "edit", tag, "--repo", repository, "--draft=false")
    print(json.dumps({"state": "PUBLIC_COMPONENT_PRERELEASE_PUBLISHED", "tag": tag, "source": revision, "wheelSha256": entry["sha256"], "assets": sorted(files), "url": "https://github.com/" + repository + "/releases/tag/" + tag}))


if __name__ == "__main__":
    main()
