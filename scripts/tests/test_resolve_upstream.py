"""Use GitHub-shaped fixtures to exercise release selection and integrity checks."""
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resolve_upstream import Releases, requirements


def fixture(tag, package, version, *, draft=False, beta=True):
    filename = f"{package.replace('-', '_')}-{version}-py3-none-any.whl"
    wheel = {"file": filename, "sha256": "a" * 64, "bytes": 100}
    manifest = json.dumps({"dirty_snapshot": False, "wheels": [wheel]}).encode()
    assets = [
        {"name": filename, "size": 100, "digest": "sha256:" + wheel["sha256"]},
        {"name": "manifest.json", "size": len(manifest), "digest": "sha256:" + hashlib.sha256(manifest).hexdigest()},
    ]
    return {"tag_name": tag, "draft": draft, "prerelease": beta, "assets": assets}, manifest


class UpstreamReleaseTests(unittest.TestCase):
    def resolver(self, fixtures):
        def fetch(url, *, limit):
            if "/releases?" in url:
                self.assertIn("page=1", url)
                return json.dumps([row for row, _ in fixtures]).encode()
            tag = url.split("/download/")[1].split("/")[0]
            return dict((row["tag_name"], manifest) for row, manifest in fixtures)[tag]
        return Releases(fetch)

    def test_core_uses_highest_published_beta_in_its_family(self):
        fixtures = [
            fixture("v1.1.0-beta.9", "openagent-core", "1.1.0b9"),
            fixture("v1.1.0-beta.100", "openagent-core", "1.1.0b100", draft=True),
            fixture("v1.1.0-beta.10", "openagent-core", "1.1.0b10"),
        ]
        lock = self.resolver(fixtures).resolve({"openagent-core"})
        self.assertEqual(lock["releases"][0]["tag"], "v1.1.0-beta.10")
        wheel, = lock["wheels"]
        resolved = requirements("httpx==0.28.1\nopenagent-core[engine]==1.1.0b9\n", {"openagent-core": wheel})
        self.assertEqual(resolved, f"httpx==0.28.1\nopenagent-core[engine] @ {wheel['url']}#sha256={wheel['sha256']}\n")

    def test_connectors_ignore_unrelated_and_preview_releases(self):
        fixtures = [
            fixture("media-inspector-v9.0.0", "openagent-media-inspector", "9.0.0", beta=False),
            fixture("connectors-v1.0.0-beta.1", "openagent-connectors", "1.0.0b1"),
            fixture("connectors-v0.1.16", "openagent-connectors", "0.1.16", beta=False),
        ]
        lock = self.resolver(fixtures).resolve({"openagent-connectors"})
        self.assertEqual(lock["wheels"][0]["version"], "0.1.16")

    def test_conflicting_asset_hash_blocks_build(self):
        row, content = fixture("v1.1.0-beta.10", "openagent-core", "1.1.0b10")
        row["assets"][0]["digest"] = "sha256:" + "b" * 64
        with self.assertRaisesRegex(ValueError, "published asset differ"):
            self.resolver([(row, content)]).resolve({"openagent-core"})

    def test_incomplete_selected_cohort_blocks_build(self):
        fixtures = [
            fixture("v1.1.0-beta.10", "openagent-core", "1.1.0b10"),
        ]
        with self.assertRaisesRegex(ValueError, "no published wheel for openagent-storage-postgres"):
            self.resolver(fixtures).resolve({"openagent-core", "openagent-storage-postgres"})


if __name__ == "__main__":
    unittest.main()
