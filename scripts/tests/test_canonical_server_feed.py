import io
import json
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / 'apps/server/src'))
from openagent_server import updater


def release(tag, name=None, **extra):
    version = tag.removeprefix('server-').removeprefix('v')
    return {'tag_name': tag, 'assets': [{'name': name or f'openagent-{version}-linux-x64.tar.gz',
            'browser_download_url': 'https://example.test/owned.tar.gz'}], **extra}


def test_mixed_canonical_feed_selects_only_matching_server_artifact():
    data = [release('v9.0.0', 'openagent_cli-9.0.0.whl'),
            release('app-v8.0.0', 'openagent-app-8.0.0-linux-x64.tar.gz'),
            release('host-tools-v7.0.0', 'openagent-host-tools-linux-x64.tar.gz'),
            release('server-v1.2.4'), release('v1.2.3')]
    with patch.object(updater, '_asset_suffix', return_value='linux-x64.tar.gz'):
        selected = updater._select_channel_release(data, current='1.2.2', channel='stable')
    assert selected['tag_name'] == 'server-v1.2.4'
    assert updater._release_version(selected['tag_name']) == '1.2.4'


def test_drafts_prereleases_and_wrong_platform_do_not_hide_usable_release():
    data = [release('server-v2.0.0', draft=True), release('server-v1.3.0-beta.2', prerelease=True),
            release('server-v1.2.5', 'openagent-1.2.5-win-x64.zip'), release('v1.2.4')]
    with patch.object(updater, '_asset_suffix', return_value='linux-x64.tar.gz'):
        assert updater._select_channel_release(data, current='1.2.2', channel='stable')['tag_name'] == 'v1.2.4'


class Response(io.BytesIO):
    def __init__(self, data, link=''):
        super().__init__(json.dumps(data).encode())
        self.link = link
    def getheader(self, name, default=''):
        return self.link if name == 'Link' else default


def test_pagination_stays_bound_to_canonical_repository():
    next_page = updater.GITHUB_RELEASES_API + '&page=2'
    with patch.object(updater, 'urlopen', side_effect=[Response([{'id': 1}], f'<{next_page}>; rel="next"'), Response([{'id': 2}])]) as fetch:
        assert updater._release_pages() == [{'id': 1}, {'id': 2}]
        assert fetch.call_args_list[1].args[0].full_url == next_page
    with patch.object(updater, 'urlopen', return_value=Response([], '<https://other.test/release>; rel="next"')):
        with pytest.raises(ValueError, match='authority'):
            updater._release_pages()
