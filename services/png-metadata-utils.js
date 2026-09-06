'use strict';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_CHUNK_TYPE = 'IHDR';

function parsePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) {
    return { width: 0, height: 0 };
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { width: 0, height: 0 };
  }
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== IHDR_CHUNK_TYPE) {
    return { width: 0, height: 0 };
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}

module.exports = {
  parsePngDimensions,
};
