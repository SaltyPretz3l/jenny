'use strict';

const { TextDecoder } = require('node:util');

const { WORKSPACE_FS_ERROR_CODES } = require('./backend/error-codes');
const { workspaceFsError } = require('./workspace-ide-errors');

const PREVIEW_SAMPLE_BYTES = 64 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UNSUPPORTED_BOMS = Object.freeze([
  { bytes: Buffer.from([0xff, 0xfe, 0x00, 0x00]), encoding: 'utf-32-le' },
  { bytes: Buffer.from([0x00, 0x00, 0xfe, 0xff]), encoding: 'utf-32-be' },
  { bytes: Buffer.from([0xff, 0xfe]), encoding: 'utf-16-le' },
  { bytes: Buffer.from([0xfe, 0xff]), encoding: 'utf-16-be' },
]);

function hasPrefix(buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function encodingError(details) {
  return workspaceFsError(
    WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING,
    'File is not valid editable UTF-8 text.',
    details
  );
}

function strictUtf8(bytes, details) {
  if (UNSUPPORTED_BOMS.some((entry) => hasPrefix(bytes, entry.bytes))) throw encodingError(details);
  const hasBom = hasPrefix(bytes, UTF8_BOM);
  const body = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes;
  if ((hasBom && hasPrefix(body, UTF8_BOM)) || body.includes(0)) throw encodingError(details);
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch (_error) {
    throw encodingError(details);
  }
  return {
    content,
    editable: true,
    encoding: hasBom ? 'utf-8-bom' : 'utf-8',
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
    truncated: false,
  };
}

function hexPreview(bytes) {
  const sample = bytes.subarray(0, PREVIEW_SAMPLE_BYTES);
  const lines = [];
  for (let offset = 0; offset < sample.length; offset += 16) {
    const row = sample.subarray(offset, offset + 16);
    const hex = [...row].map((value) => value.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row].map((value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  return lines.join('\n');
}

function previewEncoding(bytes) {
  return UNSUPPORTED_BOMS.find((entry) => hasPrefix(bytes, entry.bytes))?.encoding || 'non-utf-8';
}

function decodeWorkspaceText(bytes, { intent = 'edit', details = {} } = {}) {
  try {
    return strictUtf8(bytes, details);
  } catch (error) {
    if (intent !== 'preview') throw error;
    return {
      content: hexPreview(bytes),
      editable: false,
      encoding: previewEncoding(bytes),
      eol: 'lf',
      truncated: bytes.length > PREVIEW_SAMPLE_BYTES,
    };
  }
}

module.exports = {
  UTF8_BOM,
  decodeWorkspaceText,
};
