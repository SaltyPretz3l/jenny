'use strict';

/* services/shared/external-open-policy.js - the one allowlist of file types
 * Jenny may hand to the OS default-app opener (Electron shell.openPath).
 *
 * shell.openPath runs whatever the OS associates with the extension, so a
 * model-written or cloned `tool.exe`, `x.scr` or `script.py` would execute on
 * a click with no Mark-of-the-Web prompt. Only passive document/media types
 * pass; everything else, extensionless names, and NTFS stream names refuse.
 * HTML and SVG are script-capable and open only through Jenny's own
 * sandboxed preview/artifact frame, never the OS. Archives (zip) stay out: one
 * double-click from running their contents. Both main-process openers
 * (workspace-ide-service, artifact-workspace-service) enforce this server-side;
 * renderer checks are not the boundary. */

const { ARTIFACT_ERROR_CODES } = require('../backend/error-codes');

const EXTERNAL_OPEN_ALLOWED_EXTENSIONS = Object.freeze([
  '.md', '.markdown', '.txt', '.log',
  '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.xml',
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.mp3', '.mp4', '.wav', '.webm',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
]);
const ALLOWED = new Set(EXTERNAL_OPEN_ALLOWED_EXTENSIONS);

// One typed refusal for both openers: the artifact service's existing
// DANGEROUS_EXTENSION code (CMP-ARTIFACT-0013).
const EXTERNAL_OPEN_REFUSED_CODE = ARTIFACT_ERROR_CODES.DANGEROUS_EXTENSION;

// Lower-cased extension of the path's leaf ('' when there is none). Splits on
// both separators so a Windows absolute path and a POSIX relative path agree.
// A leaf with ':' is an NTFS alternate-data-stream name, never openable.
function externalOpenExtension(targetPath) {
  const leaf = String(targetPath || '').split(/[\\/]/).pop() || '';
  if (leaf.includes(':') || leaf.includes('\0')) return '';
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot).toLowerCase() : '';
}

function isExternalOpenAllowed(targetPath) {
  return ALLOWED.has(externalOpenExtension(targetPath));
}

module.exports = {
  EXTERNAL_OPEN_ALLOWED_EXTENSIONS,
  EXTERNAL_OPEN_REFUSED_CODE,
  externalOpenExtension,
  isExternalOpenAllowed,
};
