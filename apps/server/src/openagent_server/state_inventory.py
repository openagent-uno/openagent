"""Inventory storage before an operator acquires a private standalone backup."""

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import stat


def inspect_state(root, *, destination, private_manifest=None):
    """Read headers without following links; write an optional operator-only file."""
    root, destination = (
        Path(root).resolve(strict=True),
        Path(destination).resolve(strict=True),
    )
    if not root.is_dir() or not destination.is_dir():
        raise ValueError("Existing state and destination directories are required")
    counts = Counter()
    database_bytes = 0
    files_bytes = 0
    manifest = []

    def error(_):
        counts["unreadable"] += 1

    for folder, directories, files in os.walk(root, followlinks=False, onerror=error):
        base = Path(folder)
        for name in [*directories, *files]:
            path = base / name
            relative = path.relative_to(root).as_posix()
            try:
                entry = path.lstat()
                if stat.S_ISDIR(entry.st_mode):
                    continue
                if stat.S_ISLNK(entry.st_mode):
                    target = os.readlink(path)
                    resolved = path.resolve(strict=False)
                    kind = (
                        "internal_link"
                        if resolved.is_relative_to(root)
                        else "external_link"
                    )
                    counts[kind] += 1
                    counts["dangling_links"] += not resolved.exists()
                    # A host validates the link map locally without revealing its target in the receipt.
                    manifest.append(
                        {
                            "kind": kind,
                            "path": relative,
                            "target_sha256": hashlib.sha256(
                                os.fsencode(target)
                            ).hexdigest(),
                        }
                    )
                    continue
                if not stat.S_ISREG(entry.st_mode):
                    counts["special_files"] += 1
                    manifest.append({"kind": "special_file", "path": relative})
                    continue
                counts["regular_files"] += 1
                files_bytes += entry.st_size
                if relative.endswith(("-shm", "-wal", "-journal")):
                    counts["possible_journal_bytes"] += entry.st_size
                if entry.st_size >= 16:
                    with path.open("rb") as stream:
                        is_sqlite = stream.read(16) == b"SQLite format 3\0"
                    if is_sqlite:
                        counts["sqlite_databases"] += 1
                        database_bytes += entry.st_size
                        manifest.append(
                            {"kind": "sqlite", "path": relative, "bytes": entry.st_size}
                        )
            except (OSError, RuntimeError):
                counts["unreadable"] += 1
    private = sorted(manifest, key=lambda row: row["path"])
    encoded = json.dumps(
        private, sort_keys=True, ensure_ascii=True, separators=(",", ":")
    ).encode()
    if private_manifest is not None:
        path = Path(private_manifest).resolve()
        if path.is_relative_to(root):
            raise ValueError("Private manifest must be outside the source")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
    space = os.statvfs(destination)
    return {
        "scope": "preparation_inventory",
        "counts": dict(counts),
        "regular_bytes": files_bytes,
        "sqlite_bytes": database_bytes,
        "private_map_sha256": hashlib.sha256(encoded).hexdigest(),
        "destination_free_bytes": space.f_bavail * space.f_frsize,
        "two_full_copies_logical_bytes": files_bytes * 2,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state")
    parser.add_argument("--destination", required=True)
    parser.add_argument("--private-manifest")
    args = parser.parse_args(argv)
    try:
        report = inspect_state(
            args.state,
            destination=args.destination,
            private_manifest=args.private_manifest,
        )
    except (OSError, RuntimeError, ValueError):
        print(json.dumps({"error": "state_inventory_rejected"}))
        return 2
    print(json.dumps(report, sort_keys=True))
    return 1 if report["counts"].get("unreadable") else 0


if __name__ == "__main__":
    raise SystemExit(main())
