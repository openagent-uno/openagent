#!/usr/bin/env node

/** Fail closed when the macOS icon master loses its transparent squircle. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function inspectMacIconPng(file) {
  const bytes = fs.readFileSync(file);
  assert(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is not a PNG`);

  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert(dataEnd + 4 <= bytes.length, `${file} contains a truncated ${type} chunk`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      assert.equal(length, 13, `${file} has an invalid IHDR`);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, `${file} must use 8-bit channels`);
      assert.equal(data[9], 6, `${file} must be RGBA, not an opaque RGB master`);
      assert.equal(data[10], 0, `${file} has unsupported PNG compression`);
      assert.equal(data[11], 0, `${file} has unsupported PNG filtering`);
      assert.equal(data[12], 0, `${file} must be non-interlaced`);
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  assert(width > 0 && height > 0 && compressed.length > 0, `${file} has no decodable image`);
  assert.equal(width, height, `${file} must be square`);
  const stride = width * 4;
  const inflated = zlib.inflateSync(Buffer.concat(compressed));
  assert.equal(inflated.length, height * (stride + 1), `${file} has an unexpected pixel payload`);

  const rows = Buffer.allocUnsafe(height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    assert(filter >= 0 && filter <= 4, `${file} uses unsupported PNG filter ${filter}`);
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= 4 ? rows[rowOffset + x - 4] : 0;
      const up = y > 0 ? rows[rowOffset - stride + x] : 0;
      const upLeft = y > 0 && x >= 4 ? rows[rowOffset - stride + x - 4] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else value = raw + paeth(left, up, upLeft);
      rows[rowOffset + x] = value & 0xff;
    }
    sourceOffset += stride;
  }

  const alphaAt = (x, y) => rows[(y * stride) + (x * 4) + 3];
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alphaAt(x, y) === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  assert(maxX >= minX && maxY >= minY, `${file} is fully transparent`);
  return { width, height, minX, minY, maxX, maxY, alphaAt };
}

export function verifyMacIconPng(file, label = file) {
  const icon = inspectMacIconPng(file);
  const minimumMargin = Math.ceil(icon.width * 0.05);
  const maximumMargin = Math.floor(icon.width * 0.2);
  const margins = [
    icon.minX,
    icon.minY,
    icon.width - 1 - icon.maxX,
    icon.height - 1 - icon.maxY,
  ];
  for (const margin of margins) {
    assert(
      margin >= minimumMargin && margin <= maximumMargin,
      `${label} must keep 5-20% transparent padding on every side (got ${margins.join(', ')})`,
    );
  }

  const centerX = Math.floor((icon.minX + icon.maxX) / 2);
  const centerY = Math.floor((icon.minY + icon.maxY) / 2);
  assert(icon.alphaAt(centerX, centerY) >= 250, `${label} has no opaque center`);
  assert(icon.alphaAt(centerX, icon.minY) > 0, `${label} has no visible top edge`);
  assert(icon.alphaAt(centerX, icon.maxY) > 0, `${label} has no visible bottom edge`);
  assert(icon.alphaAt(icon.minX, centerY) > 0, `${label} has no visible left edge`);
  assert(icon.alphaAt(icon.maxX, centerY) > 0, `${label} has no visible right edge`);
  for (const [x, y] of [
    [icon.minX, icon.minY],
    [icon.maxX, icon.minY],
    [icon.minX, icon.maxY],
    [icon.maxX, icon.maxY],
  ]) {
    assert.equal(icon.alphaAt(x, y), 0, `${label} must have rounded transparent corners`);
  }
  return { ...icon, margins };
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  return upDistance <= diagonalDistance ? up : upLeft;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..', 'buildResources', 'icon.png'));
  const result = verifyMacIconPng(file);
  process.stdout.write(
    `macOS icon geometry ok: ${result.width}x${result.height}, margins ${result.margins.join('/')}\n`,
  );
}
