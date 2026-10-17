"""Finite beta44 Python release candidate; no publication, provider grant or App build.

Build only server/CLI; reuse unchanged public components byte for byte. Run on
one approved Linux worker, with a clean frozen product checkout and fresh output.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://github.com/openagent-uno/"
PUBLIC = (
    ("openagent", "v1.1.0-beta.43", "0458e049e3bfeafafff7c677670bdc30eeeb7a70ec8e93eac1742f6e45ba5e63"),
    ("openagent-core", "v1.1.0-beta.22", "291be9e298c1035ae88079b849620e9a8a04e03f43dd9180f86ebe6e79f4876d"),
    ("openagent-tools", "v1.0.0-beta.4", "20b583195ac624c8f46a3c484eb596a5545dc514d60cbe7ed12e7b6f4da48228"),
    ("openagent-tools", "connectors-v0.1.7", "65af35daccdf93278bd31a61ff00fbaf907ab62ed4afe89ff77d1f0d18890a56"),
)
# Public beta43 carries the complete aggregate source inventory. Its seven
# reused wheel rows remain bound to its reviewed beta42 origin; no older
# manifest is fetched or used as an alternate source of release bytes.
REUSED_ORIGIN = ("v1.1.0-beta.42", "e6887ceb907bbabe844419d2de90d72c36c48205aa524bc6629f56a80cfb4af8")
REUSED_PREFIXES = ("apps/mcp-bridge/", "packages/identity/", "packages/dashboards/",
                   "packages/client-transport/", "packages/product-config/", "packages/integrations/support/")
REBUILT = {"openagent-framework", "openagent-cli"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch(repository, tag, name, expected):
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("A reviewed public asset checksum is required: " + tag)
    if Path(name).name != name:
        raise ValueError("Unsafe release asset name")
    request = urllib.request.Request(BASE + repository + "/releases/download/" + tag + "/" + name,
                                     headers={"User-Agent": "openagent-product44-qualification"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read((32 << 20) + 1)
    if len(data) > 32 << 20 or digest(data) != expected:
        raise ValueError("Public asset checksum/size bound mismatch: " + name)
    return data


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def source_digest(sources):
    # Exact algorithm used by scripts/build_wheels.py.
    return digest(json.dumps(sources, sort_keys=True, separators=(",", ":")).encode())


def verified_reused_sources(root, baseline, tracked):
    record = baseline["reused_product_components"]
    if (record["release"] != REUSED_ORIGIN[0]
            or record["manifest_sha256"] != REUSED_ORIGIN[1]):
        raise ValueError("Baseline reused-component provenance differs")
    wheel_rows = [row for row in baseline["wheels"] if row["name"] not in REBUILT]
    wheels = {row["file"]: row for row in wheel_rows}
    recorded = {row["file"]: row for row in record["wheels"]}
    if len(wheel_rows) != 7 or len(wheels) != 7 or len(record["wheels"]) != 7 or wheels != recorded:
        raise ValueError("Reused wheel metadata differs from baseline source proof")
    if source_digest(baseline["sources"]) != baseline["source_sha256"]:
        raise ValueError("Baseline source inventory digest differs")
    sources = {name: sha for name, sha in baseline["sources"].items() if name.startswith(REUSED_PREFIXES)}
    if len(sources) != 109 or record["verified_source_files"] != len(sources) or set(tracked) != set(sources):
        raise ValueError("Reused component source inventory drift")
    for name, expected in sources.items():
        path = root / name
        if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != expected:
            raise ValueError("Reused component source changed: " + name)
    return sources


def merge_source_provenance(candidate, reused_sources):
    if set(candidate["sources"]) & set(reused_sources):
        raise ValueError("Rebuilt and reused component source inventories overlap")
    candidate["sources"] = dict(sorted({**candidate["sources"], **reused_sources}.items()))
    candidate["source_sha256"] = source_digest(candidate["sources"])


def main():
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Clean frozen payload checkout, separate from this executor")
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--node-runtime", required=True, type=Path, help="Existing approved Node24 executable; never installed by this recipe")
    parser.add_argument("--node-modules", required=True, type=Path, help="Isolated React/renderer/TypeScript source-fixture dependencies")
    args = parser.parse_args()
    ROOT = args.source.resolve()
    if sys.platform != "linux" or sys.version_info[:2] != (3, 11):
        raise ValueError("Use the approved Linux Python3.11 worker")
    if any(not re.fullmatch(r"[0-9a-f]{64}", expected) for _, _, expected in PUBLIC):
        raise ValueError("SDK0.1.7 public manifest checksum is pending; qualification cannot run")
    node = args.node_runtime.resolve(strict=True)
    node_modules = args.node_modules.resolve(strict=True)
    if not node.is_file() or not node_modules.is_dir():
        raise ValueError("Existing approved Node fixture tools are required")
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() != args.source_sha:
        raise ValueError("Source differs from reviewed frozen commit")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT).strip():
        raise ValueError("Only clean committed source can be qualified")
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    evidence, wheels, public = (output / name for name in ("evidence", "product-assets", "public-wheels"))
    for path in (evidence, wheels, public):
        path.mkdir(mode=0o700)
    env = dict(os.environ, OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", UV_CONCURRENT_BUILDS="1",
               UV_CONCURRENT_DOWNLOADS="1", UV_CONCURRENT_INSTALLS="1", PYTHONDONTWRITEBYTECODE="1")
    env.pop("PYTHONPATH", None)
    env["NODE_PATH"] = str(node_modules)
    env["NODE_OPTIONS"] = "--max-old-space-size=512"
    receipt = {"format": 1, "status": "started", "source_commit": args.source_sha,
               "recipe_sha256": digest(Path(__file__).read_bytes()),
               "scope": "installed Python connector consumer plus separate source fixtures; no native App/installer or real provider acceptance",
               "publication": False, "provider_activation_performed": False, "real_provider_calls": 0, "stages": []}

    def run(command, log, cwd=ROOT):
        with (evidence / log).open("w") as stream:
            subprocess.run([str(item) for item in command], cwd=cwd, env=env,
                           stdout=stream, stderr=subprocess.STDOUT, check=True)

    try:
        run([sys.executable, "-I", "-m", "unittest", "discover", "-s", ROOT / "scripts/tests",
             "-p", "test_connector_product_release.py", "-v"], "source-provenance-guards.log")
        receipt["stages"].append("separate-source-provenance-four-pure-guards-before-fetch-and-build")
        run([node, "-e", "const assert=require('assert/strict');assert.equal(process.versions.node.split('.')[0],'24');assert.equal(require('react/package.json').version,'19.0.0');assert.equal(require('react-test-renderer/package.json').version,'19.0.0');assert.equal(require('typescript/package.json').version,'5.9.3');console.log(JSON.stringify({node:process.versions.node,react:require('react/package.json').version,renderer:require('react-test-renderer/package.json').version,typescript:require('typescript/package.json').version}));"], "node-source-fixture-tools.log")
        manifests = {}
        for repository, tag, expected in PUBLIC:
            body = fetch(repository, tag, "manifest.json", expected)
            manifests[tag] = json.loads(body)
            (evidence / (tag + "-manifest.json")).write_bytes(body)
        baseline = manifests["v1.1.0-beta.43"]
        current = subprocess.check_output(["git", "ls-files", "-z", *REUSED_PREFIXES], cwd=ROOT).decode().split("\0")
        expected_sources = verified_reused_sources(ROOT, baseline, set(current) - {""})
        lock = json.loads((ROOT / "apps/server/connectors.lock.json").read_text())
        sdk = manifests["connectors-v0.1.7"]
        if lock["version"] != "0.1.7" or lock["manifest_sha256"] != PUBLIC[3][2] or lock["source_commit"] != sdk["source_commit"] or lock["assets"] != sdk["files"]:
            raise ValueError("SDK consumer lock differs from public release")
        if (ROOT / "apps/server/connectors.lock.json").read_bytes() != (ROOT / "apps/server/src/openagent_server/connectors.lock.json").read_bytes():
            raise ValueError("Packaged and build connector locks differ")
        reused = []
        for repository, tag, _ in PUBLIC:
            manifest = manifests[tag]
            if "wheels" in manifest:
                entries = {entry["file"]: entry for entry in manifest["wheels"]}
            elif "artifacts" in manifest:
                entries = {entry["path"]: entry for entry in manifest["artifacts"]}
            else:
                entries = manifest["files"]
            for name, metadata in entries.items():
                if not name.endswith(".whl") or (tag == "v1.1.0-beta.43" and metadata["name"] in REBUILT):
                    continue
                body = fetch(repository, tag, name, metadata["sha256"])
                if "bytes" in metadata and len(body) != metadata["bytes"]:
                    raise ValueError("Public wheel size mismatch")
                target = wheels if tag == "v1.1.0-beta.43" else public
                (target / name).write_bytes(body)
                if tag == "v1.1.0-beta.43":
                    reused.append(metadata)
        if len(reused) != 7:
            raise ValueError("Unexpected immutable product component set")
        # The builder requires a wheel-empty directory; reused wheels are kept separate until it completes.
        rebuilt = output / "rebuilt"
        run([sys.executable, ROOT / "scripts/build_wheels.py", "--out", rebuilt, "--components", "server", "cli"], "build-two-wheels.log")
        helpers = runpy.run_path(str(ROOT / "scripts/build_wheels.py"))
        candidate = json.loads((rebuilt / "manifest.json").read_text())
        if candidate["dirty_snapshot"] or candidate["repository_commit"] != args.source_sha or {row["name"] for row in candidate["wheels"]} != REBUILT or any(row["version"] != "1.1.0b44" for row in candidate["wheels"]):
            raise ValueError("New component version/source mismatch")
        for path in rebuilt.glob("*.whl"):
            shutil.copyfile(path, wheels / path.name)
        helpers["verify_ownership"](sorted(wheels.glob("*.whl")))
        candidate["wheels"].extend(reused)
        candidate["upstream_components"] = baseline.get("upstream_components", {})
        candidate["reused_product_components"] = {"release": "v1.1.0-beta.43", "manifest_sha256": PUBLIC[0][2],
                                                   "verified_source_files": len(expected_sources), "wheels": reused,
                                                   "source_provenance": {"release": "v1.1.0-beta.43",
                                                                         "manifest_sha256": PUBLIC[0][2],
                                                                         "source_sha256": baseline["source_sha256"]}}
        merge_source_provenance(candidate, expected_sources)
        receipt["stages"].append("two-new-wheels-seven-byte-identical-public-components")
        installed = output / "installed"
        run(["uv", "venv", "--python", "3.11", installed], "venv.log")
        python = installed / "bin/python"
        constraints = output / "constraints.txt"
        constraints.write_text("hf-xet==1.7.0\nlitellm==1.105.0\npydantic==2.14.1\npydantic-core==2.50.1\nSQLAlchemy==2.1.4\nPyJWT==2.14.0\nurllib3==2.8.0\n")
        run(["uv", "pip", "install", "--python", python, "--constraint", constraints,
             *sorted(wheels.glob("*.whl")), *sorted(public.glob("*.whl")),
             "openagent-core[engine,providers,modules]==1.1.0b22", "pytest", "pytest-asyncio"], "normal-install.log")
        run(["uv", "pip", "check", "--python", python], "pip-check.log")
        fixtures = output / "fixtures"
        for source, target in (("tests/test_official_connectors.py", "server/test_official_connectors.py"),
                               ("tests/test_connector_privacy_receipts.py", "server/test_connector_privacy_receipts.py"),
                               ("apps/cli/tests/test_official_connectors.py", "cli/test_official_connectors.py")):
            path = fixtures / target
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / source, path)
        # Copy only the existing readiness test helpers/cases; all runtime imports remain installed wheels.
        readiness = fixtures / "readiness"
        readiness.mkdir()
        for source, name in (("_framework.py", "_framework.py"), ("test_operational_api.py", "operational_cases.py")):
            shutil.copyfile(ROOT / "apps/server/scripts/tests" / source, readiness / name)
        readiness_probe = fixtures / "readiness_probe.py"
        readiness_probe.write_text('''import asyncio,importlib.util,json,pathlib,sys,types
root=pathlib.Path(__file__).parent/'readiness'
package=types.ModuleType('qualified_readiness');package.__path__=[str(root)];sys.modules['qualified_readiness']=package
spec=importlib.util.spec_from_file_location('qualified_readiness.operational_cases',root/'operational_cases.py')
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
asyncio.run(module.t_workflow_detail_warming_response(None))
print(json.dumps({'status':'passed','warming_503_then_authorized_200':True,'other_verified_user_denied':True,'runtime_from_installed_wheels':True,'copied_test_helpers_only':True}))
''')
        probe = fixtures / "installed_probe.py"
        probe.write_text('''import asyncio,importlib,importlib.metadata as m,json,pathlib,sys
for name,version in {'openagent-framework':'1.1.0b44','openagent-cli':'1.1.0b44','openagent-connectors':'0.1.7','openagent-core':'1.1.0b22','openagent-host-tools':'1.0.0b6'}.items():assert m.version(name)==version
for name in ('openagent_server','openagent_cli','openagent_connectors','openagent_core','openagent_host_tools'):
 module=importlib.import_module(name);assert pathlib.Path(sys.prefix).resolve() in pathlib.Path(module.__file__).resolve().parents
from openagent_server.connector_acquisition import acquire
from openagent_connectors import ConnectorRunner
async def main():
 root=pathlib.Path(sys.argv[1]);bundle=acquire(pathlib.Path(sys.argv[2]),'linux-x64',root/'runner',root/'acquired-wheels')
 runner=ConnectorRunner(bundle/'bin/openagent-connector-runner',identity_file=root/'probe-identity.json',product='generic-host',name='Release fixture')
 try:
  items=await runner.call('catalog');official=[row for row in items if not row.get('nativeKind')];custom=[row for row in items if row.get('nativeKind')]
  assert len(official)==22 and len(items)==23 and [(row['id'],row['nativeKind']) for row in custom]==[('custom-mcp','custom_mcp')]
  assert set(row['id'] for row in official)=={'atlassian','billingbear','clickup','coingecko','context7','exa','firecrawl','github','gmail','google-analytics','google-calendar','google-drive','imap_smtp','notion','outlook-calendar','outlook-mail','parallel-search','pipeboard','postiz','replio','shopify','slack-import'}
  for catalog_id,provider in (('exa','exa'),('firecrawl','firecrawl'),('parallel-search','parallel_search'),('context7','context7'),('coingecko','coingecko')):
   item=next(row for row in official if row['id']==catalog_id)
   assert item['auth']=='none' and item['provider']==provider and item['capability']=='files' and not item['agentTools']
  for catalog_id,provider,capability,reads,writes in (('google-calendar','google_calendar','files',4,3),('outlook-mail','outlook_mail','outreach',6,3),('outlook-calendar','outlook_calendar','files',4,3)):
   item=next(row for row in official if row['id']==catalog_id)
   assert item['auth']=='oauth' and item['provider']==provider and item['capability']==capability and len(item['readTools'])==reads and len(item['agentTools'])==writes
  print(json.dumps({'official':len(official),'custom':len(custom),'provider_calls':0,'imports_from_installed_prefix':True}))
 finally:await runner.close()
asyncio.run(main())
''')
        run([python, "-I", probe, output, ROOT / "apps/server/connectors.lock.json"], "installed-catalog.log", fixtures)
        run([python, "-I", "-m", "pytest", "--asyncio-mode=auto", "--import-mode=importlib", "-q", fixtures / "server", fixtures / "cli"], "installed-tests.log", fixtures)
        run([python, "-I", readiness_probe], "installed-run-detail-readiness.log", fixtures)
        # This fixture intentionally imports the source acquisition wrapper; do not call it installed-wheel evidence.
        run([python, "-I", "-m", "pytest", "-q", ROOT / "tests/test_connector_acquisition.py"], "source-acquisition-tests.log")
        receipt["stages"].append("separate-source-acquisition-boundary-fixtures")
        run([python, "-I", "-m", "pytest", "-q", ROOT / "scripts/tests/test_public_marketplace_visual.py"], "source-marketplace-cohort-guards.log")
        receipt["stages"].append("separate-source-marketplace-cohort-guards-no-gui-acceptance")
        receipt["stages"].append("normal-install-pipcheck-public-api-catalog-and-copied-tests")
        run([node, ROOT / "docs/qualification/official-connectors-pane.test.cjs", ROOT,
             evidence / "source-component-qualification.json"], "source-component-tests.log")
        receipt["stages"].append("separate-react-source-fixtures-keyless-cards-no-native-acceptance")
        receipt["status"] = "passed"
        write(evidence / "qualification.json", receipt)
        shutil.copyfile(evidence / "qualification.json", wheels / "qualification.json")
        candidate["qualification"] = {"scope": receipt["scope"], "status": "passed", "file": "qualification.json",
                                       "sha256": digest((wheels / "qualification.json").read_bytes())}
        write(wheels / "manifest.json", candidate)
        (wheels / "SHA256SUMS").write_text("".join(digest(path.read_bytes()) + "  " + path.name + "\n"
                                                 for path in sorted(wheels.iterdir()) if path.is_file() and path.name != "SHA256SUMS"))
    except BaseException as error:
        receipt.update(status="failed", reason=type(error).__name__)
        raise
    finally:
        write(evidence / "qualification.json", receipt)


if __name__ == "__main__":
    main()
