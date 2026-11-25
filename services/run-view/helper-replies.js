'use strict';

/*
 * helper-replies.js - checks for what the computer helper answers (row 197). Its replies are untrusted: each
 * check returns a clean value or null (or a fallback), never the reply itself. Pure; no Electron, no IO.
 */

const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIGNATURE_RE = /^[0-9a-f]{16}$/;
const MAX_JOB_PIDS = 256;

// What the helper's replies are checked against (they are untrusted).
const pidOk = (value) => Number.isSafeInteger(value) && value > 0;
const countOk = (value) => Number.isSafeInteger(value) && value >= 0;

// The helper's window.geometry reply is untrusted. The crop is the client area's offset inside the drawn
// bounds, as fractions of those bounds; null for anything that does not add up (then the panel shows the whole picture).
function cropOf(reply) {
  const width = reply?.bounds?.width;
  const height = reply?.bounds?.height;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) return null;
  const { left, top, right, bottom } = reply?.offset ?? {};
  if (![left, top, right, bottom].every(countOk)) return null;
  if (left + right >= width || top + bottom >= height) return null;
  if (Math.max(left, right) * 2 >= width || Math.max(top, bottom) * 2 >= height) return null; // each edge stays under half
  return { left: left / width, top: top / height, right: right / width, bottom: bottom / height };
}

// The process ids a run.list row names, bounded; the program's own id when the row names none.
function pidsOf(row, spawned) {
  const listed = Array.isArray(row?.pids) ? [...new Set(row.pids.filter(pidOk))].slice(0, MAX_JOB_PIDS) : [];
  return listed.length > 0 ? listed : spawned;
}

// The helper's capture reply is untrusted: a bounded PNG, a sane size and a 16-digit frame signature.
function validCapture(reply) {
  const b64 = reply?.png_base64;
  if (typeof b64 !== 'string' || Buffer.byteLength(b64, 'base64') > MAX_PICTURE_BYTES) return null;
  const head = Buffer.from(b64.slice(0, 16), 'base64');
  const { width, height, signature } = reply;
  if (head.length < PNG_SIGNATURE.length || !head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) return null;
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return null;
  return { pngBase64: b64, width, height, signature };
}

module.exports = { cropOf, pidOk, pidsOf, validCapture };
