'use strict';

const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, checksum]);
}

function ihdr(width, height, colorType = 0) {
  const value = Buffer.alloc(13);
  value.writeUInt32BE(width, 0);
  value.writeUInt32BE(height, 4);
  value.writeUInt8(8, 8);
  value.writeUInt8(colorType, 9);
  return value;
}

function makePng(width, height, { ancillaryBytes = 0 } = {}) {
  const chunks = [PNG_SIGNATURE, pngChunk('IHDR', ihdr(width, height))];
  if (ancillaryBytes > 0) chunks.push(pngChunk('tEXt', Buffer.alloc(ancillaryBytes, 0x61)));
  chunks.push(
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(height * (1 + width)))),
    pngChunk('IEND', Buffer.alloc(0)),
  );
  return Buffer.concat(chunks);
}

function makeHeaderOnlyPng(width, height) {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr(width, height, 6)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { PNG_SIGNATURE, makeHeaderOnlyPng, makePng, pngChunk };
