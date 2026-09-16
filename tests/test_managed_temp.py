"""Startup cleanup cannot acquire ownership of a shared temp directory."""
import os
from pathlib import Path
from unittest.mock import patch

from openagent_server import cli


def test_no_implicit_os_temp_cleanup(tmp_path):
    other = tmp_path / 'oa_other-agent'
    other.mkdir()
    with patch.dict(os.environ, {}, clear=True), patch.object(cli.tempfile, 'gettempdir', return_value=str(tmp_path)):
        cli._cleanup_stale_openagent_temp_artifacts(max_age_s=-1)
    assert other.is_dir()


def test_explicit_root_requires_correct_owner_and_rejects_symlinks(tmp_path):
    agent = tmp_path / 'agent'
    owned = agent / 'tmp'
    owned.mkdir(parents=True)
    stale = owned / 'oa_stale'
    stale.mkdir()
    external = tmp_path / 'oa_other-agent'
    external.mkdir()
    symlink = owned / 'oa_external'
    symlink.symlink_to(external, target_is_directory=True)
    marker = owned / '.openagent-temp-owner'
    with patch.dict(os.environ, {'OPENAGENT_MANAGED_TEMP_DIR':str(owned)}), patch.object(cli.paths, 'get_agent_dir', return_value=agent):
        cli._cleanup_stale_openagent_temp_artifacts(max_age_s=-1)
        assert stale.is_dir()
        marker.write_text(str(tmp_path / 'different-agent'))
        cli._cleanup_stale_openagent_temp_artifacts(max_age_s=-1)
        assert stale.is_dir()
        marker.write_text(str(agent))
        cli._cleanup_stale_openagent_temp_artifacts(max_age_s=-1)
        assert not stale.exists()
        assert external.is_dir() and symlink.is_symlink()
        marker.unlink()
        marker.symlink_to(tmp_path / 'owner-marker')
        (tmp_path / 'owner-marker').write_text(str(agent))
        assert cli._managed_temp_root() is None
