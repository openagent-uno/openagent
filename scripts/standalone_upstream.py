"""Apply resolved public runtime dependencies to a disposable server build snapshot."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import tomllib

from resolve_upstream import Releases, asset_url, family, verify_asset

DEPENDENCY = re.compile(r'"(openagent-[a-z0-9-]+)(\[[^"\]]+\])?==[^"]+"')
CONSTRAINT = re.compile(r'"(openagent-[a-z0-9-]+) @ [^"]+"')
URL_SOURCE = re.compile(r'(?m)^(openagent-[a-z0-9-]+) = \{ url = "[^"]+" \}$')
# The published Host Tools wheel currently requires an older, exact capability
# host. Keep that independent dependency until its owner releases a cohesive set.
HOST_COMPATIBILITY_PINS = {"openagent-host-tools", "openagent-capability-host"}


def refresh_project(source: str, wheels: dict[str, dict]) -> str:
    def dependency(match):
        name, extras = match.groups()
        return f'"{name}{extras or ""}=={wheels[name]["version"]}"' if name in wheels else match[0]

    def constraint(match):
        row = wheels.get(match[1])
        return f'"{match[1]} @ {row["url"]}#sha256={row["sha256"]}"' if row else match[0]

    def url_source(match):
        row = wheels.get(match[1])
        return f'{match[1]} = {{ url = "{row["url"]}" }}' if row else match[0]

    result = URL_SOURCE.sub(url_source, CONSTRAINT.sub(constraint, DEPENDENCY.sub(dependency, source)))
    tomllib.loads(result)
    return result


def connector_lock(resolver: Releases, resolution: dict, previous: dict) -> dict:
    source = family("openagent-connectors")
    release, = (row for row in resolution["releases"] if row["tag"].startswith(source.prefix))
    manifest, assets = resolver.manifests[source]
    version, commit = manifest["version"], manifest["source_commit"]
    if release["tag"] != f"connectors-v{version}" or not re.fullmatch("[a-f0-9]{40}", commit):
        raise ValueError("Connector release identity does not match its manifest")

    catalog = manifest["files"]["catalog.json"]
    verify_asset(assets, "catalog.json", catalog["sha256"], catalog["bytes"])
    bundled = {}
    for platform in previous["platforms"]:
        name = f"openagent-connectors-{version}-{platform}.tar.gz"
        record = manifest["files"][name]
        verify_asset(assets, name, record["sha256"], record["bytes"])
        if record["bytes"] > 64 << 20:
            raise ValueError(f"Connector archive too large: {name}")
        payload = resolver.fetch(asset_url(source.repository, release["tag"], name), limit=record["bytes"])
        if len(payload) != record["bytes"] or hashlib.sha256(payload).hexdigest() != record["sha256"]:
            raise ValueError(f"Connector archive checksum mismatch: {name}")
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            member = archive.next()
            while member is not None and member.name != "manifest.json":
                member = archive.next()
            if member is None or not member.isfile() or member.size > 1 << 20:
                raise ValueError(f"Invalid connector bundle manifest: {name}")
            content = archive.extractfile(member).read()
        info = json.loads(content)
        if (info.get("version"), info.get("source_commit"), info.get("platform"), info.get("dirty_snapshot")) != (
            version, commit, platform, False
        ):
            raise ValueError(f"Connector bundle identity mismatch: {name}")
        bundled[platform] = {"manifest_sha256": hashlib.sha256(content).hexdigest()}
    return {
        "format": 1, "version": version, "source_repository": release["repository"],
        "source_ref": release["tag"], "source_commit": commit, "manifest_sha256": release["manifest_sha256"],
        "assets": manifest["files"], "platforms": bundled,
    }


def refresh_server(
    snapshot: Path, server: Path, projects: list[Path], resolver: Releases | None = None,
) -> dict:
    resolver = resolver or Releases()
    source = (server / "pyproject.toml").read_text()
    packages = set(CONSTRAINT.findall(source)) - HOST_COMPATIBILITY_PINS
    resolution = resolver.resolve(packages)
    wheels = {row["name"]: row for row in resolution["wheels"]}
    checkout_lock = server / "connectors.lock.json"
    packaged_lock = server / "src/openagent_server/connectors.lock.json"
    if checkout_lock.read_bytes() != packaged_lock.read_bytes():
        raise ValueError("The checkout and packaged connector locks differ")
    old_lock = json.loads(checkout_lock.read_bytes())
    new_lock = connector_lock(resolver, resolution, old_lock)
    content = json.dumps(new_lock, indent=2) + "\n"
    for path in projects:
        path.write_text(refresh_project(path.read_text(), wheels))
    checkout_lock.write_text(content)
    packaged_lock.write_text(content)
    resolution["compatible_pins"] = sorted(HOST_COMPATIBILITY_PINS)
    resolution["build_inputs"] = {
        path.relative_to(snapshot).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (*projects, checkout_lock, packaged_lock)
    }
    return resolution
