import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function verifyRendererAssets(renderer) {
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const origin = new URL('http://127.0.0.1/');
  const nested = new URL('/projects/sample-task', origin);
  const assets = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/gi)].map(match => match[1]);
  assert(assets.length > 0, `${renderer} has no renderer assets`);
  for (const asset of assets) {
    const absolute = new URL(asset, origin);
    if (absolute.origin !== origin.origin) continue;
    assert.equal(new URL(asset, nested).href, absolute.href, `Asset ${asset} fails on nested routes`);
    assert(fs.statSync(path.join(renderer, decodeURIComponent(absolute.pathname))).isFile(), `Missing renderer asset ${asset}`);
  }
}
