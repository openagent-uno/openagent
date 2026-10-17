"""Pure provenance guards; synthetic files, no build/download/install or provider."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("product_release_recipe", Path(__file__).parents[1] / "qualify_connector_product_release.py")
recipe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recipe)


class ReusedComponentProvenance(unittest.TestCase):
    def fixture(self, root):
        sources = {}
        for index in range(109):
            name = "packages/identity/fixture-" + str(index)
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(str(index).encode())
            sources[name] = recipe.digest(path.read_bytes())
        # Public41 also records rebuilt server/CLI sources; these may change in
        # beta42, but must still be covered by the baseline's aggregate digest.
        aggregate = {**sources, "apps/server/prior.py": "d" * 64, "apps/cli/prior.py": "e" * 64}
        wheels = [{"file": "component-" + str(index) + ".whl", "name": "component-" + str(index),
                   "version": "1", "sha256": "a" * 64, "bytes": 100} for index in range(7)]
        baseline = {"sources": aggregate, "source_sha256": recipe.source_digest(aggregate),
                    "wheels": copy.deepcopy(wheels), "reused_product_components": {
                        "release": recipe.REUSED_ORIGIN[0], "manifest_sha256": recipe.REUSED_ORIGIN[1],
                        "verified_source_files": 109, "wheels": copy.deepcopy(wheels)}}
        return baseline, sources

    def test_missing_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, sources = self.fixture(root)
            tracked = set(sources)
            tracked.pop()
            with self.assertRaisesRegex(ValueError, "inventory drift"):
                recipe.verified_reused_sources(root, baseline, tracked)
            # A complete-looking filtered set cannot borrow an invalid full
            # baseline digest: discarded old server source is authenticated too.
            baseline["sources"]["apps/server/prior.py"] = "f" * 64
            with self.assertRaisesRegex(ValueError, "inventory digest"):
                recipe.verified_reused_sources(root, baseline, set(sources))

    def test_changed_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, sources = self.fixture(root)
            (root / next(iter(sources))).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "source changed"):
                recipe.verified_reused_sources(root, baseline, set(sources))

    def test_changed_wheel_cannot_borrow_old_source_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, sources = self.fixture(root)
            baseline["wheels"][0]["sha256"] = "b" * 64
            with self.assertRaisesRegex(ValueError, "wheel metadata differs"):
                recipe.verified_reused_sources(root, baseline, set(sources))

    def test_verified_sources_are_preserved_in_canonical_aggregate_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, sources = self.fixture(root)
            actual = recipe.verified_reused_sources(root, baseline, set(sources))
            self.assertEqual(actual, sources)
            rebuilt = {"apps/server/fixture": "b" * 64, "apps/cli/fixture": "c" * 64}
            candidate = {"sources": rebuilt.copy(), "source_sha256": "stale"}
            recipe.merge_source_provenance(candidate, actual)
            expected = {**rebuilt, **sources}
            expected_digest = hashlib.sha256(json.dumps(expected, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            self.assertEqual(candidate["sources"], expected)
            self.assertEqual(len(candidate["sources"]), 111)
            self.assertNotIn("apps/server/prior.py", candidate["sources"])
            self.assertEqual(candidate["source_sha256"], expected_digest)
            with self.assertRaisesRegex(ValueError, "overlap"):
                recipe.merge_source_provenance(candidate, actual)


if __name__ == "__main__":
    unittest.main()
