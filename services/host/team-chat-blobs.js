'use strict';

// Team chat attachment blobs on the host (row 123 slice 2c host, TEAM_CHAT_SPEC "Attachments").
//
//   <profile>/team-chat/blobs/_staged/<att_id>       an upload no post has attached yet (memory record)
//   <profile>/team-chat/blobs/<channel_id>/<att_id>  the bytes of an attachment of a message in that channel
//
// A blob file name is the `att_` id only: the member's file name is data in the message, never a path. A staged
// upload lives in memory and on disk for an hour unless a post attaches it; `open()` removes every staged
// leftover. Nothing here runs a timer: the chat host sweeps with its own injected timers.
//
// Blob trouble never latches the chat store: a read that fails answers not found and forgets the entry; a stage
// or a move that fails is a persistence refusal; an open walk that fails degrades (uploads refused, the affected
// channel's downloads not found) instead of throwing. The staged file is written and a blob read with async calls
// outside the store's write chain. Which files are attached is decided per channel, lazily: every segment read
// while the channel is not reconciled notes the ids its messages name, and the channel's first attachment use
// keeps the files a visible message names and removes the rest. Post order: every check that can refuse runs,
// then the blobs move into the channel directory, then the segment and channel.json are written; a crash between
// the move and the commit leaves files no message names (removed by that reconcile), never a message naming a
// missing file.
//
// Store methods (`blobMethods`) are installed on TeamChatStore.prototype. Logs carry ids, counts, sizes and
// reason words; never a file name or a byte.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const schema = require('./team-chat-schema');
const { logCode } = require('./durable-json');
const { refuse } = require('./team-chat-files');
const { headOnly } = require('./team-chat-retention');
const { hostFailure } = require('../../server/api-contract');

const { LIMITS, PATTERNS } = schema;
const STAGED = '_staged';
const STAGED_TTL_MS = 60 * 60 * 1000;
const STAGED_PER_MEMBER = 16;
// A guard against a tampered tree only: the attachment count limit (50,000 files) keeps a real tree under it.
// Past it uploads are refused until a restart; files past it are still removed by delete and prune.
const WALK_MAX = 100_000;
const IMAGE_SIGNATURES = Object.freeze({
  'image/png': (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': (bytes) => bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP',
});

// `image` only for a declared PNG, JPEG or WebP whose first bytes match it; everything else is a file.
function kindOf(mime, bytes) {
  return Object.hasOwn(IMAGE_SIGNATURES, mime) && IMAGE_SIGNATURES[mime](bytes) ? 'image' : 'file';
}

// A member's file name as the message stores it: 1 to 255 UTF-16 units, not only white space, no control or
// format character (bidi overrides, zero-width controls), no line or paragraph separator, no `/` or `\`, no lone
// surrogate.
function isFileName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= LIMITS.ATTACHMENT_NAME_MAX_CHARS
    && !/^[\s\p{White_Space}]*$/u.test(name) && name.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/u.test(name);
}

const isMime = (mime) => typeof mime === 'string' && PATTERNS.mime.test(mime);

function isIdList(ids) {
  return Array.isArray(ids) && ids.length <= LIMITS.ATTACHMENTS_MAX && new Set(ids).size === ids.length
    && ids.every((id) => typeof id === 'string' && PATTERNS.attachment.test(id));
}

const itemOf = (record) => ({ id: record.id, name: record.name, mime: record.mime, size_bytes: record.size_bytes,
  kind: record.kind });

// A refusal the store answers as is (never latches); `retryable` where the caller may simply try again later.
function refuseWith(kind, reason, retryable) {
  throw Object.assign(new Error(reason), { refusal: hostFailure(kind, reason, '', retryable) });
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function createTeamChatBlobs({ dir, guard, clock, randomBytes, log }) {
  const root = path.join(dir, 'blobs');
  const stagedDir = path.join(root, STAGED);
  const staged = new Map();
  // Ids drawn for a staged file being written, so two uploads never share one.
  const pending = new Set();
  // channel id -> Map(att id -> { bytes, messageId }); messageId is null until the channel is reconciled.
  const attached = new Map();
  // channel id -> Map(message id -> att ids), from the reconcile and every attach: a delete touches at most 8.
  const byMessage = new Map();
  // channel id -> Map(att id -> message id), noted from segment reads until the channel is reconciled.
  const candidates = new Map();
  const ready = new Set();
  // Files a removal could not unlink: still on disk and counted, never served, retried by each sweep.
  const strays = new Map();
  // Channels whose directory the open walk could not read: their downloads answer not found.
  const unreadable = new Set();
  let bytesTotal = 0;
  let blockedReason = null;

  const fileOf = (channelId, id) => path.join(root, channelId, id);
  const exists = (target) => { try { fs.lstatSync(target); return true; } catch { return false; } };
  const guardDirectory = (directory) => guard(path.join(directory, '.guard-probe'));
  const unlinkRaw = (target) => {
    try { fs.unlinkSync(target); return true; } catch (error) { return error?.code === 'ENOENT'; }
  };
  // Guards the nearest existing ancestor before creating a directory, as the store's writes do.
  function ensureDirectory(directory) {
    let ancestor = directory;
    while (!exists(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    guardDirectory(ancestor);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const block = (reason) => { if (blockedReason === null) blockedReason = reason; };

  // Removes the files of `ids` in one directory: the directory is guarded once for the whole operation. A
  // directory that fails the guard is not touched (an unlink through a junction could remove a file elsewhere).
  function unlinkAll(channelId, ids) {
    const files = attached.get(channelId);
    let safe = true;
    try { guardDirectory(path.join(root, channelId)); } catch { safe = false; }
    for (const id of ids) {
      const entry = files?.get(id);
      files?.delete(id);
      const target = fileOf(channelId, id);
      if (safe && unlinkRaw(target)) bytesTotal -= entry?.bytes ?? 0;
      else if (entry) strays.set(target, entry.bytes);
    }
    if (!safe) log('WARN', 'team_chat.blob_remove_failed', { reason: 'directory_unsafe', count: ids.length });
  }

  function walkChannel(channelId, known, budget) {
    const directory = path.join(root, channelId);
    guardDirectory(directory);
    const files = new Map();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (budget.left <= 0) { block('blob_walk_bounded'); break; }
      budget.left -= 1;
      if (entry.isDirectory()) continue;
      const target = path.join(directory, entry.name);
      let stat;
      try { stat = fs.lstatSync(target); } catch { continue; }
      if (known && stat.isFile() && stat.nlink === 1 && PATTERNS.attachment.test(entry.name)) {
        files.set(entry.name, { bytes: stat.size, messageId: null });
        bytesTotal += stat.size;
      } else if (!unlinkRaw(target)) {
        strays.set(target, stat.isFile() ? stat.size : 0);
        bytesTotal += stat.isFile() ? stat.size : 0;
      }
    }
    if (files.size > 0) attached.set(channelId, files);
  }

  function openWalk(knownChannel) {
    if (!exists(root)) return 0;
    guardDirectory(root);
    let removed = 0;
    if (exists(stagedDir)) {
      guardDirectory(stagedDir);
      for (const name of fs.readdirSync(stagedDir)) {
        const target = path.join(stagedDir, name);
        let size = 0;
        try { size = fs.lstatSync(target).size; } catch { /* gone already */ }
        if (unlinkRaw(target)) removed += 1;
        else { strays.set(target, size); bytesTotal += size; }
      }
    }
    const budget = { left: WALK_MAX };
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === STAGED || !entry.isDirectory() || schema.channelKind(entry.name) === null) continue;
      try {
        walkChannel(entry.name, knownChannel(entry.name), budget);
      } catch (error) {
        unreadable.add(entry.name);
        block('blob_channel_unreadable');
        log('WARN', 'team_chat.blob_channel_unreadable', { code: logCode(error?.code || error?.reason) });
      }
    }
    return removed;
  }

  const blobs = {
    // Removes every staged leftover and rebuilds the totals from the blob directories; a directory of a channel the
    // store does not list is emptied (no message names its files). Never throws: a tree it cannot walk blocks
    // uploads until a restart.
    open(knownChannel) {
      for (const table of [staged, pending, attached, byMessage, candidates, ready, strays, unreadable]) table.clear();
      bytesTotal = 0;
      blockedReason = null;
      let removed = 0;
      try {
        removed = openWalk(knownChannel);
      } catch (error) {
        block('blob_tree_unsafe');
        log('WARN', 'team_chat.blob_tree_unsafe', { code: logCode(error?.code || error?.reason) });
      }
      if (blockedReason) log('WARN', 'team_chat.uploads_blocked', { reason: blockedReason });
      log('INFO', 'team_chat.blobs_opened', { staged_removed: removed, bytes: bytesTotal });
    },

    total: () => bytesTotal,
    // Whether the open walk or a later attach found any file of this channel (a channel with none frees none).
    holdsFiles: (channelId) => (attached.get(channelId)?.size ?? 0) > 0,
    fileCount() {
      let count = staged.size + strays.size;
      for (const files of attached.values()) count += files.size;
      return count;
    },
    // Why uploads are refused until a restart (the open walk's bound, an unreadable tree), or null.
    blocked: () => blockedReason,
    isUnreadable: (channelId) => blockedReason === 'blob_tree_unsafe' || unreadable.has(channelId),
    stagedCount: (memberId) => [...staged.values()].filter((record) => record.member_id === memberId).length,

    // Writes a staged file with async calls (exclusive create, a write loop, sync, close). Answers { ok, id } or a
    // refusal (ENOSPC: team_chat_storage_limit); a failure removes what it created. Nothing is counted yet.
    async writeStaged(bytes) {
      let id;
      for (let attempt = 0; attempt < 3 && (!id || staged.has(id) || pending.has(id)); attempt += 1) {
        id = schema.newMessageId(clock(), randomBytes).replace(/^msg_/u, 'att_');
      }
      if (staged.has(id) || pending.has(id)) return hostFailure('persistence', 'team_chat_store_failed');
      pending.add(id);
      const target = path.join(stagedDir, id);
      let created = false;
      try {
        ensureDirectory(stagedDir);
        guard(target);
        const handle = await fsp.open(target, 'wx', 0o600);
        created = true;
        try {
          for (let offset = 0; offset < bytes.length;) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
            if (!(bytesWritten > 0)) throw Object.assign(new Error('short_write'), { code: 'EIO' });
            offset += bytesWritten;
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        guard(target);
        return { ok: true, id };
      } catch (error) {
        pending.delete(id);
        if (created) unlinkRaw(target);
        log('WARN', 'team_chat.upload_write_failed', { code: logCode(error?.code || error?.reason) });
        return error?.code === 'ENOSPC' ? hostFailure('limit', 'team_chat_storage_limit')
          : hostFailure('persistence', 'team_chat_store_failed');
      }
    },

    // Counts a written staged file as an upload. Answers its record.
    register({ id, channelId, memberId, name, mime, bytes }) {
      pending.delete(id);
      const record = { id, channel_id: channelId, member_id: memberId, name, mime, size_bytes: bytes.length,
        kind: kindOf(mime, bytes), at: clock() };
      staged.set(id, record);
      bytesTotal += bytes.length;
      log('INFO', 'team_chat.upload_staged', { attachment_id: id, bytes: bytes.length, kind: record.kind });
      return record;
    },

    // Removes a written staged file that was never counted (its registration was refused).
    unwritten(id) {
      pending.delete(id);
      try { guard(path.join(stagedDir, id)); unlinkRaw(path.join(stagedDir, id)); } catch { /* the sweep cannot see it */ }
    },

    discard(id) {
      const record = staged.get(id);
      if (!record) return false;
      staged.delete(id);
      const target = path.join(stagedDir, id);
      let removed;
      try { guard(target); removed = unlinkRaw(target); } catch { removed = false; }
      if (removed) bytesTotal -= record.size_bytes;
      else strays.set(target, record.size_bytes);
      return true;
    },

    // The staged records the ids name, in order, when each is this member's, for this channel and not expired;
    // else null. Changes nothing.
    take(ids, channelId, memberId) {
      const now = clock();
      const records = ids.map((id) => staged.get(id));
      return records.every((record) => record && record.channel_id === channelId && record.member_id === memberId
        && now - record.at < STAGED_TTL_MS) ? records : null;
    },

    // Moves staged blobs into the channel directory for `messageId`. A record leaves the staged set once its file
    // moved; any failure is a persistence refusal with the rest still staged.
    attach(channelId, messageId, records) {
      const directory = path.join(root, channelId);
      try {
        ensureDirectory(directory);
        const files = attached.get(channelId) ?? new Map();
        attached.set(channelId, files);
        const named = byMessage.get(channelId) ?? new Map();
        byMessage.set(channelId, named);
        for (const record of records) {
          const from = path.join(stagedDir, record.id);
          const to = fileOf(channelId, record.id);
          guard(from);
          guard(to);
          if (exists(to)) throw Object.assign(new Error('target_exists'), { code: 'EEXIST' });
          fs.renameSync(from, to);
          staged.delete(record.id);
          files.set(record.id, { bytes: record.size_bytes, messageId });
          named.set(messageId, [...(named.get(messageId) ?? []), record.id]);
        }
        syncDirectory(directory);
      } catch (error) {
        log('WARN', 'team_chat.blob_move_failed', { code: logCode(error?.code || error?.reason) });
        refuse('persistence', 'team_chat_store_failed');
      }
    },

    isReady: (channelId) => ready.has(channelId),
    isStaged: (id) => staged.has(id),
    // The message an attached blob belongs to, or null (not attached, or the channel not reconciled).
    messageOf: (channelId, id) => attached.get(channelId)?.get(id)?.messageId ?? null,

    // While the channel is not reconciled: the attachment ids each message of a segment read names.
    note(channelId, segment) {
      if (ready.has(channelId)) return;
      let named = candidates.get(channelId);
      for (const message of segment.messages) {
        if (message.attachments.length === 0) continue;
        if (!named) { named = new Map(); candidates.set(channelId, named); }
        for (const item of message.attachments) named.set(item.id, message.id);
      }
    },

    // Keeps the channel's files a live message names (`isLive(message id)`) and removes the rest. Every id a live
    // message names joins the message index, found on disk or not (a file past the walk's bound is still removed
    // with its message).
    reconcile(channelId, isLive) {
      const named = candidates.get(channelId) ?? new Map();
      const files = attached.get(channelId) ?? new Map();
      const index = new Map();
      for (const [id, messageId] of named) {
        if (isLive(messageId)) index.set(messageId, [...(index.get(messageId) ?? []), id]);
      }
      const gone = [];
      let missing = 0;
      for (const [id, entry] of files) {
        const messageId = named.get(id);
        if (messageId !== undefined && isLive(messageId)) entry.messageId = messageId;
        else gone.push(id);
      }
      for (const ids of index.values()) missing += ids.filter((id) => !files.has(id)).length;
      if (gone.length > 0) unlinkAll(channelId, gone);
      byMessage.set(channelId, index);
      candidates.delete(channelId);
      ready.add(channelId);
      if (gone.length > 0 || missing > 0) log('WARN', 'team_chat.blobs_reconciled', { removed: gone.length, missing });
    },

    // A removed channel (E67): its files unlinked (one that will not go stays a counted stray) and its tables dropped.
    dropChannel(channelId) {
      if (attached.has(channelId)) unlinkAll(channelId, [...attached.get(channelId).keys()]);
      for (const table of [attached, byMessage, candidates]) table.delete(channelId);
      ready.delete(channelId);
      unreadable.delete(channelId);
    },

    // The channel is reconciled again from its next load (a write that failed after blobs moved).
    unready(channelId) { ready.delete(channelId); candidates.delete(channelId); },

    // The bytes and count of the files on disk a message of a reconciled channel names (what pruning it frees).
    heldBy(channelId, messageId) {
      const files = attached.get(channelId);
      const held = { bytes: 0, files: 0 };
      for (const id of byMessage.get(channelId)?.get(messageId) ?? []) {
        const entry = files?.get(id);
        if (entry) { held.bytes += entry.bytes; held.files += 1; }
      }
      return held;
    },

    // Removes one message's blobs (a delete).
    removeMessage(channelId, messageId) {
      const ids = byMessage.get(channelId)?.get(messageId);
      if (!ids) return;
      byMessage.get(channelId).delete(messageId);
      unlinkAll(channelId, ids);
    },

    // Removes the blobs of every message `gone(message id)` names (a prune), the directory guarded once.
    removeMessages(channelId, gone) {
      const index = byMessage.get(channelId);
      const ids = [];
      for (const [messageId, named] of index ?? []) {
        if (!gone(messageId)) continue;
        index.delete(messageId);
        ids.push(...named);
      }
      if (ids.length > 0) unlinkAll(channelId, ids);
    },

    // The bytes of an attached blob of `messageId` read with async calls, or null. A failed read (gone, unsafe, a
    // size that disagrees) forgets the entry: a missing file leaves the totals, any other stays a counted stray.
    async readFile(channelId, id, messageId, sizeBytes) {
      const entry = attached.get(channelId)?.get(id);
      if (!entry || entry.messageId !== messageId) return null;
      const target = fileOf(channelId, id);
      try {
        guard(target);
        const stat = await fsp.lstat(target);
        if (!stat.isFile() || stat.size !== sizeBytes) throw Object.assign(new Error('size_mismatch'), { code: 'EBADSIZE' });
        const bytes = await fsp.readFile(target);
        guard(target);
        if (bytes.length !== sizeBytes) throw Object.assign(new Error('size_mismatch'), { code: 'EBADSIZE' });
        return bytes;
      } catch (error) {
        if (attached.get(channelId)?.get(id) === entry) {
          attached.get(channelId).delete(id);
          if (error?.code === 'ENOENT') bytesTotal -= entry.bytes;
          else strays.set(target, entry.bytes);
        }
        log('WARN', 'team_chat.blob_read_failed', { attachment_id: id, code: logCode(error?.code || error?.reason) });
        return null;
      }
    },

    // Removes staged uploads past their hour and retries stray removals. Answers how many staged ones went.
    sweep() {
      const now = clock();
      let expired = 0;
      for (const record of [...staged.values()]) {
        if (now - record.at < STAGED_TTL_MS) continue;
        blobs.discard(record.id);
        expired += 1;
      }
      for (const [target, bytes] of [...strays]) {
        let removed;
        try { guard(target); removed = unlinkRaw(target); } catch { removed = false; }
        if (removed) { strays.delete(target); bytesTotal -= bytes; }
      }
      if (expired > 0) log('INFO', 'team_chat.uploads_expired', { count: expired });
      return expired;
    },
  };
  return blobs;
}

// ------------------------------------------------------------ store methods

const blobMethods = {
  // Reconciles the loaded channel's blobs before its first attachment use.
  _blobsReady(state) {
    if (!this._blobs.isReady(state.doc.channel_id)) {
      this._blobs.reconcile(state.doc.channel_id, (messageId) => state.byId.has(messageId));
    }
  },

  // The refusals an upload gets before its body is read: the channel, archived, blocked uploads, the staged cap.
  uploadPrecheck(channelId, memberId) {
    return this._readOp(() => {
      const state = this._channelDoc(channelId);
      if (state.doc.archived) refuse('forbidden', 'team_chat_archived');
      if (this._blobs.blocked()) refuse('limit', 'team_chat_storage_limit');
      if (this._blobs.stagedCount(memberId) >= STAGED_PER_MEMBER) refuseWith('limit', 'team_upload_limit', true);
      return { ok: true };
    });
  },

  // Writes the staged file outside the write chain, then, after the channel's load, registers it in the chain once
  // the limits pass: per member, the team's attachment bytes and files, and the tree (segments and blobs). Over a
  // limit the make-room plan prunes what makes the upload fit; when none does, team_chat_storage_limit with nothing
  // pruned. A refusal removes the written file.
  async stageAttachment(input = {}) {
    const { channelId, memberId, name, mime, bytes } = input;
    if (!schema.isMemberId(memberId) || !isFileName(name) || !isMime(mime) || !Buffer.isBuffer(bytes)
      || bytes.length < 1 || bytes.length > LIMITS.ATTACHMENT_MAX_BYTES) {
      return hostFailure('invalid', 'team_chat_request_invalid');
    }
    const written = await this._blobs.writeStaged(bytes);
    if (!written.ok) return written;
    const registered = await this._afterLoad(channelId, () => this._mutate(() => {
      const state = this._channelDoc(channelId);
      if (state.doc.archived) refuse('forbidden', 'team_chat_archived');
      if (this._blobs.blocked()) refuse('limit', 'team_chat_storage_limit');
      if (this._blobs.stagedCount(memberId) >= STAGED_PER_MEMBER) refuseWith('limit', 'team_upload_limit', true);
      // Over a limit: planned before any prune; no plan that fits, nothing removed (team-chat-room.js, round two).
      const upload = { bytes: bytes.length };
      if (!this._roomFits(upload.bytes, upload)) this._makeRoom(state, headOnly(state.doc.segments), 0, upload.bytes, upload);
      const record = this._blobs.register({ id: written.id, channelId, memberId, name, mime, bytes });
      return { ok: true, attachment: itemOf(record), pruned: this._pruned };
    }));
    if (!registered.ok) this._blobs.unwritten(written.id);
    return registered;
  },

  // Drops a staged upload (the route's guard refused after the write).
  discardAttachment(id) { return this._blobs.discard(id); },

  stagedAttachmentCount(memberId) { return this._blobs.stagedCount(memberId); },

  sweepStagedAttachments() { return this._blobs.sweep(); },

  // An attached blob of a visible message in this channel, with its item; anything else team_chat_not_found. The
  // entry is resolved in a read, the file read with async calls after it.
  async readAttachment(channelId, attachmentId) {
    await this.ensureLoaded(channelId);
    const resolved = this._readOp(() => {
      const state = this._channel(channelId);
      if (typeof attachmentId !== 'string' || !PATTERNS.attachment.test(attachmentId)
        || this._blobs.isUnreadable(channelId)) refuse('forbidden', 'team_chat_not_found');
      this._blobsReady(state);
      const owner = this._blobs.messageOf(channelId, attachmentId);
      const found = owner ? this._find(state, owner) : null;
      const item = found?.message.deleted === null ? found.message.attachments.find((entry) => entry.id === attachmentId) : null;
      if (!item) refuse('forbidden', 'team_chat_not_found');
      return { ok: true, item, owner };
    });
    if (!resolved.ok) return resolved;
    const bytes = await this._blobs.readFile(channelId, attachmentId, resolved.owner, resolved.item.size_bytes);
    return bytes ? { ok: true, attachment: { ...resolved.item }, bytes } : hostFailure('forbidden', 'team_chat_not_found');
  },

  // The post's attachment ids checked and their staged records, before anything is written.
  _postAttachments(state, actorId, ids) {
    if (ids.length === 0) return [];
    const records = this._blobs.take(ids, state.doc.channel_id, actorId);
    if (!records) refuse('forbidden', 'team_chat_not_found');
    this._blobsReady(state);
    return records;
  },

  // Runs the append; when it fails after blobs moved (only an I/O failure can follow the move), the channel
  // reloads and is reconciled again.
  _withAttachments(state, records, append) {
    try {
      return append();
    } catch (error) {
      if (records.some((record) => !this._blobs.isStaged(record.id))) {
        this._blobs.unready(state.doc.channel_id);
        this._forgetWrite(this._file(state.doc.channel_id, 'channel.json'));
      }
      throw error;
    }
  },

  // After a committed prune: the blobs of the messages `gone` names. A channel not reconciled yet is reconciled
  // now, which removes them too (a pruned message is no longer in the index).
  _dropBlobs(state, gone) {
    if (!this._blobs.isReady(state.doc.channel_id)) this._blobsReady(state);
    else this._blobs.removeMessages(state.doc.channel_id, gone);
  },
};

module.exports = { STAGED_PER_MEMBER, blobMethods, createTeamChatBlobs, isFileName, isIdList, isMime, itemOf };
