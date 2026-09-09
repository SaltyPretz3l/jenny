'use strict';

const { parsePngDimensions } = require('./png-metadata-utils');
const MAX_PREVIEW_IMAGE_BYTES = 2 * 1024 * 1024;

// Only called with the NativeImage returned by our hidden browser capture.
function encodePreviewImage(nativeImage, originalBuffer = null) {
  if (typeof nativeImage?.toPNG !== 'function') return null;
  let image = nativeImage;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const buffer = attempt === 0 && Buffer.isBuffer(originalBuffer) ? originalBuffer : image.toPNG();
    const { width, height } = parsePngDimensions(buffer);
    if (!width || !height || width * height > 40_000_000) return null;
    if (buffer.length <= MAX_PREVIEW_IMAGE_BYTES) {
      return { buffer, width, height, mime_type: 'image/png' };
    }
    if (width <= 1 || typeof image.resize !== 'function') return null;
    image = image.resize({ width: Math.max(1, Math.floor(width / 2)) });
  }
  return null;
}

module.exports = { encodePreviewImage, MAX_PREVIEW_IMAGE_BYTES };
