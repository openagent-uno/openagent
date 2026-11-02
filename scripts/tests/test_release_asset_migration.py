import copy
import hashlib
import importlib.util
from pathlib import Path

import pytest
from unittest.mock import patch
from types import SimpleNamespace
import json

spec = importlib.util.spec_from_file_location('release_migration', Path(__file__).parents[1] / 'migrate-release-assets.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Peer:
    def __init__(self, *, draft=False, corrupt=False, bad_upload=False):
        self.data = b'unchanged signed artifact'
        self.source = {'id': 1, 'tag_name': 'v1.2.3', 'name': 'Example', 'body': '',
                       'draft': draft, 'prerelease': False, 'assets': [{
                           'name': 'example.zip', 'size': len(self.data),
                           'digest': 'sha256:' + hashlib.sha256(self.data).hexdigest()}]}
        self.destination = None
        self.corrupt, self.bad_upload = corrupt, bad_upload
        self.uploads = self.finishes = 0

    def destination_release(self, tag):
        return copy.deepcopy(self.destination)

    def create(self, tag, commit, source):
        self.destination = {**copy.deepcopy(source), 'id': 2, 'tag_name': tag, 'draft': True, 'assets': []}
        return self.destination_release(tag)

    def download(self, asset, path):
        path.write_bytes(b'corrupt' if self.corrupt else self.data)

    def upload(self, release, path):
        assert self.destination['draft'], 'Incomplete release must not be public'
        self.uploads += 1
        asset = copy.deepcopy(self.source['assets'][0])
        if self.bad_upload:
            asset['digest'] = 'sha256:' + '0' * 64
        self.destination['assets'].append(asset)

    def finish(self, release, source):
        self.finishes += 1
        self.destination['draft'] = source['draft']
        return self.destination_release(release['tag_name'])


@pytest.mark.parametrize('draft', [False, True])
def test_copy_preserves_visibility_bytes_and_resumes_without_overwrite(tmp_path, draft):
    peer = Peer(draft=draft)
    receipt = module.copy_release(peer, peer.source, 'app-v1.2.3', 'a' * 40, tmp_path)
    assert receipt['verified'] and receipt['draft'] is draft
    assert peer.uploads == 1
    assert not list(tmp_path.iterdir())
    module.copy_release(peer, peer.source, 'app-v1.2.3', 'a' * 40, tmp_path)
    assert peer.uploads == 1


@pytest.mark.parametrize('failure', ['source', 'upload'])
def test_failed_digest_never_publishes_partial_release(tmp_path, failure):
    peer = Peer(corrupt=failure == 'source', bad_upload=failure == 'upload')
    with pytest.raises(ValueError, match='differs'):
        module.copy_release(peer, peer.source, 'app-v1.2.3', 'a' * 40, tmp_path)
    assert peer.destination['draft']
    assert peer.finishes == 0


def test_conflicting_destination_and_public_draft_are_rejected(tmp_path):
    peer = Peer(draft=True)
    peer.destination = {**copy.deepcopy(peer.source), 'id': 2, 'draft': False}
    with pytest.raises(ValueError, match='private source draft'):
        module.copy_release(peer, peer.source, 'app-v1.2.3', 'a' * 40, tmp_path)
    peer.destination['draft'] = True
    peer.destination['assets'][0]['digest'] = 'sha256:' + '0' * 64
    with pytest.raises(ValueError, match='conflicting'):
        module.copy_release(peer, peer.source, 'app-v1.2.3', 'a' * 40, tmp_path)
    assert peer.uploads == 0


@pytest.mark.parametrize('endpoint,binary_header', [('releases/assets/1', True), ('actions/artifacts/1/zip', False)])
def test_download_uses_endpoint_specific_accept_header(tmp_path, endpoint, binary_header):
    data = b'unchanged archive bytes'
    asset = {'url': 'https://api.github.com/repos/example/source/' + endpoint,
             'size': len(data), 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}
    def run(args, **kwargs):
        assert ('Accept: application/octet-stream' in args) is binary_header
        kwargs['stdout'].write(data)
    with patch.object(module.subprocess, 'run', side_effect=run):
        module.GitHub('example/source', 'example/dest').download(asset, tmp_path / 'archive.zip')
    assert (tmp_path / 'archive.zip').read_bytes() == data


def test_private_draft_resumes_without_creating_a_public_git_ref():
    release = {'id': 12, 'tag_name': 'untagged-private', 'draft': True,
               'body': 'Private archive' + module.distribution_marker('private-reviewed-tag')}
    client = module.GitHub('example/source', 'example/destination')
    with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps([[release]]))), \
         patch.object(client, 'api', return_value=release) as api:
        assert client.destination_release('private-reviewed-tag') == release
        client.finish(release, {'draft': True, 'prerelease': False})
        assert api.call_args.args[2]['tag_name'] == 'private-reviewed-tag'
        assert api.call_args.args[2]['draft'] is True
