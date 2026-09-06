'use strict';

/* Image-read limits and MIME mapping for WorkspaceIdeService. Split out of
 * workspace-ide-service.js, which sits at the 1015-line ceiling -- the rule
 * there is to extract a cohesive block into a sibling rather than cram
 * statements onto one line to squeeze under it. */

const IMAGE_READ_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
});

function imageMimeTypeForExtension(extension) {
  return IMAGE_MIME_BY_EXTENSION[extension] || 'application/octet-stream';
}

module.exports = {
  IMAGE_READ_MAX_BYTES,
  IMAGE_MIME_BY_EXTENSION,
  imageMimeTypeForExtension,
};
