"""Pure provenance guards; synthetic files, no build/download/install or provider."""
import copy
import importlib.util
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
        wheels = [{"file": "component-" + str(index) + ".whl", "name": "component-" + str(index),
                   "version": "1", "sha256": "a" * 64, "bytes": 100} for index in range(7)]
        provenance = {"sources": sources, "source_sha256": recipe.source_digest(sources), "wheels": wheels}
        baseline = {"sources": {}, "wheels": copy.deepcopy(wheels), "reused_product_components": {
            "release": recipe.SOURCE_PROVENANCE[1], "manifest_sha256": recipe.SOURCE_PROVENANCE[2],
            "verified_source_files": 109, "wheels": copy.deepcopy(wheels)}}
        return baseline, provenance

    def test_missing_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, provenance = self.fixture(root)
            tracked = set(provenance["sources"])
            tracked.pop()
            with self.assertRaisesRegex(ValueError, "inventory drift"):
                recipe.verified_reused_sources(root, baseline, provenance, tracked)

    def test_changed_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, provenance = self.fixture(root)
            (root / next(iter(provenance["sources"]))).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "source changed"):
                recipe.verified_reused_sources(root, baseline, provenance, set(provenance["sources"]))

    def test_changed_wheel_cannot_borrow_old_source_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, provenance = self.fixture(root)
            baseline["wheels"][0]["sha256"] = "b" * 64
            with self.assertRaisesRegex(ValueError, "wheel metadata differs"):
                recipe.verified_reused_sources(root, baseline, provenance, set(provenance["sources"]))

    def test_verified_sources_are_preserved_in_canonical_aggregate_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, provenance = self.fixture(root)
            sources = recipe.verified_reused_sources(root, baseline, provenance, set(provenance["sources"]))
            rebuilt = {"apps/server/fixture": "b" * 64, "apps/cli/fixture": "c" * 64}
            candidate = {"sources": rebuilt.copy(), "source_sha256": recipe.source_digest(rebuilt)}
            recipe.merge_source_provenance(candidate, sources)
            self.assertEqual(candidate["sources"], {**rebuilt, **sources})
            self.assertEqual(len(candidate["sources"]), 111)
            self.assertEqual(candidate["source_sha256"], recipe.source_digest({**sources, **rebuilt}))
            with self.assertRaisesRegex(ValueError, "overlap"):
                recipe.merge_source_provenance(candidate, sources)


if __name__ == "__main__":
    unittest.main()
