"""Standalone packaging must preserve the upstream native application bundle."""
import importlib.util
from pathlib import Path
import pytest

def test_stage_preserves_full_qualified_app_and_never_compiles(monkeypatch,tmp_path):
    script=Path(__file__).resolve().parents[1]/"scripts/build_standalone.py"
    monkeypatch.syspath_prepend(str(script.parent))
    spec=importlib.util.spec_from_file_location('build_fixture',script);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    import openagent_device_tools.media as media
    app=tmp_path/'source/helper.app';binary=app/'Contents/MacOS/openagent-computer-control';binary.parent.mkdir(parents=True);binary.write_bytes(b'qualified-helper')
    (app/'Contents/Info.plist').write_bytes(b'qualified-identity');signature=app/'Contents/_CodeSignature/CodeResources';signature.parent.mkdir();signature.write_bytes(b'qualified-signature')
    monkeypatch.setattr(media,'native_desktop_command',lambda:(str(binary),))
    monkeypatch.setattr(module,'sidecar_source',lambda name:tmp_path/'absent-browser')
    output=tmp_path/'bundle';output.mkdir();module.stage_sidecars(output,'darwin-arm64',required=False)
    copied=output/'helper.app';assert (copied/'Contents/Info.plist').read_bytes()==b'qualified-identity';assert (copied/'Contents/_CodeSignature/CodeResources').read_bytes()==b'qualified-signature'
    assert not hasattr(module,'_build_computer_control')
    monkeypatch.setattr(media,'native_desktop_command',lambda:None)
    with pytest.raises(SystemExit,match='qualified upstream'):module.stage_sidecars(output,'darwin-arm64',required=True)
