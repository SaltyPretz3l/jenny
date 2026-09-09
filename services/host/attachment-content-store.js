'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { readJson, writeJson } = require('./durable-json');
const { MAX_FILE_CHARS, MAX_FILE_SIZE_BYTES, truncateTextToLimit } = require('../attachment-service');
const { buildPromptWithAttachments } = require('../backend/chat-stream-reasoning');

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const HISTORY_TEXT_BUDGET = 40_000;

// Managed attachment bytes, keyed by the existing canonical attachment ID.
// This is not a session/history store; every read must start with a canonical
// message reference. Full-volume backup includes these assets.
function createAttachmentContentStore(userDataPath) {
  const directory = path.join(userDataPath, 'attachments', 'host-text');
  function assetPath(id) {
    if (!ID.test(id)) throw new Error('invalid_attachment_id');
    return path.join(directory, `${id}.json`);
  }
  function save(attachment, bytes) {
    writeJson(assetPath(attachment.id), { schema_version: 1, id: attachment.id,
      bytes: bytes.toString('base64') });
  }
  function read(id, expectedSize) {
    const value = readJson(assetPath(id), { maxBytes: 2 * MAX_FILE_SIZE_BYTES });
    if (value === null) throw Object.assign(new Error('text_asset_missing'), { code: 'ENOENT' });
    if (value.schema_version !== 1 || value.id !== id
      || typeof value.bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.bytes)) throw new Error('invalid_text_asset');
    const bytes = Buffer.from(value.bytes, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_SIZE_BYTES
      || (expectedSize !== undefined && bytes.length !== expectedSize)) throw new Error('invalid_text_asset');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/gu, '\n');
    return { bytes, text: decoded.length > MAX_FILE_CHARS ? truncateTextToLimit(decoded, MAX_FILE_CHARS) : decoded };
  }
  function remove(id) {
    try { fs.unlinkSync(assetPath(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function prune(referencedIds, now = Date.now()) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!ID.test(id) || referencedIds.has(id)) continue;
      if (now - fs.lstatSync(assetPath(id)).mtimeMs >= 86_400_000) remove(id);
    }
  }
  function hydrateHistory(messages) {
    let remaining = HISTORY_TEXT_BUDGET;
    // Most recent document context wins when bounded history is large.
    return [...messages].reverse().map((message) => {
      if (message.role !== 'user' || !Array.isArray(message.attachments)) return message;
      const attachments = [];
      for (const reference of message.attachments) {
        if (reference.kind !== 'text' || !ID.test(reference.id || '') || remaining <= 0) continue;
        try {
          const content = read(reference.id, reference.sizeBytes);
          const text = content.text.slice(0, remaining);
          remaining -= text.length;
          attachments.push({ ...reference, text });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // Portable legacy archives may only have text metadata. Never
          // silently fabricate its content or consult a browser-supplied path.
          attachments.push({ ...reference, text: '[Attachment content unavailable in this profile.]' });
        }
      }
      return attachments.length ? { ...message,
        content: buildPromptWithAttachments(message.content, attachments) } : message;
    }).reverse();
  }
  return { save, read, remove, prune, hydrateHistory };
}

module.exports = { createAttachmentContentStore };
