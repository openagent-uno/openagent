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
        # Public43 also records rebuilt server/CLI sources; these may change in
        # beta45, but must still be covered by the baseline's aggregate digest.
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


class SDK18InstalledContract(unittest.TestCase):
    """Designed pure metadata fixtures; never actual provider or release evidence."""

    def catalog(self):
        rows = [{"id": identifier} for identifier in sorted(recipe.SDK17_IDS)]
        rows.append({"id": "custom-mcp", "nativeKind": "custom_mcp"})
        for provider, (_, operations) in recipe.GRAPH_READS.items():
            rows.append({"id": provider, "provider": provider, "auth": "oauth", "capability": "files",
                         "available": True, "agentTools": [],
                         "readTools": sorted("files." + provider + "." + operation for operation in operations)})
        for identifier, (provider, capability, operations) in recipe.SDK18_MANUAL.items():
            rows.append({"id": identifier, "provider": provider, "auth": "token", "capability": capability,
                         "available": True, "agentTools": [], "readTools": list(operations),
                         "setupUrl": "https://example.com/docs", "setupInstructions": "Use your authorized API token manually; provider acceptance remains separate.",
                         "logoSvg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#123ABC" d="M0 0Z"/></svg>'
                                    if provider in recipe.BRANDMARK_PROVIDERS else ""})
        return rows

    def tools(self, identifier):
        if identifier in recipe.GRAPH_READS:
            scope, suffixes = recipe.GRAPH_READS[identifier]
            provider, capability = identifier, "files"
            operations = {"files." + provider + "." + suffix: [scope] for suffix in suffixes}
        else:
            provider, capability, names = recipe.SDK18_MANUAL[identifier]
            operations = {name: [] for name in names}
        return [{"name": name, "provider": provider, "capability": capability, "risk": "read", "mode": "typed",
                 "required_scopes": scopes, "retry": {"max_attempts": 1},
                 "inputSchema": {"type": "object", "additionalProperties": False,
                   "properties": {} if identifier in recipe.GRAPH_READS else {"connection_id": {"type": "string"}, "provider": {"enum": [provider]}}}}
                for name, scopes in sorted(operations.items())]

    def test_unpublished_sdk18_cannot_pass_checksum_preflight(self):
        pending = (("openagent-tools", "connectors-v0.1.8", None),)
        with self.assertRaisesRegex(ValueError, "checksum is pending"):
            recipe.require_public_checksums(pending)
        recipe.require_public_checksums((("fixture", "not-a-public-release", "a" * 64),))
        for value in ("", "a" * 63, "A" * 64, 17):
            with self.subTest(value=value), self.assertRaises(ValueError):
                recipe.require_public_checksums((("fixture", "fixture", value),))

    def test_exact_pinned_catalog_and_read_only_metadata_counts(self):
        rows = self.catalog()
        receipt = recipe.verify_catalog_metadata(rows, copy.deepcopy(rows))
        self.assertEqual((receipt["official"], receipt["custom"]), (114, 1))
        self.assertEqual(sum(recipe.verify_read_tools(identifier, self.tools(identifier))["operations"]
                             for identifier in recipe.SDK18_MANUAL), 180)
        self.assertEqual(sum(recipe.verify_read_tools(identifier, self.tools(identifier))["operations"]
                             for identifier in recipe.GRAPH_READS), 12)
        self.assertEqual(len(recipe.BRANDMARK_PROVIDERS), 45)

    def test_installed_catalog_cannot_borrow_different_public_bytes(self):
        rows = self.catalog()
        expected = copy.deepcopy(rows)
        next(row for row in rows if row["id"] == "coda")["setupInstructions"] += " Different."
        with self.assertRaisesRegex(ValueError, "differs from public SDK"):
            recipe.verify_catalog_metadata(rows, expected)

    def test_same_count_substitution_oauth_promotion_or_extra_write_rejected(self):
        for field, value in (("id", "unreviewed"), ("auth", "oauth"), ("provider", "other-account"),
                             ("agentTools", ["files.coda.write"]), ("readTools", ["files.coda.raw", "files.coda.identity.get"])):
            with self.subTest(field=field):
                rows = self.catalog()
                next(row for row in rows if row["id"] == "coda")[field] = value
                with self.assertRaises(ValueError):
                    recipe.verify_catalog_metadata(rows, copy.deepcopy(rows))

    def test_setup_and_svg_cannot_introduce_remote_code_or_fabricated_marks(self):
        for identifier, field, value in (
                ("coda", "setupUrl", "javascript:run()"),
                ("coda", "setupUrl", "https://user:password@example.com/docs"),
                ("coda", "setupInstructions", ""),
                ("airtable", "logoSvg", ""),
                ("airtable", "logoSvg", '<svg><script>run()</script></svg>'),
                ("airtable", "logoSvg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#123ABC" d="M0 0Z"/></svg>\n'),
                ("fathom", "logoSvg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#123ABC" d="M0 0Z"/></svg>')):
            with self.subTest(identifier=identifier, field=field):
                rows = self.catalog()
                next(row for row in rows if row["id"] == identifier)[field] = value
                with self.assertRaises(ValueError):
                    recipe.verify_catalog_metadata(rows, copy.deepcopy(rows))

    def test_tools_cannot_weaken_scope_binding_closed_schema_risk_or_retry(self):
        for identifier in ("coda", "klaviyo", "onedrive", "sharepoint"):
            for field, value in (("provider", "other"), ("risk", "write"), ("mode", "raw"),
                                 ("required_scopes", ["write:anything"]), ("retry", {"max_attempts": 2})):
                with self.subTest(identifier=identifier, field=field):
                    tools = self.tools(identifier)
                    tools[0][field] = value
                    with self.assertRaises(ValueError):
                        recipe.verify_read_tools(identifier, tools)
            tools = self.tools(identifier)
            tools[0]["inputSchema"]["additionalProperties"] = True
            with self.assertRaises(ValueError):
                recipe.verify_read_tools(identifier, tools)
            if identifier not in recipe.GRAPH_READS:
                for field in ("connection_id", "provider"):
                    tools = self.tools(identifier)
                    del tools[0]["inputSchema"]["properties"][field]
                    with self.assertRaisesRegex(ValueError, "manual read binding"):
                        recipe.verify_read_tools(identifier, tools)

    def test_manual_credential_never_claims_vendor_permission_as_oauth_scope(self):
        tools = self.tools("klaviyo")
        self.assertTrue(all(tool["required_scopes"] == [] for tool in tools))
        recipe.verify_read_tools("klaviyo", tools)
        tools[0]["required_scopes"] = ["profiles:read"]
        with self.assertRaisesRegex(ValueError, "scope/risk/schema/retry"):
            recipe.verify_read_tools("klaviyo", tools)

    def test_graph_caller_cannot_select_host_owned_tenant_and_download_config(self):
        for provider in recipe.GRAPH_READS:
            for field in ("connection_id", "provider", "drive_id", "site_id", "download_host", "url", "headers", "access_token"):
                with self.subTest(provider=provider, field=field):
                    tools = self.tools(provider)
                    tools[0]["inputSchema"]["properties"][field] = {"type": "string"}
                    with self.assertRaisesRegex(ValueError, "host config"):
                        recipe.verify_read_tools(provider, tools)


if __name__ == "__main__":
    unittest.main()
