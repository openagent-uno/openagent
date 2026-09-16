# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec file for building the OpenAgent standalone executable.

Usage:
    Provision an isolated environment from the hash-locked release wheelhouse,
    then run ./scripts/build-executable.sh with OPENAGENT_HOST_TOOLS_BUNDLE
    pointing to the verified prebuilt native bundle. This spec never installs
    dependencies or compiles module resources inside installed packages.

Output: dist/openagent (single-file binary).

onefile mode is intentional: shipping a single ``openagent`` binary keeps
the downloads UX trivial ("drag it onto your PATH and run") and hides the
``_internal/`` directory PyInstaller normally exposes in onedir mode.
Each launch extracts the bundled archive into its own OS temporary
directory (``$TMPDIR/_MEI_xxxxx``), removed when the process exits.
"""

import os
import platform
import sys
from pathlib import Path
from importlib.resources import files
from importlib.metadata import distributions
from PyInstaller.utils.hooks import (
    collect_all,
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)
from openagent_host_tools import sidecar_source

# ── Build-environment guard ──
# Fail loudly if a runtime-critical dependency isn't importable in the build
# environment. ``collect_submodules()`` silently returns ``[]`` when the
# package is missing, which in the past produced a shipped binary that
# crashed at first ``serve`` invocation with ``ModuleNotFoundError: jinja2``.
# Importing here turns that silent failure into a loud build-time error.
import jinja2  # noqa: F401 — src.workflow.templating
import markupsafe  # noqa: F401 — jinja2's required runtime dep
import groq  # noqa: F401 — src.models.providers.groq (optional provider SDK, must ship in bundle)
import litellm  # noqa: F401 — TTS / STT dispatch (channels/tts.py, channels/voice.py)
import psutil  # noqa: F401 — cross-platform host telemetry (api/system.py)
import iroh  # noqa: F401 — P2P transport (src.network.iroh_node) — Rust FFI dylib must be bundled
import pydantic  # noqa: F401 — runtime calls importlib.metadata.version("pydantic")
import email_validator  # noqa: F401 — pydantic.EmailStr validation calls version("email-validator")
import telegram  # noqa: F401 — Telegram bridge is a first-class production channel
import numpy  # noqa: F401 — src.memory.semantic_index cosine (fast path; a pure-Python fallback covers a missing numpy, but bundle it for speed)

# Upstream CTranslate2 and Piper publish no Windows ARM64 distributions. The
# dependency markers intentionally keep local STT/TTS off that one platform;
# cloud voice remains available through LiteLLM. Everywhere else, retain the
# strict build guard so a missing local Whisper runtime still aborts packaging.
_windows_arm64 = sys.platform == "win32" and platform.machine().upper() == "ARM64"
if not _windows_arm64:
    import faster_whisper  # noqa: F401 — local-first STT fallback

# ``collect_all`` returns (datas, binaries, hiddenimports) for the WHOLE numpy
# package — the only reliable way to bundle its C extensions for numpy 2.x
# (plain collect_submodules shipped it absent twice). Spread into the three
# lists below.
_numpy_all = collect_all("numpy")

block_cipher = None

# ── Hidden imports ──
# These packages use dynamic imports that PyInstaller can't detect statically.

hiddenimports = [
    # litellm dynamically imports provider modules
    *collect_submodules("litellm"),
    # mcp transports
    *collect_submodules("mcp"),
    # croniter
    "croniter",
    # aiohttp
    *collect_submodules("aiohttp"),
    # aiosqlite
    "aiosqlite",
    # optional channel deps
    "telegram",
    "telegram.ext",
    "discord",
    "discord.ext.commands",
    # yaml
    "yaml",
    # click
    "click",
    # rich
    *collect_submodules("rich"),
    # anyio (used by MCP SDK)
    *collect_submodules("anyio"),
    # httpx (used by litellm)
    *collect_submodules("httpx"),
    # jinja2 (src.workflow.templating — SandboxedEnvironment for {{expr}}).
    # Explicit names are belt-and-suspenders next to ``collect_submodules``:
    # if the build env is ever missing jinja2 despite the top-of-file guard
    # (e.g. a future build script that bypasses ``pip install -e .[all]``),
    # at least these attempted imports make the failure mode obvious instead
    # of producing a binary that crashes only on the first ``serve`` call.
    "jinja2",
    "jinja2.environment",
    "jinja2.sandbox",
    "jinja2.ext",
    "jinja2.nodes",
    "jinja2.compiler",
    "jinja2.runtime",
    "jinja2.utils",
    "jinja2.filters",
    "jinja2.tests",
    "jinja2.loaders",
    "jinja2.defaults",
    "jinja2.lexer",
    "jinja2.parser",
    "jinja2.visitor",
    "jinja2.exceptions",
    "jinja2.bccache",
    "jinja2.idtracking",
    "jinja2.meta",
    "jinja2.optimizer",
    "jinja2.async_utils",
    "markupsafe",
    *collect_submodules("jinja2"),
    *collect_submodules("markupsafe"),
    # openagent submodules — collect_submodules("src") walks the entire
    # in-tree runtime including the inlined LLM provider drivers under
    # src.models.providers.* which native_provider.py loads dynamically
    # via importlib.import_module. No external agno collect is needed.
    *collect_submodules("openagent_core"),
    *collect_submodules("openagent_server"),
    *collect_submodules("openagent_identity"),
    *collect_submodules("openagent_dashboards"),
    *collect_submodules("openagent_product_config"),
    *collect_submodules("openagent_support"),
    *collect_submodules("openagent_storage_sqlite"),
    *collect_submodules("openagent_modules"),
    *collect_submodules("openagent_client_transport"),
    *collect_submodules("openagent_device_tools"),
    *collect_submodules("openagent_filesystem"),
    *collect_submodules("openagent_editor"),
    *collect_submodules("openagent_shell"),
    *collect_submodules("openagent_tool_protocol"),
    *collect_submodules("openagent_capability_host"),
    *collect_submodules("openagent_execution"),
    # openagent-mcp: the in-process agent-federation builtin
    # (src/mcp/servers/agent_federation) imports the standalone openagent-mcp
    # package — oa_agent_client (Iroh agent-ALPN wire core) + openagent_mcp
    # (tool layer). They're separate top-level packages, so
    # collect_submodules("src") doesn't reach them — bundle them explicitly.
    *collect_submodules("openagent_mcp"),
    *collect_submodules("oa_agent_client"),
    # Shared filesystem/editor core used by in-process MCPPool adapters.
    *collect_submodules("openagent_host_tools"),
    # groq Python SDK: imported at module level by
    # src.models.providers.groq.groq — must be bundled.
    *collect_submodules("groq"),
    # Voice: faster-whisper (local STT) loaded lazily inside _load_local_model;
    # ctranslate2 is its native runtime backend. Both are deliberately absent
    # only from Windows ARM64, matching the package markers above.
    *([] if _windows_arm64 else collect_submodules("faster_whisper")),
    *([] if _windows_arm64 else collect_submodules("ctranslate2")),
    # psutil ships per-OS C extension modules (_psutil_osx, _psutil_windows,
    # _psutil_linux) loaded via getattr/importlib — explicit collect so the
    # platform-correct one ends up in the frozen bundle.
    *collect_submodules("psutil"),
    # tiktoken_ext is a namespace package whose submodules (e.g. openai_public)
    # register encodings like cl100k_base via pkgutil.iter_modules at runtime.
    # collect_data_files alone bundles the JSON data but not the Python plugin
    # module, so the frozen binary ends up with "Plugins found: []" and any
    # tiktoken.get_encoding(...) call raises ValueError. litellm's
    # litellm_core_utils/default_encoding.py invokes get_encoding('cl100k_base')
    # at import time, which crashes the entire serve startup path
    # (telegram → channels.voice → litellm).
    *collect_submodules("tiktoken_ext"),
    *collect_submodules("tiktoken"),
    # iroh: ships a uniffi-generated FFI module that loads
    # ``libiroh_ffi.{so,dylib,dll}`` via ctypes at import time. Without
    # an explicit collect, PyInstaller's static analyzer misses the
    # dylib and the bundled binary crashes at first ``import iroh`` with
    # ``OSError: ...libiroh_ffi.so: cannot open shared object file``.
    "iroh",
    "iroh.iroh_ffi",
    *collect_submodules("iroh"),
    # pydantic + pydantic-core: dist-info metadata must be present in
    # the frozen bundle so that
    # ``importlib.metadata.version("pydantic")`` (called by
    # ``src.mcp._runtime.function.Function._wrap_callable`` at runtime)
    # and ``importlib.metadata.version("email-validator")`` (called by
    # pydantic.networks.import_email_validator) succeed. Without the
    # metadata, the agent raises "No package metadata was found for
    # pydantic" on the first tool-registration pass.
    *collect_submodules("pydantic"),
    *collect_submodules("pydantic_core"),
    *collect_submodules("email_validator"),
    # numpy: the FAST path for src.memory.semantic_index's cosine (there is a
    # pure-Python fallback, so a missing numpy no longer breaks recall — it just
    # runs slower). ``collect_submodules`` alone shipped it ABSENT twice for
    # numpy 2.x, so use ``collect_all`` below (datas+binaries+hiddenimports) —
    # the documented reliable way to bundle numpy's C extensions + data.
    *_numpy_all[2],
]

# ── Dynamic libs ──
# iroh's Rust FFI library (libiroh_ffi.{so,dylib,dll}) is loaded via
# ctypes.CDLL at import time, so PyInstaller's static analyzer doesn't
# see the dependency. ``collect_dynamic_libs`` finds the platform's
# .so/.dylib/.dll inside the installed iroh wheel and bundles it.
binaries = collect_dynamic_libs("iroh")
# numpy's compiled BLAS/C extensions (loaded at import) — from collect_all.
binaries += _numpy_all[1]

# ── Data files ──
# Reusable modules ship precompiled assets in their optional distribution.

from openagent_modules import module_assets
_vault_dir = module_assets("vault")
if not (_vault_dir / "dist").is_dir():
    raise RuntimeError("The installed vault module has no built runtime artifacts")

# Browser resources come from the verified device bundle. Packaging never
# installs dependencies or mutates the installed tools distribution.
_host_bundle = os.environ.get("OPENAGENT_HOST_TOOLS_BUNDLE", "").strip()
_release_build = os.environ.get("OPENAGENT_RELEASE_BUILD") == "1"
if _release_build and not _host_bundle:
    raise RuntimeError(
        "OPENAGENT_HOST_TOOLS_BUNDLE is required for a release server build"
    )
_aic_source = (
    Path(_host_bundle).resolve() / "agent-in-chrome"
    if _host_bundle
    else sidecar_source("agent-in-chrome")
)
_aic_dir = _aic_source / "host"
if not _aic_dir.exists():
    raise RuntimeError(f"Agent in Chrome source is missing from host-tools: {_aic_dir}")
if _host_bundle and not (_aic_dir / "node_modules").exists():
    raise RuntimeError(
        "The pinned host-tools bundle has no Agent in Chrome runtime dependencies"
    )
if not (_aic_dir / "node_modules").exists():
    raise RuntimeError("The installed browser tools have no bundled runtime dependencies")
_node_name = "node.exe" if sys.platform == "win32" else "node"
_node_binary = Path(_host_bundle) / _node_name
if not _node_binary.is_file():
    raise RuntimeError("The verified host-tools bundle has no Node runtime")
# The vault resolver checks the frozen extraction root, so the standalone
# server remains usable on a computer without a separate Node installation.
binaries.append((str(_node_binary), "."))

datas = []
datas += _numpy_all[0]  # numpy data files (from collect_all)
# Normative additive operational-storage/search schemas.  The runtime loads
# these through importlib.resources, so one-file builds must carry them too.
datas += collect_data_files("openagent_core.memory.operational", includes=["sql/*.sql"])
datas += collect_data_files("openagent_core", includes=["prompts/*.json"])
datas += collect_data_files("openagent_modules")
datas += collect_data_files("openagent_dashboards")
datas += collect_data_files("openagent_product_config")

# computer-control and Agent-in-Chrome are owned by the exact pinned
# openagent-host-tools package.  Keep the browser source/dependencies available
# at the same package-relative path used by sidecar_source() in a frozen build.
datas.append((str(_aic_source), "openagent_device_tools/sidecars/agent-in-chrome"))

# litellm needs its JSON data files (model prices, cost maps, etc.)
datas += collect_data_files("litellm", includes=["**/*.json", "**/*.yaml", "**/*.yml"])
# Encoding tables use extensionless SHA filenames. Without these packaged
# assets, LiteLLM's import-time cl100k_base setup attempts a network download.
datas += collect_data_files("litellm", includes=["litellm_core_utils/tokenizers/*"])
# tiktoken needs its encoding data
datas += collect_data_files("tiktoken")
datas += collect_data_files("tiktoken_ext")
# certifi CA bundle for HTTPS requests
datas += collect_data_files("certifi")
# mcp package data
datas += collect_data_files("mcp")
datas += collect_data_files("openagent_host_tools")

# ── Package metadata (``.dist-info``) ──
# ``importlib.metadata.version()`` reads from ``*.dist-info/METADATA``
# at runtime.  PyInstaller's static analyser bundles module *code* but
# does not always include the sidecar ``.dist-info`` directory for
# transitive (non-top-level) packages.  Without the metadata the
# following calls fail with ``PackageNotFoundError``:
#
#   agno.tools.function         → version("pydantic")
#   pydantic.networks           → version("email-validator")
#
# ``copy_metadata`` explicitly adds the dist-info tree to the bundle.
datas += copy_metadata("pydantic")
datas += copy_metadata("pydantic_core")
datas += copy_metadata("email_validator")
for distribution in distributions():
    name = distribution.metadata.get("Name", "")
    if name.lower().replace("_", "-").startswith("openagent-"):
        datas += copy_metadata(name)

# ── Analysis ──

a = Analysis(
    [str(files("openagent_server") / "cli.py")],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude heavy packages not needed at runtime
        "matplotlib",
        "scipy",
        "pandas",
        "tkinter",
        "test",
        "unittest",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# Analysis reclassifies native helpers from DATA to BINARY. Its subsequent
# Mach-O processing would thin/re-sign our already verified module/sidecar
# assets, invalidating their manifests. DATA retains an executable source's
# executable bit in the one-file archive while preserving its exact bytes.
_preserved_assets = []
_processed_binaries = []
for destination, source, kind in a.binaries:
    if destination == _node_name or destination.startswith((
        "openagent_modules/resources/", "openagent_device_tools/sidecars/",
    )):
        _preserved_assets.append((destination, source, "DATA"))
    else:
        _processed_binaries.append((destination, source, kind))
a.binaries = _processed_binaries
a.datas += _preserved_assets

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# onefile mode: every binary/data file gets packed INTO the executable
# (not emitted alongside it), so the user downloads ONE self-contained
# file. Dropping COLLECT removes the "dist/openagent/ + _internal/" folder
# structure. PyInstaller writes directly to ``dist/openagent``.
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="openagent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# ── macOS: wrap the onefile EXE in a proper ``.app`` bundle ──────────
#
# TCC (Accessibility, Screen Recording, etc.) keys its persistent grants
# to the responsible process's identity. For bare CLI binaries TCC falls
# back to a path-based entry keyed by cdhash, which invalidates on every
# release. Wrapping openagent in an .app bundle with a stable
# ``CFBundleIdentifier`` promotes it to a bundle-based entry so grants
# persist across updates. See buildResources/openagent-Info.plist for
# the full explanation.
#
# The bundle layout is:
#   dist/openagent.app/
#   ├── Contents/
#   │   ├── Info.plist       — copy of buildResources/openagent-Info.plist
#   │   └── MacOS/
#   │       └── openagent    — the PyInstaller onefile
#
# The sign-notarize-macos.sh script copies the signed Rust sidecar
# into the same ``Contents/MacOS/`` alongside ``openagent`` after this
# spec runs, so the final pkg payload has both binaries in one bundle.
if sys.platform == "darwin":
    app = BUNDLE(
        exe,
        name="openagent.app",
        icon=None,
        bundle_identifier="com.openagent.server",
        info_plist="buildResources/openagent-Info.plist",
    )
