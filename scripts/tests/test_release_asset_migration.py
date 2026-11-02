import copy
import hashlib
import importlib.util
from pathlib import Path

import pytest

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
