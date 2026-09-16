#!/usr/bin/env python3
"""Product workspace commands; no implicit installation or user-state access."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def configuration() -> dict:
    return json.loads((ROOT / "packaging/workspace.json").read_text())


def component(name: str) -> dict:
    try:
        return configuration()["components"][name]
    except KeyError:
        raise ValueError(f"Unknown component: {name}") from None


def component_version(value: dict) -> str:
    path = ROOT / value["path"]
    if value["kind"] == "python":
        project = tomllib.loads((path / "pyproject.toml").read_text())
        if "version" in project["project"]:
            return project["project"]["version"]
        version_path = project.get("tool", {}).get("hatch", {}).get("version", {}).get("path")
        if version_path:
            for statement in ast.parse((path / version_path).read_text()).body:
                if isinstance(statement, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "__version__" for target in statement.targets):
                    return ast.literal_eval(statement.value)
        raise ValueError(f"Component has no statically readable version: {value['path']}")
    return json.loads((path / "package.json").read_text()).get("version", "unversioned")


def source_history() -> list[dict]:
    return json.loads((ROOT / "packaging/source-history.json").read_text())["sources"]


def verify_history() -> None:
    for source in source_history():
        subprocess.run(["git", "merge-base", "--is-ancestor", source["source_commit"], "HEAD"], cwd=ROOT, check=True)
        if not (ROOT / source["path"]).is_dir():
            raise ValueError(f"Missing imported component {source['path']}")
    print(f"Verified complete ancestry for {len(source_history())} source repositories")


def artifact_owner(filename: str, components: dict) -> str:
    # Most-specific match prevents openagent-cli from being assigned to server.
    matches = [(len(value["artifact_prefix"]), name) for name, value in components.items()
               if value.get("artifact_prefix") and
               (filename.startswith(value["artifact_prefix"] + "-") or
                filename.startswith(value["artifact_prefix"].replace("-", "_") + "-"))]
    if not matches:
        raise ValueError(f"No component owns artifact {filename}")
    matches.sort(reverse=True)
    if len(matches) > 1 and matches[0][0] == matches[1][0]:
        raise ValueError(f"Ambiguous component for artifact {filename}")
    return matches[0][1]


def release_manifest(artifacts: Path) -> dict:
    config = configuration()
    if artifacts.is_symlink() or not artifacts.is_dir():
        raise ValueError("Artifact directory must be an existing directory, not a symlink")
    entries = []
    for artifact in sorted(artifacts.rglob("*")):
        if artifact.is_symlink():
            raise ValueError(f"Artifact symlinks are not permitted: {artifact}")
        if not artifact.is_file():
            continue
        digest = hashlib.sha256()
        with artifact.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        entries.append({"path": artifact.relative_to(artifacts).as_posix(),
                        "component": artifact_owner(artifact.name, config["components"]),
                        "size": artifact.stat().st_size, "sha256": digest.hexdigest()})
    if not entries:
        raise ValueError("At least one built artifact is required")
    return {"format": 1, "product_version": config["product_version"],
            "product_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "qualification": "development-unqualified", "compatibility": config["compatibility"],
            "components": {name: {**value, "version": component_version(value)} for name, value in config["components"].items()},
            "sources": source_history(), "artifacts": entries}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("list")
    actions.add_parser("verify-history")
    run = actions.add_parser("run")
    run.add_argument("component")
    run.add_argument("command", nargs=argparse.REMAINDER)
    wheel = actions.add_parser("wheel")
    wheel.add_argument("component")
    wheel.add_argument("--output", type=Path, required=True)
    manifest = actions.add_parser("release-manifest")
    manifest.add_argument("--artifacts", type=Path, required=True)
    manifest.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == "list":
            for name, value in configuration()["components"].items():
                print(f"{name:16} {component_version(value):16} {value['path']}")
        elif args.action == "verify-history":
            verify_history()
        elif args.action == "run":
            command = args.command[1:] if args.command[:1] == ["--"] else args.command
            if not command:
                raise ValueError("Supply a command after --")
            return subprocess.run(command, cwd=ROOT / component(args.component)["path"]).returncode
        elif args.action == "wheel":
            selected = component(args.component)
            if selected["kind"] != "python":
                raise ValueError("wheel requires a Python component")
            output = args.output.resolve()
            return subprocess.run([sys.executable, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", str(output), "."], cwd=ROOT / selected["path"]).returncode
        elif args.action == "release-manifest":
            value = release_manifest(args.artifacts.absolute())
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(value, indent=2) + "\n")
            print(args.output.resolve())
        return 0
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
