'use strict';

// Team chat attachments for one team in the Electron main process (row 123 slice 2c renderer; TEAM_CHAT_SPEC
// "2c host as built" and "2c renderer as built"). Built by team-chat.js per team on the first attachment call and
// stopped with the team's chat entry (leave, remove, revoke, a recovery, a Force local hold, the app's stop), which
// ends every upload and download in flight at once and sends nothing more.
//
// - `upload`: bytes the renderer hands over (an ArrayBuffer or a typed array: a paste, a drop, or bytes `pick`
//   answered), at most 4 MiB, checked here before any request. The name goes percent-encoded in `x-file-name` and
//   must pass the host's own name rule; the type is the renderer's when it is in the host's pattern, else
//   `application/octet-stream`, so `mime_type_unsupported` never reaches a person. At most four uploads in flight
//   (the host's per-member cap); each is ended by `uploadCancel` with its renderer-chosen id. The answer is the
//   host's attachment item, checked; a refusal passes through with its checked reason.
// - `pick`: the system file dialog, opened here; the renderer never names a path. Up to `room` files are read
//   (each bounded at 4 MiB before reading; a larger one answers its name and size with no bytes), the rest counted.
// - `image`: one attached file for drawing, answered as a `data:` URL only when the host served it as PNG, JPEG or
//   WebP, its first bytes match, and its header declares at most 8192 px a side and 40 megapixels (read before
//   anything decodes it); anything else is refused (`team_attachment_not_image`) and the row draws it as a file.
// - `save`: the save dialog, then the file fetched and written to a partial name made exclusively beside the target,
//   renamed onto the target (the dialog asked before replacing) and removed on any failure or cancel. The folder's own
//   name is answered; the full path stays here (`reveal` shows the last saved copy of an attachment in its folder).
// - `copy`: a picture to the clipboard, under the same type and pixel checks as `image`.
// - At most 3 picture reads and saves fetch at once; the rest wait their turn.
// - `post`: `team.chat.post` carrying `attachment_ids`, sent only while online and never queued (a staged upload
//   lasts an hour; a queued post could come back later as `team_chat_not_found`). It carries a request id, and a
//   send whose answer was lost is sent once more under the same id, which the host answers from its record.
// Logs carry the team id and reason words only: never a file name, a path or a byte.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { LIMITS, PATTERNS } = require('../host/team-chat-schema');
const { isFileName } = require('../host/team-chat-blobs');
const { openNoFollow, ownDirectory } = require('../../server/team/file-checks');
const { removeFile } = require('../fs-remove-no-follow');
const { chatFailure, invalidRequest, teamFailure } = require('./team-errors');
const { liveLink } = require('./transfer-common');

const MAX_BYTES = LIMITS.ATTACHMENT_MAX_BYTES;
const IN_FLIGHT = 4;
const DOWNLOADS_AT_ONCE = 3;
// The largest picture drawn or copied: its header's declared size, checked before any decoder sees the bytes.
const PICTURE_MAX_SIDE = 8192;
const PICTURE_MAX_PIXELS = 40_000_000;
// A send whose answer was lost: these reasons say the request may not have been answered, so it is sent once more.
const LOST_ANSWER = new Set(['team_not_connected', 'team_connection_reset', 'team_request_timeout', 'team_unavailable']);
const OCTET = 'application/octet-stream';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
// The last saved copy of each attachment `reveal` may show; the oldest goes past this many.
const SAVED_KEEP = 64;
const CREATE_FLAGS = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
// A picked file's type from its extension when the system gives none (the renderer's own files carry theirs).
const EXTENSION_TYPES = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', htm: 'text/html', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
});

const uploadType = (type) => (typeof type === 'string' && PATTERNS.mime.test(type) ? type : OCTET);

/** 1 to 8 distinct attachment ids in the host's pattern (`team.chat.post`'s `attachment_ids`). */
function isAttachmentIds(ids) {
  return Array.isArray(ids) && ids.length >= 1 && ids.length <= LIMITS.ATTACHMENTS_MAX && new Set(ids).size === ids.length
    && ids.every((id) => typeof id === 'string' && PATTERNS.attachment.test(id));
}

/** An ArrayBuffer or a typed array of at least one byte (the size cap is checked by `upload`, with its own reason). */
function isByteContainer(value) {
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return value.byteLength >= 1;
  return ArrayBuffer.isView(value) && value.byteLength >= 1;
}

function bufferOf(value) {
  return ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
}

function isItem(item) {
  return Boolean(item) && typeof item === 'object' && PATTERNS.attachment.test(item.id) && isFileName(item.name)
    && PATTERNS.mime.test(item.mime) && Number.isSafeInteger(item.size_bytes) && item.size_bytes >= 1
    && item.size_bytes <= MAX_BYTES && (item.kind === 'image' || item.kind === 'file');
}

/** The picture type the first bytes say, or null (PNG, JPEG, WebP only). */
function pictureType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The declared pixel size in a picture's header ({ width, height }), or null when it cannot be read. */
function pictureSize(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const type = pictureType(b);
  if (type === 'image/png') return b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  if (type === 'image/jpeg') {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (type === 'image/webp' && b.length >= 30) {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

/** True when bytes served as `type` are a picture Jenny draws: the type, the signature and a readable size in bounds. */
function isDrawable(type, bytes) {
  if (!IMAGE_TYPES.has(type) || pictureType(bytes) !== type) return false;
  const size = pictureSize(bytes);
  return Boolean(size) && size.width >= 1 && size.height >= 1 && size.width <= PICTURE_MAX_SIDE && size.height <= PICTURE_MAX_SIDE
    && size.width * size.height <= PICTURE_MAX_PIXELS;
}

/**
 * A name the save dialog may suggest, and the name a row draws (renderer-team-files.js `shownName` keeps the same
 * rule): the base name only, reserved, control and format (bidi) characters replaced or dropped, no trailing dots
 * or spaces.
 */
function saveName(name) {
  const clean = path.basename(String(name || '').replaceAll('\\', '/')).replace(/\p{Cf}/gu, '')
    // eslint-disable-next-line no-control-regex -- control characters are not valid in file names.
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').trim().replace(/[. ]+$/u, '').slice(0, 200);
  return clean && clean !== '.' && clean !== '..' ? clean : 'file';
}

// The Electron pieces, loaded on first use (a test passes its own).
function electronDialogs() {
  const electron = () => require('electron');
  const owner = () => electron().BrowserWindow.getFocusedWindow();
  const show = (kind, options) => (owner() ? electron().dialog[kind](owner(), options) : electron().dialog[kind](options));
  return {
    async pickFiles() {
      const picked = await show('showOpenDialog', { properties: ['openFile', 'multiSelections'] });
      return picked && !picked.canceled && Array.isArray(picked.filePaths) ? picked.filePaths : [];
    },
    async pickSave(name) {
      const picked = await show('showSaveDialog', { defaultPath: name });
      return picked && !picked.canceled && typeof picked.filePath === 'string' ? picked.filePath : null;
    },
    reveal: (file) => electron().shell.showItemInFolder(file),
    copyImage(bytes) {
      const image = electron().nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return false;
      electron().clipboard.writeImage(image);
      return true;
    },
  };
}

// One picked file: its name, type and size, with its bytes when it fits (read bounded); null when it cannot be read.
async function readPicked(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1) return null;
    const name = path.basename(file);
    const type = EXTENSION_TYPES[path.extname(name).slice(1).toLowerCase()] || '';
    if (stat.size > MAX_BYTES) return { name, type, size: stat.size, bytes: null };
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
    return bytesRead === stat.size ? { name, type, size: stat.size, bytes } : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeAll(handle, bytes) {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written);
    if (bytesWritten <= 0) throw new Error('short write');
    written += bytesWritten;
  }
}

function createChatAttachments({ teamId, manager, log = () => {}, dialogs = null }) {
  const system = dialogs || electronDialogs();
  const uploads = new Map(); // upload id -> AbortController
  const downloads = new Set(); // AbortControllers of picture reads and saves
  const waiting = []; // resolvers of reads waiting for one of the DOWNLOADS_AT_ONCE slots
  let fetching = 0;
  const saved = new Map(); // attachment id -> the path its last save wrote
  let stopped = false;
  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };
  const online = () => { try { return !stopped && manager.snapshot().state === 'online'; } catch { return false; } };
  const notConnected = () => teamFailure('CONNECTION_FAILED', 'team_not_connected');
  const stoppedFailure = () => teamFailure('HOST_STOPPED', 'team_connection_stopped');

  // One raw call on the live link; a call with no answer (or a stop meanwhile) is not connected.
  async function rawCall(run, signal) {
    if (stopped) return stoppedFailure();
    const link = online() ? await liveLink(manager) : null;
    if (!link || stopped || signal.aborted) return stopped ? stoppedFailure() : notConnected();
    // The call ends when its signal does, whether or not the transport has noticed yet.
    let onAbort = null;
    const ended = new Promise((resolve, reject) => { onAbort = () => reject(new Error('aborted')); signal.addEventListener('abort', onAbort, { once: true }); });
    ended.catch(() => {});
    try {
      const answer = await Promise.race([run(link.session, link.client), ended]);
      return stopped ? stoppedFailure() : answer;
    } catch {
      if (stopped) return stoppedFailure();
      return signal.aborted ? invalidRequest('team_request_aborted') : notConnected();
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function upload({ channel_id: channelId, upload_id: uploadId, name, type, bytes }) {
    const body = bufferOf(bytes);
    if (body.length > MAX_BYTES) return invalidRequest('attachment_size_limit');
    if (!isFileName(name)) return invalidRequest('display_name_invalid');
    if (uploads.has(uploadId)) return invalidRequest('team_request_invalid');
    if (uploads.size >= IN_FLIGHT) return teamFailure('CHAT_RETRY_LATER', 'team_upload_limit');
    if (!online()) return notConnected();
    const controller = new AbortController();
    uploads.set(uploadId, controller);
    try {
      const answer = await rawCall((session, client) => session.chatUpload(client, { channelId, name, type: uploadType(type),
        bytes: body, signal: controller.signal }), controller.signal);
      if (answer?.ok !== true) return chatFailure(answer);
      if (!isItem(answer.attachment)) return invalidRequest('team_chat_answer_invalid');
      const { id, name: stored, mime, size_bytes: size, kind } = answer.attachment;
      return { ok: true, attachment: { id, name: stored, mime, size_bytes: size, kind } };
    } finally {
      uploads.delete(uploadId);
    }
  }

  function uploadCancel({ upload_id: uploadId }) {
    uploads.get(uploadId)?.abort();
    return { ok: true };
  }

  // A read slot; false once stopped while waiting.
  function slot() {
    if (fetching < DOWNLOADS_AT_ONCE) { fetching += 1; return Promise.resolve(true); }
    return new Promise((resolve) => { waiting.push(resolve); });
  }
  function release() {
    const next = waiting.shift();
    if (next) next(!stopped); else fetching -= 1;
  }

  // One attached file's bytes and served type, or a failure.
  async function fetchFile(channelId, attachmentId) {
    if (!online()) return notConnected();
    if (!await slot()) return stoppedFailure();
    if (stopped) { release(); return stoppedFailure(); }
    const controller = new AbortController();
    downloads.add(controller);
    try {
      const answer = await rawCall((session, client) => session.chatFile(client, { channelId, attachmentId, signal: controller.signal }),
        controller.signal);
      if (answer?.ok !== true) return chatFailure(answer);
      if (!Buffer.isBuffer(answer.bytes) || answer.bytes.length < 1 || answer.bytes.length > MAX_BYTES) return invalidRequest('team_chat_answer_invalid');
      return { ok: true, bytes: answer.bytes, type: answer.type || OCTET, controller };
    } finally {
      downloads.delete(controller);
      release();
    }
  }

  async function image({ channel_id: channelId, attachment_id: attachmentId }) {
    const got = await fetchFile(channelId, attachmentId);
    if (!got.ok) return got;
    if (!isDrawable(got.type, got.bytes)) return invalidRequest('team_attachment_not_image');
    return { ok: true, data_url: `data:${got.type};base64,${got.bytes.toString('base64')}` };
  }

  async function copy(value) {
    const got = await fetchFile(value.channel_id, value.attachment_id);
    if (!got.ok) return got;
    if (!isDrawable(got.type, got.bytes)) return invalidRequest('team_attachment_not_image');
    try {
      return system.copyImage(got.bytes) ? { ok: true } : invalidRequest('team_attachment_copy_failed');
    } catch {
      return invalidRequest('team_attachment_copy_failed');
    }
  }

  // The bytes written beside `target` under a partial name made exclusively, then renamed onto it; nothing is left
  // behind on a failure.
  async function writeSaved(target, bytes) {
    const folder = path.dirname(target);
    if (!ownDirectory(folder)) return false;
    const partial = path.join(folder, `.jenny-${crypto.randomBytes(6).toString('hex')}.partial`);
    let handle = null;
    let placed = false;
    try {
      handle = await openNoFollow(partial, CREATE_FLAGS, 0o600);
      await writeAll(handle, bytes);
      await handle.close();
      handle = null;
      if (stopped) return false;
      await fs.promises.rename(partial, target);
      placed = true;
      return true;
    } catch {
      return false;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!placed) await removeFile(partial).catch(() => {});
    }
  }

  async function save({ channel_id: channelId, attachment_id: attachmentId, name }) {
    if (!online()) return notConnected();
    let target;
    try { target = await system.pickSave(saveName(name)); } catch { target = null; }
    if (stopped) return stoppedFailure();
    if (typeof target !== 'string' || !path.isAbsolute(target)) return { ok: true, saved: false };
    const got = await fetchFile(channelId, attachmentId);
    if (!got.ok) return got;
    if (got.controller.signal.aborted || stopped) return stopped ? stoppedFailure() : invalidRequest('team_request_aborted');
    if (!await writeSaved(target, got.bytes)) {
      say('WARN', 'team.chat_attachment.save_failed', { reason: 'team_download_write_failed' });
      return invalidRequest('team_download_write_failed');
    }
    saved.delete(attachmentId);
    saved.set(attachmentId, target);
    if (saved.size > SAVED_KEEP) saved.delete(saved.keys().next().value);
    return { ok: true, saved: true, folder: path.basename(path.dirname(target)) || path.dirname(target) };
  }

  function reveal({ attachment_id: attachmentId }) {
    const file = saved.get(attachmentId);
    if (!file || !fs.existsSync(file)) return invalidRequest('team_attachment_not_saved');
    try { system.reveal(file); } catch { return invalidRequest('team_attachment_not_saved'); }
    return { ok: true };
  }

  async function pick({ room }) {
    let files;
    try { files = await system.pickFiles(); } catch { files = []; }
    if (stopped) return stoppedFailure();
    const list = Array.isArray(files) ? files.filter((file) => typeof file === 'string' && path.isAbsolute(file)) : [];
    const read = [];
    for (const file of list.slice(0, room)) {
      const one = await readPicked(file);
      if (one) read.push(one);
    }
    return { ok: true, files: read, not_added: Math.max(0, list.length - room) };
  }

  async function post(value) {
    if (!online()) return notConnected();
    const requestId = `chat_${crypto.randomBytes(18).toString('base64url')}`;
    const send = async () => { try { return await manager.command('team.chat.post', value, { requestId }); } catch { return null; } };
    let answer = await send();
    // The answer was lost: once more under the same id, so the host replays the post it made instead of posting twice.
    if (!stopped && (answer === null || (answer?.ok !== true && LOST_ANSWER.has(answer?.error?.reason))) && online()) answer = await send();
    if (answer === null) return notConnected();
    if (answer?.ok !== true) return chatFailure(answer);
    const out = { ok: true };
    if (typeof answer.message_id === 'string' && PATTERNS.message.test(answer.message_id)) out.message_id = answer.message_id;
    for (const field of ['seq', 'rev']) if (Number.isSafeInteger(answer[field]) && answer[field] > 0) out[field] = answer[field];
    return out;
  }

  const METHODS = {
    chatUpload: upload, chatUploadCancel: uploadCancel, chatAttachPick: pick, chatAttachmentImage: image,
    chatAttachmentSave: save, chatAttachmentReveal: reveal, chatAttachmentCopy: copy, chatPost: post,
  };

  return {
    handle(method, value) {
      if (stopped) return Promise.resolve(stoppedFailure());
      return Promise.resolve().then(() => METHODS[method](value));
    },
    /** Ends every upload and download in flight; nothing more is sent. */
    stop() {
      stopped = true;
      for (const resolve of waiting.splice(0)) resolve(false);
      for (const controller of uploads.values()) controller.abort();
      for (const controller of downloads) controller.abort();
      uploads.clear();
      downloads.clear();
      saved.clear();
    },
    inFlight: () => uploads.size + downloads.size,
  };
}

const ATTACHMENT_METHODS = Object.freeze(['chatUpload', 'chatUploadCancel', 'chatAttachPick', 'chatAttachmentImage',
  'chatAttachmentSave', 'chatAttachmentReveal', 'chatAttachmentCopy']);

module.exports = { ATTACHMENT_METHODS, DOWNLOADS_AT_ONCE, PICTURE_MAX_PIXELS, PICTURE_MAX_SIDE, UPLOAD_ID, createChatAttachments, isAttachmentIds,
  isByteContainer, isFileName, pictureSize, pictureType, saveName };
