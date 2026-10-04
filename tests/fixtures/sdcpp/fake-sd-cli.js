'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { crc32, PNG_SIGNATURE } = require('../../../services/backend/png-validator');

const args = process.argv.slice(2);
function value(flag, fallback) {
  const index = args.lastIndexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

function chunk(type, data) {
  const buffer = Buffer.alloc(12 + data.length);
  buffer.writeUInt32BE(data.length);
  buffer.write(type, 4, 4, 'ascii');
  data.copy(buffer, 8);
  buffer.writeUInt32BE(crc32(buffer.subarray(4, 8 + data.length)), 8 + data.length);
  return buffer;
}

function writePng() {
  const width = Number(value('--width', '2'));
  const height = Number(value('--height', '3'));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const png = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(height * (1 + width)))), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(value('-o'), png);
}

if (value('--echo')) fs.writeFileSync(value('--echo'), JSON.stringify(args));
process.stdout.write('[INFO ] loading model from <path>\n');
process.stdout.write('[INFO ] generating image\n');
process.stderr.write('  |==================>     | 8/20 - 2.35s/it\r');
process.stderr.write('  |==================>     | 9/20 - 1.4it/s\n');
process.stdout.write('[INFO ] sampling completed, taking 0.25s\n');
const mode = value('--mode', 'ok');
if (mode === 'invalid') fs.writeFileSync(value('-o'), 'not png');
else if (mode === 'oversize') fs.writeFileSync(value('-o'), Buffer.alloc(10 * 1024 * 1024 + 1));
else if (mode !== 'missing') writePng();
if (mode === 'hang') setInterval(() => {}, 1000);
else process.exitCode = Number(value('--exit-code', '0'));
