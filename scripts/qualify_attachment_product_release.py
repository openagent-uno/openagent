"""Finite beta52 attachment consumer release; seven rebuilt + two immutable wheels.

No native App/frozen-server builds, provider calls, publication or updater claim.
The existing App attachment renderer is unchanged. Core is an independent public
release: neither source directories nor development overrides enter the venv.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

CORE_SOURCE = "28b7d3b304f600adb1c33c7b03d948ce8dc49da2"
BASELINE_TAG = "v1.1.0-beta.51"
BASELINE_SHA = "5d2538252f99cb4208da3dc25aa219261203af9ed866b0d66ac1d2bf64e7de7d"
COMPONENTS = ("server", "cli", "mcp-bridge", "identity", "dashboards", "client-transport", "integrations-support")
REBUILT = frozenset(("openagent-framework", "openagent-cli", "openagent-mcp", "openagent-identity", "openagent-dashboards", "openagent-client-transport", "openagent-support-integration"))
REUSED = frozenset(("openagent-host-tools", "openagent-product-config"))
REUSED_PREFIX = "packages/product-config/"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def source_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def verified_reuse(root, baseline, tracked):
    if source_digest(baseline["sources"]) != baseline["source_sha256"]:
        raise ValueError("Baseline source inventory digest differs")
    wheels = [row for row in baseline["wheels"] if row["name"] in REUSED]
    if len(wheels) != 2 or {row["name"] for row in wheels} != REUSED:
        raise ValueError("Expected the two exact immutable product components")
    host = next(row for row in wheels if row["name"] == "openagent-host-tools")
    provenance = baseline["upstream_components"]["host-tools"]
    if (not provenance.get("public_release_verified") or
            any(provenance.get(key) != host[key] for key in ("file", "name", "version", "sha256", "bytes"))):
        raise ValueError("Host-tools immutable provenance differs")
    sources = {name: sha for name, sha in baseline["sources"].items() if name.startswith(REUSED_PREFIX)}
    current = {name for name in tracked if name.startswith(REUSED_PREFIX)}
    if not sources or set(sources) != current:
        raise ValueError("Reused product-config source inventory drift")
    for name, expected in sources.items():
        path = root / name
        if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != expected:
            raise ValueError("Reused product-config source changed")
    return wheels, sources


def fetch(repo, tag, name, expected):
    if Path(name).name != name or not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise ValueError("An exact public asset checksum is required")
    url = f"https://github.com/openagent-uno/{repo}/releases/download/{tag}/{name}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "openagent-attachment-release"}), timeout=60) as response:
        body = response.read((32 << 20) + 1)
    if len(body) > 32 << 20 or digest(body) != expected:
        raise ValueError("Public asset checksum or size mismatch: " + name)
    return body


def wheel_rows(manifest):
    if "wheels" in manifest:
        return manifest["wheels"]
    if "artifacts" in manifest:
        return [{"file": row["path"], **row} for row in manifest["artifacts"] if row["path"].endswith(".whl")]
    return [{"file": name, **row} for name, row in manifest["files"].items() if name.endswith(".whl")]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--core-manifest-sha", required=True)
    parser.add_argument("--fixture-runner", type=Path, required=True, help="Reviewed synthetic installed-package test runner; no product source overrides")
    args = parser.parse_args(argv)
    root, output = args.source.resolve(), args.output.resolve()
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip() != args.source_sha or subprocess.check_output(["git", "status", "--porcelain"], cwd=root).strip():
        raise ValueError("Clean frozen source is required")
    if output == root or root in output.parents:
        raise ValueError("Output must not dirty the frozen product checkout")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    evidence, wheels, upstream = [output / name for name in ("evidence", "product-assets", "public-wheels")]
    for path in evidence, wheels, upstream:
        path.mkdir(mode=0o700)
    env = dict(os.environ, UV_CONCURRENT_BUILDS="1", UV_CONCURRENT_INSTALLS="1", UV_CONCURRENT_DOWNLOADS="1", PYTHONDONTWRITEBYTECODE="1", OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
    for name in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "OA_CORE_SOURCE_DEBUG"):
        env.pop(name, None)
    receipt = {"format": 1, "status": "started", "source_commit": args.source_sha, "publication": False, "scope": "installed Python attachment consumer; no native App/frozen-server/provider qualification", "stages": []}
    def save():
        (evidence / "qualification.json").write_text(json.dumps(receipt, indent=2) + "\n")
    def run(command, log):
        with (evidence / log).open("w") as stream:
            subprocess.run([str(x) for x in command], cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT, check=True)
    save()
    try:
        baseline_body = fetch("openagent", BASELINE_TAG, "manifest.json", BASELINE_SHA)
        baseline = json.loads(baseline_body)
        (evidence / "baseline-manifest.json").write_bytes(baseline_body)
        tracked = set(subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")) - {""}
        reused, reused_sources = verified_reuse(root, baseline, tracked)
        releases = (("openagent-core", "v1.1.0-beta.24", args.core_manifest_sha),
                    ("openagent-tools", "v1.0.0-beta.4", "20b583195ac624c8f46a3c484eb596a5545dc514d60cbe7ed12e7b6f4da48228"),
                    ("openagent-tools", "connectors-v0.1.12", "4b864472df3cbfd01131b0c152d94da81ff6f3f161e976bbbe4c768c56fb87c9"))
        for repo, tag, expected in releases:
            body = fetch(repo, tag, "manifest.json", expected)
            (evidence / (tag + "-manifest.json")).write_bytes(body)
            manifest = json.loads(body)
            if repo == "openagent-core":
                if manifest["repository_commit"] != CORE_SOURCE or manifest["dirty_snapshot"]:
                    raise ValueError("Official Core source differs")
                versions = {row["name"]: row["version"] for row in wheel_rows(manifest)}
                if any(versions.get(name) != "1.1.0b24" for name in ("openagent-core", "openagent-storage-sqlite", "openagent-gateway", "openagent-sdk")):
                    raise ValueError("Official Core family differs")
            for row in wheel_rows(manifest):
                (upstream / row["file"]).write_bytes(fetch(repo, tag, row["file"], row["sha256"]))
        for row in reused:
            (wheels / row["file"]).write_bytes(fetch("openagent", BASELINE_TAG, row["file"], row["sha256"]))
        built = output / "rebuilt"
        run([sys.executable, root / "scripts/build_wheels.py", "--out", built, "--components", *COMPONENTS], "build-seven-wheels.log")
        candidate = json.loads((built / "manifest.json").read_text())
        if candidate["dirty_snapshot"] or candidate["repository_commit"] != args.source_sha or {row["name"] for row in candidate["wheels"]} != REBUILT or any(row["version"] != "1.1.0b52" for row in candidate["wheels"]):
            raise ValueError("New component version/source mismatch")
        for path in built.glob("*.whl"):
            shutil.copyfile(path, wheels / path.name)
        import runpy
        runpy.run_path(str(root / "scripts/build_wheels.py"))["verify_ownership"](sorted(wheels.glob("*.whl")) + sorted(upstream.glob("*.whl")))
        if set(candidate["sources"]) & set(reused_sources):
            raise ValueError("Rebuilt and reused source inventories overlap")
        candidate["sources"] = dict(sorted({**candidate["sources"], **reused_sources}.items()))
        candidate["source_sha256"] = source_digest(candidate["sources"])
        candidate["wheels"].extend(reused)
        candidate["upstream_components"] = baseline["upstream_components"]
        candidate["reused_product_components"] = {"release": BASELINE_TAG, "manifest_sha256": BASELINE_SHA, "wheels": reused, "verified_source_files": len(reused_sources), "source_provenance": {"release": BASELINE_TAG, "source_sha256": baseline["source_sha256"], "host_tools": baseline["upstream_components"]["host-tools"]}}
        (wheels / "manifest.json").write_text(json.dumps(candidate, indent=2) + "\n")
        receipt["stages"].append("seven-new-two-byte-identical-public-wheels")
        save()
        installed = output / "installed"
        run(["uv", "venv", "--python", sys.executable, installed], "venv.log")
        python = installed / "bin/python"
        constraints = output / "constraints.txt"
        constraints.write_text("hf-xet==1.7.0\nlitellm==1.105.0\npydantic==2.14.1\npydantic-core==2.50.1\nSQLAlchemy==2.1.4\nPyJWT==2.14.0\nurllib3==2.8.0\n")
        run(["uv", "pip", "install", "--python", python, "--constraint", constraints, *sorted(wheels.glob("*.whl")), *sorted(upstream.glob("*.whl")), "openagent-core[engine,providers,modules]==1.1.0b24"], "normal-install.log")
        run(["uv", "pip", "check", "--python", python], "pip-check.log")
        run([python, "-B", args.fixture_runner], "installed-consumer.log")
        receipt["stages"].append("normal-installed-public-core24-product52-cas-and-authority-tests")
        receipt["status"] = "passed"
    except BaseException as exc:
        receipt["status"] = "failed"
        receipt["error_type"] = type(exc).__name__
        raise
    finally:
        save()


if __name__ == "__main__":
    main()
