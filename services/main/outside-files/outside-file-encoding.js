'use strict';

// Text encodings for files opened from outside the Workspace (row 137, owner
// pick 2026-11-12). Workspace files stay strict UTF-8; an outside file may be
// whatever Notepad or PowerShell wrote:
//   - UTF-8 and UTF-8 with a BOM: editable, exactly as Workspace files.
//   - UTF-16 LE/BE with a BOM (PowerShell 5.1 `>`): editable, saved back in the
//     same encoding and BOM, byte for byte.
//   - Anything else without NUL bytes (ANSI and similar): shown read-only,
//     decoded as Windows-1252. Never saved, so nothing is re-encoded lossily.
//   - NUL bytes without a UTF-16 BOM, or a UTF-32 BOM: not text; refused.

const { TextDecoder } = require('node:util');

const { WORKSPACE_FS_ERROR_CODES } = require('../../backend/error-codes');
const { workspaceFsError } = require('../../workspace-ide-errors');
const { hasUnpairedSurrogate } = require('../../versioned-workspace-file-bytes');
const { decodeWorkspaceText } = require('../../versioned-workspace-file-encoding');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const UTF32_BOMS = [Buffer.from([0xff, 0xfe, 0x00, 0x00]), Buffer.from([0x00, 0x00, 0xfe, 0xff])];
const BINARY_SNIFF_BYTES = 8192;
const READ_ONLY_ENCODING = 'windows-1252';

function hasPrefix(bytes, prefix) {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

function eolOf(content) {
  return content.includes('\r\n') ? 'crlf' : 'lf';
}

function notText(details) {
  return workspaceFsError(WORKSPACE_FS_ERROR_CODES.BINARY, 'File is not text.', details);
}

function swapBytePairs(bytes) {
  const out = Buffer.from(bytes);
  out.swap16();
  return out;
}

function decodeUtf16(bytes, encoding, details) {
  const body = bytes.subarray(2);
  if (body.length % 2 !== 0) throw notText(details);
  try {
    const content = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body);
    return { content, encoding, editable: true, eol: eolOf(content) };
  } catch (_error) {
    throw notText(details);
  }
}

function decodeOutsideText(bytes, details = {}) {
  if (UTF32_BOMS.some((bom) => hasPrefix(bytes, bom))) throw notText(details);
  if (hasPrefix(bytes, UTF16LE_BOM)) return decodeUtf16(bytes, 'utf-16le', details);
  if (hasPrefix(bytes, UTF16BE_BOM)) return decodeUtf16(bytes, 'utf-16be', details);
  try {
    const decoded = decodeWorkspaceText(bytes, { intent: 'edit', details });
    return { content: decoded.content, encoding: decoded.encoding, editable: true, eol: decoded.eol };
  } catch (_error) {
    // Not UTF-8: fall through to the read-only legacy view.
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw notText(details);
  const content = new TextDecoder(READ_ONLY_ENCODING).decode(bytes);
  return { content, encoding: READ_ONLY_ENCODING, editable: false, eol: eolOf(content) };
}

function encodeOutsideText(content, encoding, details = {}) {
  const text = String(content);
  if (text.startsWith('﻿') || hasUnpairedSurrogate(text)) {
    throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING, 'Content is not well-formed text.', details);
  }
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf8');
    case 'utf-8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]);
    case 'utf-16le':
      return Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')]);
    case 'utf-16be':
      return Buffer.concat([UTF16BE_BOM, swapBytePairs(Buffer.from(text, 'utf16le'))]);
    default:
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING,
        'Jenny edits UTF-8 and UTF-16 files; this file opened read-only.',
        { ...details, reason: 'read_only_encoding' },
      );
  }
}

module.exports = {
  READ_ONLY_ENCODING,
  decodeOutsideText,
  encodeOutsideText,
};
