# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

ROOT = Path(SPEC).resolve().parent

a = Analysis(
    [str(ROOT / "scripts" / "host_tools_entry.py")],
    pathex=[str(ROOT / "src")],
    binaries=[],
    datas=[
        (
            str(ROOT / "src" / "openagent_host_tools" / "builtins-lock.json"),
            "openagent_host_tools",
        ),
        (
            str(ROOT / "src" / "openagent_host_tools" / "sidecar-manifests.json"),
            "openagent_host_tools",
        ),
    ] + collect_data_files("openagent_device_tools"),
    hiddenimports=sum((collect_submodules(name) for name in ("openagent_host_tools", "openagent_capability_host", "openagent_tool_protocol", "openagent_filesystem", "openagent_editor", "openagent_shell", "openagent_device_tools")), []),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="openagent-host-tools",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
