"""Finite beta50 Python release candidate; no publication, provider grant or App build.

Build only server/CLI; reuse unchanged public components byte for byte. Run on
one approved Linux worker, with a clean frozen product checkout and fresh output.
"""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import urllib.request
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://github.com/openagent-uno/"
PUBLIC = (
    ("openagent", "v1.1.0-beta.50", "598b000a01f0e04eeecd0ce8c6acb7ebddb79a70b5a7d087e433755d51ca3be3"),
    ("openagent-core", "v1.1.0-beta.22", "291be9e298c1035ae88079b849620e9a8a04e03f43dd9180f86ebe6e79f4876d"),
    ("openagent-tools", "v1.0.0-beta.4", "20b583195ac624c8f46a3c484eb596a5545dc514d60cbe7ed12e7b6f4da48228"),
    ("openagent-tools", "connectors-v0.1.12", "4b864472df3cbfd01131b0c152d94da81ff6f3f161e976bbbe4c768c56fb87c9"),
)
# Public beta50 carries the complete aggregate source inventory. Its seven
# reused wheel rows remain bound to its reviewed beta49 origin; no older
# manifest is fetched or used as an alternate source of release bytes.
REUSED_ORIGIN = ("v1.1.0-beta.49", "c2931a7ab65418615807e3d2ae7e5b715ab3f834c9dbc2ae1d704e4be1aa3c12")
REUSED_PREFIXES = ("apps/mcp-bridge/", "packages/identity/", "packages/dashboards/",
                   "packages/client-transport/", "packages/product-config/", "packages/integrations/support/")
REBUILT = {"openagent-framework", "openagent-cli"}

# Finite candidate18 identities; public bytes/digest are required before any execution.
SDK18_MANUAL = {
    'agentmail': ('agentmail', 'files', ('files.agentmail.inboxes.list', 'files.agentmail.inboxes.get')),
    'ahrefs': ('ahrefs', 'files', ('files.ahrefs.domain_rating.get', 'files.ahrefs.metrics.get')),
    'airtable': ('airtable', 'files', ('files.airtable.bases.list', 'files.airtable.tables.list')),
    'apollo': ('apollo', 'files', ('files.apollo.organizations.search', 'files.apollo.people.search')),
    'asana': ('asana', 'files', ('files.asana.projects.list', 'files.asana.tasks.list')),
    'ashby': ('ashby', 'files', ('files.ashby.jobs.list', 'files.ashby.candidates.list')),
    'attio': ('attio', 'files', ('files.attio.objects.list', 'files.attio.lists.list')),
    'beehiiv': ('beehiiv', 'files', ('files.beehiiv.publications.list', 'files.beehiiv.publications.get')),
    'better-stack': ('better_stack', 'files', ('files.better_stack.monitor_groups.get', 'files.better_stack.monitor_groups.monitors.list')),
    'box': ('box', 'files', ('files.box.folders.items.list', 'files.box.files.get')),
    'brevo': ('brevo', 'outreach', ('outreach.brevo.contacts.list', 'outreach.brevo.account.get')),
    'brex': ('brex', 'files', ('files.brex.users.list', 'files.brex.departments.list')),
    'cal-com': ('cal_com', 'files', ('files.cal_com.profile.get', 'files.cal_com.bookings.get')),
    'calendly': ('calendly', 'files', ('files.calendly.users.me', 'files.calendly.event_types.list')),
    'canva': ('canva', 'files', ('files.canva.designs.list', 'files.canva.designs.get')),
    'capsule': ('capsule', 'files', ('files.capsule.parties.list', 'files.capsule.opportunities.list')),
    'close': ('close', 'files', ('files.close.leads.list', 'files.close.contacts.list')),
    'cloudflare': ('cloudflare', 'files', ('files.cloudflare.zones.list', 'files.cloudflare.accounts.list')),
    'coda': ('coda', 'files', ('files.coda.identity.get', 'files.coda.docs.get')),
    'coinmarketcap': ('coinmarketcap', 'files', ('files.coinmarketcap.cryptocurrencies.map', 'files.coinmarketcap.global_metrics.get')),
    'contentful': ('contentful', 'files', ('files.contentful.content_types.list', 'files.contentful.assets.list')),
    'courtlistener': ('courtlistener', 'files', ('files.courtlistener.opinions.search', 'files.courtlistener.oral_arguments.search')),
    'customer-io': ('customer_io', 'files', ('files.customer_io.campaigns.list', 'files.customer_io.campaigns.get')),
    'digitalocean': ('digitalocean', 'files', ('files.digitalocean.droplets.list', 'files.digitalocean.projects.list')),
    'dovetail': ('dovetail', 'files', ('files.dovetail.projects.list', 'files.dovetail.projects.get')),
    'dropbox': ('dropbox', 'files', ('files.dropbox.folders.list', 'files.dropbox.metadata.get')),
    'elevenlabs': ('elevenlabs', 'files', ('files.elevenlabs.voices.list', 'files.elevenlabs.models.list')),
    'fathom': ('fathom', 'files', ('files.fathom.meetings.list', 'files.fathom.recordings.transcript')),
    'figma': ('figma', 'files', ('files.figma.user.get', 'files.figma.files.get')),
    'financial-datasets': ('financial_datasets', 'files', ('files.financial_datasets.income_statements.list', 'files.financial_datasets.prices.snapshot')),
    'fireflies': ('fireflies', 'files', ('files.fireflies.transcripts.list', 'files.fireflies.transcripts.get')),
    'front': ('front', 'files', ('files.front.company.get', 'files.front.inboxes.list')),
    'gitbook': ('gitbook', 'files', ('files.gitbook.organizations.list', 'files.gitbook.organizations.get')),
    'gitlab': ('gitlab', 'files', ('files.gitlab.projects.list', 'files.gitlab.issues.list')),
    'grain': ('grain', 'files', ('files.grain.recordings.list', 'files.grain.recordings.get')),
    'gusto': ('gusto', 'files', ('files.gusto.token.info', 'files.gusto.companies.get')),
    'heygen': ('heygen', 'files', ('files.heygen.avatars.list', 'files.heygen.voices.list')),
    'honeycomb': ('honeycomb', 'files', ('files.honeycomb.datasets.list', 'files.honeycomb.datasets.get')),
    'hubspot': ('hubspot', 'files', ('files.hubspot.contacts.list', 'files.hubspot.companies.list')),
    'hugging-face': ('hugging_face', 'files', ('files.hugging_face.models.list', 'files.hugging_face.datasets.list')),
    'hunter': ('hunter', 'files', ('files.hunter.account.get', 'files.hunter.domains.search')),
    'incident-io': ('incident_io', 'files', ('files.incident_io.incidents.list', 'files.incident_io.roles.list')),
    'instantly': ('instantly', 'outreach', ('outreach.instantly.campaigns.list', 'outreach.instantly.campaigns.get')),
    'klaviyo': ('klaviyo', 'outreach', ('outreach.klaviyo.profiles.list', 'outreach.klaviyo.campaigns.list')),
    'launchdarkly': ('launchdarkly', 'files', ('files.launchdarkly.projects.list', 'files.launchdarkly.flags.list')),
    'lemlist': ('lemlist', 'outreach', ('outreach.lemlist.campaigns.list', 'outreach.lemlist.campaigns.get')),
    'linear': ('linear', 'files', ('files.linear.issues.list', 'files.linear.projects.list')),
    'lucid': ('lucid', 'files', ('files.lucid.documents.get', 'files.lucid.threads.list')),
    'mailerlite': ('mailerlite', 'files', ('files.mailerlite.groups.list', 'files.mailerlite.segments.list')),
    'massive': ('massive', 'files', ('files.massive.tickers.list', 'files.massive.market_status.get')),
    'miro': ('miro', 'files', ('files.miro.boards.list', 'files.miro.boards.search')),
    'monday': ('monday', 'files', ('files.monday.boards.list', 'files.monday.items.list')),
    'neon': ('neon', 'files', ('files.neon.projects.list', 'files.neon.projects.get')),
    'netlify': ('netlify', 'files', ('files.netlify.sites.list', 'files.netlify.sites.get')),
    'nifty': ('nifty', 'files', ('files.nifty.projects.list', 'files.nifty.projects.get')),
    'omnisend': ('omnisend', 'files', ('files.omnisend.campaigns.list', 'files.omnisend.campaigns.get')),
    'onesignal': ('onesignal', 'files', ('files.onesignal.apps.list', 'files.onesignal.apps.get')),
    'pandadoc': ('pandadoc', 'files', ('files.pandadoc.documents.list', 'files.pandadoc.documents.details')),
    'pendo': ('pendo', 'files', ('files.pendo.features.list', 'files.pendo.pages.list')),
    'posthog': ('posthog', 'files', ('files.posthog.projects.list', 'files.posthog.projects.get')),
    'postman': ('postman', 'files', ('files.postman.collections.list', 'files.postman.collections.get')),
    'quo': ('quo', 'files', ('files.quo.phone_numbers.list', 'files.quo.conversations.list')),
    'railway': ('railway', 'files', ('files.railway.account.get', 'files.railway.projects.get')),
    'ramp': ('ramp', 'files', ('files.ramp.users.list', 'files.ramp.users.get')),
    'read-ai': ('read_ai', 'files', ('files.read_ai.meetings.list', 'files.read_ai.meetings.get')),
    'readwise': ('readwise', 'files', ('files.readwise.books.list', 'files.readwise.highlights.list')),
    'render': ('render', 'files', ('files.render.services.list', 'files.render.deploys.list')),
    'resend': ('resend', 'outreach', ('outreach.resend.domains.list', 'outreach.resend.domains.get')),
    'revenuecat': ('revenuecat', 'files', ('files.revenuecat.projects.list', 'files.revenuecat.apps.list')),
    'rootly': ('rootly', 'files', ('files.rootly.incidents.list', 'files.rootly.services.list')),
    'signnow': ('signnow', 'files', ('files.signnow.documents.list', 'files.signnow.documents.get')),
    'smartsheet': ('smartsheet', 'files', ('files.smartsheet.sheets.list', 'files.smartsheet.sheets.get')),
    'spotify': ('spotify', 'files', ('files.spotify.playlists.list', 'files.spotify.saved_tracks.list')),
    'statsig': ('statsig', 'files', ('files.statsig.gates.list', 'files.statsig.experiments.list')),
    'stripe': ('stripe', 'commerce', ('commerce.stripe.customers.list', 'commerce.stripe.invoices.list')),
    'supabase': ('supabase', 'files', ('files.supabase.projects.list', 'files.supabase.projects.get')),
    'surveymonkey': ('surveymonkey', 'files', ('files.surveymonkey.surveys.list', 'files.surveymonkey.surveys.details')),
    'tally': ('tally', 'files', ('files.tally.forms.list', 'files.tally.submissions.list')),
    'tavily': ('tavily', 'files', ('files.tavily.search', 'files.tavily.usage.get')),
    'ticktick': ('ticktick', 'files', ('files.ticktick.projects.list', 'files.ticktick.projects.get')),
    'todoist': ('todoist', 'files', ('files.todoist.projects.list', 'files.todoist.tasks.list')),
    'typeform': ('typeform', 'files', ('files.typeform.forms.list', 'files.typeform.responses.list')),
    'vercel': ('vercel', 'files', ('files.vercel.projects.list', 'files.vercel.deployments.list')),
    'webex': ('webex', 'files', ('files.webex.people.self', 'files.webex.rooms.list')),
    'webflow': ('webflow', 'files', ('files.webflow.sites.list', 'files.webflow.collections.list')),
    'wistia': ('wistia', 'files', ('files.wistia.media.list', 'files.wistia.folders.list')),
    'workos': ('workos', 'files', ('files.workos.organizations.list', 'files.workos.directories.list')),
    'wrike': ('wrike', 'files', ('files.wrike.contacts.self', 'files.wrike.tasks.list')),
    'ynab': ('ynab', 'files', ('files.ynab.user.get', 'files.ynab.plans.list')),
    'zoom': ('zoom', 'files', ('files.zoom.meetings.list', 'files.zoom.meetings.get')),
}
# Manually supplied tokens have no verified OAuth scope claims; vendor permissions remain Setup documentation.
SDK17_IDS = frozenset(['atlassian', 'billingbear', 'clickup', 'coingecko', 'context7', 'exa', 'firecrawl', 'github', 'gmail', 'google-analytics', 'google-calendar', 'google-drive', 'imap_smtp', 'notion', 'outlook-calendar', 'outlook-mail', 'parallel-search', 'pipeboard', 'postiz', 'replio', 'shopify', 'slack-import'])
GRAPH_READS = {"onedrive": ("Files.Read", {"drives.list", "drives.get", "items.list", "items.get", "items.content"}), "sharepoint": ("Sites.Read.All", {"sites.search", "sites.get", "drives.list", "drives.get", "items.list", "items.get", "items.content"})}
BRANDMARK_PROVIDERS = frozenset(['airtable', 'asana', 'better_stack', 'box', 'brevo', 'brex', 'cal_com', 'calendly', 'cloudflare', 'coda', 'coinmarketcap', 'contentful', 'digitalocean', 'dovetail', 'dropbox', 'elevenlabs', 'figma', 'gitbook', 'gitlab', 'gusto', 'hubspot', 'hugging_face', 'linear', 'lucid', 'miro', 'neon', 'netlify', 'posthog', 'postman', 'railway', 'render', 'resend', 'revenuecat', 'spotify', 'stripe', 'supabase', 'surveymonkey', 'ticktick', 'todoist', 'typeform', 'vercel', 'webex', 'webflow', 'wistia', 'zoom'])
CANONICAL_BRANDMARK = re.compile(r'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#[0-9A-F]{6}" d="[Mm][MmZzLlHhVvCcSsQqTtAa0-9eE.,+ -]*"/></svg>')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch(repository, tag, name, expected):
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("A reviewed public asset checksum is required: " + tag)
    if Path(name).name != name:
        raise ValueError("Unsafe release asset name")
    request = urllib.request.Request(BASE + repository + "/releases/download/" + tag + "/" + name,
                                     headers={"User-Agent": "openagent-product45-qualification"})
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


def require_public_checksums(releases):
    if any(not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected)
           for _, _, expected in releases):
        raise ValueError("SDK0.1.12 public manifest checksum is pending; qualification cannot run")


def verify_catalog_metadata(items, expected):
    """The installed catalog must equal the checksum-bound public SDK catalog."""
    if not isinstance(items, list) or items != expected or any(not isinstance(row, dict) for row in items):
        raise ValueError("Installed catalog differs from public SDK bytes")
    ids = [row.get("id") for row in items]
    if len(ids) != 115 or len(set(ids)) != 115:
        raise ValueError("SDK18 catalog inventory differs")
    official = {row["id"]: row for row in items if not row.get("nativeKind")}
    custom = [row for row in items if row.get("nativeKind")]
    if (set(official) != SDK17_IDS | set(SDK18_MANUAL) | set(GRAPH_READS)
            or [(row["id"], row["nativeKind"]) for row in custom] != [("custom-mcp", "custom_mcp")]):
        raise ValueError("SDK18 exact official/custom identities differ")
    for identifier, (provider, capability, reads) in SDK18_MANUAL.items():
        row = official[identifier]
        url, instructions, svg = row.get("setupUrl"), row.get("setupInstructions"), row.get("logoSvg", "")
        parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
        if (row.get("provider") != provider or row.get("capability") != capability or row.get("auth") != "token"
                or row.get("available") is not True or row.get("agentTools") != []
                or not isinstance(row.get("readTools"), list) or len(row["readTools"]) != 2
                or set(row["readTools"]) != set(reads)):
            raise ValueError("SDK18 manual read-only catalog contract differs")
        if (parsed is None or parsed.scheme != "https" or not parsed.hostname
                or parsed.username is not None or parsed.password is not None or len(url) > 2048
                or not isinstance(instructions, str) or not 40 <= len(instructions) <= 4096
                or any(ord(char) < 32 for char in instructions)):
            raise ValueError("SDK18 setup metadata differs")
        if provider in BRANDMARK_PROVIDERS:
            if (not isinstance(svg, str) or len(svg.encode()) > 32768
                    or CANONICAL_BRANDMARK.fullmatch(svg) is None):
                raise ValueError("SDK18 brandmark grammar differs")
        elif svg != "":
            raise ValueError("SDK18 missing brandmark must remain absent")
    for provider, (_, suffixes) in GRAPH_READS.items():
        row = official[provider]
        reads = {"files." + provider + "." + operation for operation in suffixes}
        if (row.get("provider") != provider or row.get("capability") != "files" or row.get("auth") != "oauth"
                or row.get("available") is not True or row.get("agentTools") != []
                or not isinstance(row.get("readTools"), list) or len(row["readTools"]) != len(reads)
                or set(row["readTools"]) != reads):
            raise ValueError("SDK18 Graph read-only catalog contract differs")
    return {"official": 114, "custom": 1, "manual_read_operations": 180, "graph_read_operations": 12,
            "brandmarks": 45, "provider_calls": 0}


def verify_read_tools(identifier, tools):
    if identifier in GRAPH_READS:
        scope, suffixes = GRAPH_READS[identifier]
        provider, capability = identifier, "files"
        expected = {"files." + provider + "." + operation: [scope] for operation in suffixes}
    else:
        provider, capability, reads = SDK18_MANUAL[identifier]
        expected = {name: [] for name in reads}
    if (not isinstance(tools, list) or any(not isinstance(tool, dict) for tool in tools)
            or len(tools) != len(expected) or {tool.get("name") for tool in tools} != set(expected)):
        raise ValueError("SDK18 installed read operation identities differ")
    for tool in tools:
        schema = tool.get("inputSchema")
        if (tool.get("provider") != provider or tool.get("capability") != capability
                or tool.get("mode") != "typed" or tool.get("risk") != "read"
                or tool.get("required_scopes", []) != expected[tool["name"]]
                or tool.get("retry", {}).get("max_attempts") != 1
                or not isinstance(schema, dict) or schema.get("type") != "object"
                or schema.get("additionalProperties") is not False
                or not isinstance(schema.get("properties"), dict)):
            raise ValueError("SDK18 installed read scope/risk/schema/retry differs")
        properties = schema["properties"]
        binding = properties.get("provider", {})
        if identifier not in GRAPH_READS and ("connection_id" not in properties
                or not (binding.get("const") == provider or binding.get("enum") == [provider])):
            raise ValueError("SDK18 installed manual read binding differs")
        if identifier in GRAPH_READS and set(properties) & {"connection_id", "provider", "drive_id", "site_id", "download_host", "bound_site_id", "bound_drive_id", "url", "headers", "access_token"}:
            raise ValueError("SDK18 Graph host config must not become caller arguments")
    return {"catalog_id": identifier, "operations": len(tools), "provider_calls": 0}


def main():
    global ROOT
    # The attachment release has a different exact dependency closure. Keep
    # the connector-specific historical recipe and its provenance immutable.
    if "--profile=attachments-beta52" in sys.argv:
        from qualify_attachment_product_release import main as attachment_main
        attachment_main([arg for arg in sys.argv[1:] if arg != "--profile=attachments-beta52"])
        return
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
    require_public_checksums(PUBLIC)
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
        receipt["stages"].append("separate-source-provenance-and-catalog-pure-guards-before-fetch-and-build")
        run([node, "-e", "const assert=require('assert/strict');assert.equal(process.versions.node.split('.')[0],'24');assert.equal(require('react/package.json').version,'19.0.0');assert.equal(require('react-test-renderer/package.json').version,'19.0.0');assert.equal(require('typescript/package.json').version,'5.9.3');console.log(JSON.stringify({node:process.versions.node,react:require('react/package.json').version,renderer:require('react-test-renderer/package.json').version,typescript:require('typescript/package.json').version}));"], "node-source-fixture-tools.log")
        manifests = {}
        for repository, tag, expected in PUBLIC:
            body = fetch(repository, tag, "manifest.json", expected)
            manifests[tag] = json.loads(body)
            (evidence / (tag + "-manifest.json")).write_bytes(body)
        sdk = manifests["connectors-v0.1.12"]
        catalog_entry = sdk["files"]["catalog.json"]
        catalog_bytes = fetch("openagent-tools", "connectors-v0.1.12", "catalog.json", catalog_entry["sha256"])
        if len(catalog_bytes) != catalog_entry["bytes"]:
            raise ValueError("Public SDK catalog size differs")
        public_catalog = json.loads(catalog_bytes)
        verify_catalog_metadata(public_catalog, public_catalog)
        (evidence / "sdk18-public-catalog.json").write_bytes(catalog_bytes)
        baseline = manifests["v1.1.0-beta.50"]
        current = subprocess.check_output(["git", "ls-files", "-z", *REUSED_PREFIXES], cwd=ROOT).decode().split("\0")
        expected_sources = verified_reused_sources(ROOT, baseline, set(current) - {""})
        lock = json.loads((ROOT / "apps/server/connectors.lock.json").read_text())
        sdk = manifests["connectors-v0.1.12"]
        if lock["version"] != "0.1.12" or lock["manifest_sha256"] != PUBLIC[3][2] or lock["source_commit"] != sdk["source_commit"] or lock["assets"] != sdk["files"]:
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
                if not name.endswith(".whl") or (tag == "v1.1.0-beta.50" and metadata["name"] in REBUILT):
                    continue
                body = fetch(repository, tag, name, metadata["sha256"])
                if "bytes" in metadata and len(body) != metadata["bytes"]:
                    raise ValueError("Public wheel size mismatch")
                target = wheels if tag == "v1.1.0-beta.50" else public
                (target / name).write_bytes(body)
                if tag == "v1.1.0-beta.50":
                    reused.append(metadata)
        if len(reused) != 7:
            raise ValueError("Unexpected immutable product component set")
        # The builder requires a wheel-empty directory; reused wheels are kept separate until it completes.
        rebuilt = output / "rebuilt"
        run([sys.executable, ROOT / "scripts/build_wheels.py", "--out", rebuilt, "--components", "server", "cli"], "build-two-wheels.log")
        helpers = runpy.run_path(str(ROOT / "scripts/build_wheels.py"))
        candidate = json.loads((rebuilt / "manifest.json").read_text())
        if candidate["dirty_snapshot"] or candidate["repository_commit"] != args.source_sha or {row["name"] for row in candidate["wheels"]} != REBUILT or any(row["version"] != "1.1.0b51" for row in candidate["wheels"]):
            raise ValueError("New component version/source mismatch")
        for path in rebuilt.glob("*.whl"):
            shutil.copyfile(path, wheels / path.name)
        helpers["verify_ownership"](sorted(wheels.glob("*.whl")))
        candidate["wheels"].extend(reused)
        candidate["upstream_components"] = baseline.get("upstream_components", {})
        candidate["reused_product_components"] = {"release": "v1.1.0-beta.50", "manifest_sha256": PUBLIC[0][2],
                                                   "verified_source_files": len(expected_sources), "wheels": reused,
                                                   "source_provenance": {"release": "v1.1.0-beta.50",
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
                               ("tests/test_official_connector_microsoft_resources.py", "server/test_official_connector_microsoft_resources.py"),
                               ("apps/cli/tests/test_microsoft_connector_resources.py", "cli/test_microsoft_connector_resources.py"),
                               ("tests/test_connector_privacy_receipts.py", "server/test_connector_privacy_receipts.py"),
                               ("tests/test_connector_privacy.py", "server/test_connector_privacy.py"),
                               ("tests/test_connector_privacy_api.py", "server/test_connector_privacy_api.py"),
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
        contract = fixtures / "catalog_contract.py"
        contract.write_text("import re,urllib.parse\nSDK18_MANUAL=" + repr(SDK18_MANUAL)
            + "\nSDK17_IDS=" + repr(SDK17_IDS)
            + "\nGRAPH_READS=" + repr(GRAPH_READS) + "\nBRANDMARK_PROVIDERS=" + repr(BRANDMARK_PROVIDERS)
            + "\nCANONICAL_BRANDMARK=re.compile(" + repr(CANONICAL_BRANDMARK.pattern) + ")\n"
            + inspect.getsource(verify_catalog_metadata) + "\n" + inspect.getsource(verify_read_tools))
        probe = fixtures / "installed_probe.py"
        probe.write_text('''import asyncio,importlib,importlib.metadata as m,json,pathlib,sys
for name,version in {'openagent-framework':'1.1.0b51','openagent-cli':'1.1.0b51','openagent-connectors':'0.1.12','openagent-core':'1.1.0b22','openagent-host-tools':'1.0.0b6'}.items():assert m.version(name)==version
for name in ('openagent_server','openagent_cli','openagent_connectors','openagent_core','openagent_host_tools'):
 module=importlib.import_module(name);assert pathlib.Path(sys.prefix).resolve() in pathlib.Path(module.__file__).resolve().parents
from openagent_server.connector_acquisition import acquire
from openagent_connectors import ConnectorRunner
import runpy
contract=runpy.run_path(str(pathlib.Path(__file__).with_name('catalog_contract.py')))
SDK18_MANUAL=contract['SDK18_MANUAL'];GRAPH_READS=contract['GRAPH_READS']
verify_catalog_metadata=contract['verify_catalog_metadata'];verify_read_tools=contract['verify_read_tools']
async def main():
 root=pathlib.Path(sys.argv[1]);bundle=acquire(pathlib.Path(sys.argv[2]),'linux-x64',root/'runner',root/'acquired-wheels')
 runner=ConnectorRunner(bundle/'bin/openagent-connector-runner',identity_file=root/'probe-identity.json',product='generic-host',name='Release fixture')
 try:
  items=await runner.call('catalog');official=[row for row in items if not row.get('nativeKind')];custom=[row for row in items if row.get('nativeKind')]
  expected=json.loads(pathlib.Path(sys.argv[3]).read_bytes())
  verify_catalog_metadata(items,expected)
  contracts=[]
  for catalog_id,(provider,capability,_) in sorted(SDK18_MANUAL.items()):
   scopes=[] # Manual token permissions are documentation, not an attested OAuth grant.
   binding={'catalog_id':catalog_id,'allow_write':False,'principal':{'workspace_id':'metadata-fixture','actor_id':'owner'},'connection':{'id':'metadata-connection','workspace_id':'metadata-fixture','provider':provider,'capability':capability,'enabled':True,'external_id':'metadata-account','scopes':scopes,'config':{}}}
   contracts.append(verify_read_tools(catalog_id,await runner.call('tools',binding)))
  for provider,(scope,_) in GRAPH_READS.items():
   binding={'catalog_id':provider,'allow_write':False,'principal':{'workspace_id':'metadata-fixture','actor_id':'owner'},'connection':{'id':'metadata-connection','workspace_id':'metadata-fixture','provider':provider,'capability':'files','enabled':True,'external_id':'metadata-account','scopes':[scope],'config':{}}}
   contracts.append(verify_read_tools(provider,await runner.call('tools',binding)))
  for catalog_id,provider in (('exa','exa'),('firecrawl','firecrawl'),('parallel-search','parallel_search'),('context7','context7'),('coingecko','coingecko')):
   item=next(row for row in official if row['id']==catalog_id)
   assert item['auth']=='none' and item['provider']==provider and item['capability']=='files' and not item['agentTools']
  for catalog_id,provider,capability,reads,writes in (('google-calendar','google_calendar','files',4,3),('outlook-mail','outlook_mail','outreach',6,3),('outlook-calendar','outlook_calendar','files',4,3)):
   item=next(row for row in official if row['id']==catalog_id)
   assert item['auth']=='oauth' and item['provider']==provider and item['capability']==capability and len(item['readTools'])==reads and len(item['agentTools'])==writes
  print(json.dumps({'official':len(official),'custom':len(custom),'manual_read_operations':180,'graph_read_operations':12,'brandmarks':45,'tools_contracts':contracts,'provider_calls':0,'imports_from_installed_prefix':True}))
 finally:await runner.close()
asyncio.run(main())
''')
        run([python, "-I", probe, output, ROOT / "apps/server/connectors.lock.json", evidence / "sdk18-public-catalog.json"], "installed-catalog.log", fixtures)
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
