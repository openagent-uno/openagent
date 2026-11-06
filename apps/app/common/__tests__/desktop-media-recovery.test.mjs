import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverDesktopMedia } from '../desktop-media-recovery.ts';
const initial = () => ({fps:20,generation:0,restarts:[]});
const slow = 'Video decoder is too slow';
test('local playback overload lowers frame rate within a bounded recovery window', () => {
  const one=recoverDesktopMedia(initial(),100,slow);
  const two=recoverDesktopMedia(one,200,slow);
  const three=recoverDesktopMedia(two,300,'The desktop connection is too slow. Reopen the view.');
  assert.deepEqual([one.fps,two.fps,three.fps],[10,5,5]);
  assert.equal(three.generation,3);
  assert.equal(recoverDesktopMedia(three,400,slow),null);
  assert.equal(recoverDesktopMedia(three,30_301,slow).fps,5);
});
test('authorization, malformed stream, decoder support and connection errors do not auto-retry', () => {
  for(const message of ['Desktop access revoked','Video stream interrupted','Video decoder unavailable','Desktop connection unavailable.'])
    assert.equal(recoverDesktopMedia(initial(),100,message),null);
  assert.equal(recoverDesktopMedia(initial(),NaN,slow),null);
});
