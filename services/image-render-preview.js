'use strict';

// Live preview frames of a running render. sd-cli writes one small PNG per
// preview step to `<scratch>/<opId>-preview-NNN.png` (its `%03d` numbering);
// the chat row shows the newest complete frame while the image develops.

const path = require('path');
const { readBoundedRegularFile } = require('./backend/bounded-file-reader');
const { readPngStructure } = require('./backend/png-validator');

// A latent projection frame is about 1/16 of the image per side (~20 KB).
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_FRAMES = 200;
const MAX_PREVIEW_EDGE = 512;
const PREVIEW_FRAME_TARGET = 10;

function previewFrameName(opId, index) {
  return `${opId}-preview-${String(index).padStart(3, '0')}.png`;
}

// The `%03d` path handed to sd-cli. A `%` anywhere else would be read as a
// printf directive by the engine, so such a scratch path gets no previews.
function previewPathPattern(scratchDir, opId) {
  const pattern = path.join(scratchDir, `${opId}-preview-%03d.png`);
  return pattern.split('%').length === 2 ? pattern : '';
}

// About ten frames per render whatever the step count.
function previewInterval(steps) {
  return Math.max(1, Math.round((Number(steps) || 1) / PREVIEW_FRAME_TARGET));
}

/**
 * Reads the newest complete preview frame not yet sent. sd-cli writes frames
 * in place, so the newest file may still be partial: a frame that does not
 * parse as a whole PNG is skipped and the one before it is used instead.
 */
function createPreviewReader({ scratchDir, opId, fsImpl = require('fs') }) {
  let sent = -1;
  let probe = 0;
  function frameAt(index) {
    return path.join(scratchDir, previewFrameName(opId, index));
  }
  function readFrame(index) {
    const read = readBoundedRegularFile({ fsImpl, filePath: frameAt(index), maxBytes: MAX_PREVIEW_BYTES });
    if (!read.ok) return null;
    const png = readPngStructure(read.buffer);
    if (!png.ok || png.width > MAX_PREVIEW_EDGE || png.height > MAX_PREVIEW_EDGE) return null;
    return `data:image/png;base64,${read.buffer.toString('base64')}`;
  }
  function next() {
    while (probe < MAX_PREVIEW_FRAMES && fsImpl.existsSync(frameAt(probe))) probe += 1;
    for (let index = probe - 1; index > sent && index >= probe - 2; index -= 1) {
      const dataUrl = readFrame(index);
      if (dataUrl) {
        sent = index;
        return dataUrl;
      }
    }
    return '';
  }
  return { next };
}

// The frames a render wrote, for scratch cleanup: regular files only, in order.
function listPreviewFrames(scratchDir, opId, fsImpl = require('fs')) {
  const frames = [];
  for (let index = 0; index < MAX_PREVIEW_FRAMES; index += 1) {
    const frame = path.join(scratchDir, previewFrameName(opId, index));
    try { if (!fsImpl.lstatSync(frame).isFile()) break; } catch (_error) { break; }
    frames.push(frame);
  }
  return frames;
}

module.exports = {
  MAX_PREVIEW_BYTES, createPreviewReader, listPreviewFrames, previewFrameName, previewInterval, previewPathPattern,
};
