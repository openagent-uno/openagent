"""Bounded immutable-reuse guards for the seven-new/two-retained release."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("attachment_release", Path(__file__).parents[1] / "qualify_attachment_product_release.py")
recipe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recipe)


class AttachmentComponentReuse(unittest.TestCase):
    def fixture(self, root):
        path = root / "packages/product-config/fixture.py"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"retained source")
        sources = {"packages/product-config/fixture.py": recipe.digest(path.read_bytes()), "apps/server/previous.py": "a" * 64}
        wheels = [{"file": name + ".whl", "name": name, "version": "retained", "sha256": "b" * 64, "bytes": 42} for name in sorted(recipe.REUSED)]
        host = next(row for row in wheels if row["name"] == "openagent-host-tools")
        baseline = {"sources": sources, "source_sha256": recipe.source_digest(sources), "wheels": wheels, "upstream_components": {"host-tools": {**host, "public_release_verified": True}}}
        return baseline, {"packages/product-config/fixture.py"}

    def test_unchanged_exact_components_keep_real_origin(self):
        with tempfile.TemporaryDirectory() as raw:
            baseline, tracked = self.fixture(Path(raw))
            wheels, sources = recipe.verified_reuse(Path(raw), baseline, tracked)
            self.assertEqual({row["name"] for row in wheels}, recipe.REUSED)
            self.assertEqual(set(sources), tracked)
            self.assertNotIn("apps/server/previous.py", sources)

    def test_source_drift_missing_and_digest_tampering_fail(self):
        for change in ("missing", "changed", "aggregate"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as raw:
                root = Path(raw)
                baseline, tracked = self.fixture(root)
                if change == "missing":
                    tracked.clear()
                elif change == "changed":
                    (root / next(iter(tracked))).write_bytes(b"different")
                else:
                    baseline["sources"]["apps/server/previous.py"] = "f" * 64
                with self.assertRaises(ValueError):
                    recipe.verified_reuse(root, baseline, tracked)

    def test_rebuilt_or_unproven_host_wheel_cannot_borrow_immutable_proof(self):
        for change in ("host-sha", "unverified", "missing"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as raw:
                baseline, tracked = self.fixture(Path(raw))
                if change == "host-sha":
                    next(row for row in baseline["wheels"] if row["name"] == "openagent-host-tools")["sha256"] = "c" * 64
                elif change == "unverified":
                    baseline["upstream_components"]["host-tools"]["public_release_verified"] = False
                else:
                    baseline["wheels"].pop()
                with self.assertRaises(ValueError):
                    recipe.verified_reuse(Path(raw), baseline, tracked)
