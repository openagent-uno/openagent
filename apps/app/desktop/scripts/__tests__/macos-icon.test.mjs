import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { verifyMacIconPng } from '../verify-macos-icon.mjs';

const desktop = path.resolve(import.meta.dirname, '../..');

test('committed macOS master keeps transparent padding and rounded corners', () => {
  const result = verifyMacIconPng(path.join(desktop, 'buildResources', 'icon.png'));
  assert.deepEqual(result.margins, [92, 92, 93, 93]);
});

test('rejects an opaque full-bleed RGBA master', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-icon-'));
  try {
    const file = path.join(root, 'opaque.png');
    writeRgbaPng(file, 64, 64, () => [5, 8, 16, 255]);
    assert.throws(
      () => verifyMacIconPng(file),
      /transparent padding/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeRgbaPng(file, width, height, pixel) {
  const rows = Buffer.alloc(height * ((width * 4) + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * ((width * 4) + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y);
      for (let channel = 0; channel < 4; channel += 1) {
        rows[row + 1 + (x * 4) + channel] = rgba[channel];
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
