#!/usr/bin/env python3
"""Resolve the public OpenAgent release families once per build."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
from typing import NamedTuple
from urllib.request import Request, urlopen

OWNER = "openagent-uno"
TAG = r"v(\d+)\.(\d+)\.(\d+)(?:(?:-beta\.|b)(\d+))?"
DIGEST = re.compile(r"[a-f0-9]{64}")
NAME = re.compile(r"openagent-[a-z0-9]+(?:-[a-z0-9]+)*")
WHEEL = re.compile(r"(openagent_[a-z0-9_]+)-([0-9]+(?:\.[0-9]+)+(?:b[0-9]+)?)-py3-none-any\.whl")
REQUIREMENT = re.compile(r"^\s*(openagent-[a-z0-9-]+)(\[[a-zA-Z0-9_, -]+\])?(?=\s|[=@<;>!~]|$)")
CORE = {
    "openagent-core", "openagent-capability-host", "openagent-gateway", "openagent-modules",
    "openagent-modules-full", "openagent-sdk", "openagent-storage-postgres", "openagent-storage-sqlite",
}
TOOLS = {
    "openagent-editor", "openagent-execution", "openagent-filesystem",
    "openagent-shell", "openagent-tool-protocol",
}


class Family(NamedTuple):
    repository: str
    prefix: str
    prereleases: bool


def family(name: str) -> Family:
    if name in CORE or name.startswith("openagent-module-"):
        return Family("openagent-core", "", True)
    if name in TOOLS:
        return Family("openagent-tools", "", True)
    for package, repo, prefix, beta in (
        ("connectors", "openagent-tools", "connectors-", False),
        ("device-tools", "openagent-tools", "device-tools-", True),
        ("mcp-client", "openagent-tools", "mcp-client-", True),
        ("channel-bridges", "openagent", "channel-bridges-", True),
        ("host-tools", "openagent", "host-tools-python-", True),
    ):
        if name == f"openagent-{package}":
            return Family(repo, prefix, beta)
    raise ValueError(f"No public release family for {name}")


def fetch(url: str, *, limit: int) -> bytes:
    headers = {"User-Agent": "openagent-build-release-resolver"}
    request = Request(url, headers=headers)
    if url.startswith("https://api.github.com/"):
        request.add_header("Accept", "application/vnd.github+json")
        token = os.environ.get("OPENAGENT_RELEASE_TOKEN")
        if token:
            request.add_unredirected_header("Authorization", f"Bearer {token}")
    with urlopen(request, timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"Release response too large: {url}")
    return data


def asset_url(repo: str, tag: str, filename: str) -> str:
    return f"https://github.com/{OWNER}/{repo}/releases/download/{tag}/{filename}?download=1"


def release_key(release: dict, source: Family) -> tuple[int, ...] | None:
    tag = re.fullmatch(re.escape(source.prefix) + TAG, release["tag_name"])
    if release["draft"] or not tag or (not source.prereleases and (release["prerelease"] or tag[4])):
        return None
    return tuple(int(part) for part in tag.groups()[:3]) + (int(tag[4]) if tag[4] else 2**63,)


def verify_asset(assets: dict, filename: str, sha256: str, size: int) -> None:
    asset = assets.get(filename, {})
    if (
        not isinstance(sha256, str) or not DIGEST.fullmatch(sha256)
        or type(size) is not int or size <= 0
        or asset.get("size") != size or asset.get("digest") != f"sha256:{sha256}"
    ):
        raise ValueError(f"Release manifest and published asset differ: {filename}")


class Releases:
    def __init__(self, fetch_bytes=fetch):
        self.fetch = fetch_bytes
        self.releases = {}
        self.manifests = {}

    def list(self, repo: str) -> list[dict]:
        if repo not in self.releases:
            rows = []
            for page in range(1, 21):
                url = f"https://api.github.com/repos/{OWNER}/{repo}/releases?per_page=100&page={page}"
                batch = json.loads(self.fetch(url, limit=32 << 20))
                if not isinstance(batch, list):
                    raise ValueError(f"Invalid release list for {repo}")
                rows.extend(batch)
                if len(batch) < 100:
                    break
            else:
                raise ValueError(f"Release list too large for {repo}")
            self.releases[repo] = rows
        return self.releases[repo]

    def resolve(self, packages: set[str]) -> dict:
        sources = {name: family(name) for name in packages}
        releases, wheels = [], []
        for source in sorted(set(sources.values())):
            requested = {name for name, selected in sources.items() if selected == source}
            candidates = [
                (key, row) for row in self.list(source.repository)
                if (key := release_key(row, source)) is not None
            ]
            if not candidates:
                raise ValueError(f"No published release for {source.repository}/{source.prefix}")
            _, release = max(candidates, key=lambda item: item[0])
            tag = release["tag_name"]
            assets = {asset["name"]: asset for asset in release["assets"]}
            payload = self.fetch(asset_url(source.repository, tag, "manifest.json"), limit=4 << 20)
            manifest_sha = hashlib.sha256(payload).hexdigest()
            verify_asset(assets, "manifest.json", manifest_sha, len(payload))
            manifest = json.loads(payload)
            legacy_mcp_manifest = (
                source.prefix == "mcp-client-"
                and "dirty_snapshot" not in manifest
                and re.fullmatch("[a-f0-9]{40}", manifest.get("source", ""))
            )
            if manifest.get("dirty_snapshot") is not False and not legacy_mcp_manifest:
                raise ValueError(f"Published release does not attest clean sources: {tag}")
            self.manifests[source] = (manifest, assets)
            rows = manifest.get("wheels", manifest.get("artifacts"))
            if rows is None:
                rows = [{"file": filename, **record} for filename, record in manifest["files"].items()]
            found = {}
            for row in rows:
                filename = row.get("file", row.get("path"))
                match = WHEEL.fullmatch(filename or "")
                if not match:
                    continue
                name = match[1].replace("_", "-")
                if name not in requested:
                    continue
                if name in found:
                    raise ValueError(f"Ambiguous wheel for {name} in {tag}")
                verify_asset(assets, filename, row["sha256"], row["bytes"])
                found[name] = {
                    "name": name, "version": match[2], "file": filename,
                    "sha256": row["sha256"], "bytes": row["bytes"],
                    "url": asset_url(source.repository, tag, filename),
                }
            if missing := requested - found.keys():
                raise ValueError(f"{tag} has no published wheel for {', '.join(sorted(missing))}")
            releases.append({
                "repository": f"{OWNER}/{source.repository}", "tag": tag,
                "manifest_sha256": manifest_sha,
            })
            wheels.extend(found.values())
        return {"schema": 1, "releases": releases, "wheels": sorted(wheels, key=lambda row: row["name"])}


def requirements(text: str, wheels: dict[str, dict]) -> str:
    lines = []
    seen = set()
    for line in text.splitlines(keepends=True):
        match = REQUIREMENT.match(line)
        if match:
            row = wheels[match[1]]
            if match[1] in seen or ";" in line or "\\" in line:
                raise ValueError(f"Expected one unconditional OpenAgent requirement per package: {match[1]}")
            seen.add(match[1])
            lines.append(f"{match[1]}{match[2] or ''} @ {row['url']}#sha256={row['sha256']}\n")
        else:
            lines.append(line)
    return "".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requirements", type=Path, help="Read existing first-party requirements and retain third-party requirements")
    parser.add_argument("--output", type=Path, help="Write resolved requirements")
    parser.add_argument("--receipt", type=Path, required=True, help="Write exact selected release and wheel checksums")
    parser.add_argument("packages", nargs="*", help="Additional OpenAgent distributions required by this build")
    args = parser.parse_args()
    if bool(args.requirements) != bool(args.output):
        parser.error("--requirements and --output must be used together")
    original = args.requirements.read_text() if args.requirements else ""
    packages = set(args.packages)
    packages.update(match[1] for line in original.splitlines() if (match := REQUIREMENT.match(line)))
    if not packages or not all(NAME.fullmatch(name) for name in packages):
        parser.error("Specify at least one OpenAgent distribution")
    lock = Releases().resolve(packages)
    if args.output:
        args.output.write_text(requirements(original, {row["name"]: row for row in lock["wheels"]}))
    args.receipt.write_text(json.dumps(lock, indent=2) + "\n")
    for item in lock["releases"]:
        print(f"{item['repository']} {item['tag']}")


if __name__ == "__main__":
    main()
