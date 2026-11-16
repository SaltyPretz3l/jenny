'use strict';

// Row 151 slice T6: real minimal pictures for the team board picture tests (the store and the routes). Each is the
// smallest file services/boards/board-image-info.js reads a type and dimensions from.

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(width = 1, height = 1, tail = Buffer.alloc(0)) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const rows = Buffer.alloc((Math.min(width, 64) + 1) * Math.min(height, 4));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)), tail]);
}
function jpeg(width = 3, height = 2) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, 0xff, 0xff, ...sof, 0xff, 0xd9]);
}
function gif(width = 1, height = 1) {
  const out = Buffer.from('474946383961000000008000000000ffffff2c000000000100010000020244010003b', 'hex');
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  return out;
}
function webp(width = 5, height = 4) {
  const body = Buffer.alloc(13);
  body[0] = 0x2f;
  body.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  const riff = Buffer.alloc(20);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(12 + body.length, 4);
  riff.write('WEBP', 8, 'latin1');
  riff.write('VP8L', 12, 'latin1');
  riff.writeUInt32LE(body.length, 16);
  return Buffer.concat([riff, body]);
}

module.exports = { gif, jpeg, png, sha, webp };
