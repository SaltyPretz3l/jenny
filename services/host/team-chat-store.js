'use strict';

// The host-side team chat store (row 123 slice 2a-1, TEAM_CHAT_SPEC "Store").
// A pure module: no HTTP, no authorization (slice 2a-3 authorizes before it
// calls in), no timers, no network. Actor ids are plain inputs and a missing
// or malformed one is refused, never defaulted.
//
//   <profile>/team-chat/index.json               channel list
//   <profile>/team-chat/<channel_id>/channel.json counters, segment index, requests
//   <profile>/team-chat/<channel_id>/seg-<n>.json  up to 500 messages or 1 MiB
//   <profile>/team-chat/<channel_id>/read.json     per-member read state
//
// Write order (channel.json is the commit point of every message change):
//   post    [the cleaned old head, when rolling past a head that still holds
//           dropped messages], the head segment, the root's segment for a
//           reply, then channel.json
//   edit    the message's segment, then channel.json
//   prune   channel.json, then unlink the removed segments (best effort); a
//           prune is a whole commit on its own
//   create  channel.json, then index.json
// A crash before channel.json leaves the previous commit: on load a message at
// or past next_seq is dropped (a retry creates it once), an unreferenced new
// segment is a stray, a revision past channel.rev rolls forward so none is
// reused, reply counts are recounted, and strays are swept after the channel's
// next commit. Failures: a refusal, a transient I/O error or a failed first
// write answer without latching; corruption in one channel's segments or
// read.json breaks only that channel; corruption in index.json or a
// channel.json, or any failure after a file was written, latches the store
// until restart. Nothing mutates a channel document in place: every commit
// builds a new one by shallow spread. Logs carry ids, sizes and counts only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const durable = require('./durable-json');
const { assertSafeFile } = require('./path-guard');
const { hostFailure } = require('../../server/api-contract');
const { safeLogger } = require('../../server/team/safe-logger');
const schema = require('./team-chat-schema');
const retention = require('./team-chat-retention');
const channels = require('./team-chat-channel');
const files = require('./team-chat-files');
const { readStateMethods } = require('./team-chat-read-state');
const { readMethods } = require('./team-chat-reads');
const { loaderMethods, yieldToEventLoop } = require('./team-chat-loader');

const { LIMITS, SCHEMA_VERSION } = schema;
const { bytesOf, segmentMeta } = channels;
const { checked, corrupt, isTransient, refuse } = files;
const { sumBytes } = retention;
const INDEX_FILE = 'index.json';
const CHANNEL_FILE = 'channel.json';
const HARD = LIMITS.SEGMENT_HARD_MAX_BYTES;

const iso = (ms) => new Date(ms).toISOString();

class TeamChatStore {
  constructor({
    profileDir, clock = Date.now, randomBytes = crypto.randomBytes, logger = null,
    assertSafePath = assertSafeFile, fileOps = {}, limits = {}, yieldTo = yieldToEventLoop,
  } = {}) {
    if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) {
      throw new TypeError('TeamChatStore requires an absolute profileDir.');
    }
    if (typeof assertSafePath !== 'function') throw new TypeError('TeamChatStore requires a path guard.');
    if (typeof yieldTo !== 'function') throw new TypeError('TeamChatStore requires a yield function.');
    this.dir = path.join(profileDir, 'team-chat');
    this._clock = clock;
    this._randomBytes = randomBytes;
    this._log = safeLogger(logger);
    this._limits = retention.resolveLimits(limits);
    const ops = {
      readJson: fileOps.readJson || durable.readJson,
      writeText: fileOps.writeText || durable.writeText,
      removeFile: fileOps.removeFile || ((target) => fs.unlinkSync(target)),
      listDir: fileOps.listDir || ((target) => fs.readdirSync(target)),
    };
    this._files = files.createFileIo({ guard: assertSafePath, ops, log: this._log });
    this._io = {
      readSegment: (channelId, n) => this._readSegment(channelId, n),
      listDir: (channelId) => this._files.list(path.join(this.dir, channelId)),
    };
    this._index = null;
    this._channels = new Map();
    this._broken = null;
    this._chain = Promise.resolve();
    // Slice 2a-3b: the yielding first load (team-chat-loader.js). At most one
    // load per channel; `_waiting` holds mutations waiting for one.
    this._yieldTo = yieldTo;
    this._loads = new Map();
    this._waiting = new Set();
    this._tails = new Map();
    this._loadFailures = new Map();
    // The prune reports of the mutation running now, so a failure after a
    // committed prune still carries them.
    this._pruned = [];
  }

  _file(channelId, name) { return path.join(this.dir, channelId, name); }

  // ------------------------------------------------------------ failure

  _brokenFailure() { return hostFailure('persistence', this._broken); }

  _fail(error, stage) {
    if (this._files.written === 0) {
      if (error?.refusal) return error.refusal;
      if (error?.duringWrite || isTransient(error)) {
        if (error.duringWrite) this._forgetWrite(error.filePath);
        this._log('WARN', 'team_chat.io_failed', { stage, code: error.code || null });
        return hostFailure('persistence', 'team_chat_store_failed');
      }
      const state = error?.brokenReason && error.channelId ? this._channels.get(error.channelId) : null;
      if (state) {
        state.broken = error.brokenReason;
        this._log('ERROR', 'team_chat.channel_broken', { channel_id: error.channelId, reason: state.broken,
          cause: error.cause || null });
        return hostFailure('persistence', state.broken);
      }
    }
    this._broken = error?.brokenReason || 'team_chat_store_failed';
    this._index = null;
    this._channels = new Map();
    this._loadFailures = new Map();
    this._log('ERROR', 'team_chat.broken', { stage, reason: this._broken, cause: error?.cause || null,
      code: error?.code || null, written: this._files.written });
    return this._brokenFailure();
  }

  // A failed write may still have landed (durable-json fsyncs the directory
  // after the rename), so memory stops vouching for that channel: the next
  // access reloads it, dropping an uncommitted message, marking a dirty head
  // and rolling a revision forward. index.json and a new channel need nothing:
  // torn create covers them.
  _forgetWrite(filePath) {
    const state = typeof filePath === 'string'
      ? this._channels.get(path.relative(this.dir, filePath).split(path.sep)[0]) : undefined;
    if (!state) return;
    Object.assign(state, { loaded: false, entries: undefined, byId: undefined, threads: undefined, head: null,
      headDirty: false, read: undefined });
  }

  // ------------------------------------------------------------ open and load

  // Loads index.json and every channel.json. Idempotent; never writes.
  open() {
    if (this._broken) return this._brokenFailure();
    if (this._index) return { ok: true };
    this._files.written = 0;
    try {
      const stored = this._files.read(path.join(this.dir, INDEX_FILE), LIMITS.INDEX_MAX_BYTES);
      const index = stored || { schema_version: SCHEMA_VERSION, channels: [] };
      checked(schema.validateIndexDoc(index));
      const states = new Map();
      for (const entry of index.channels) {
        const doc = this._files.read(this._file(entry.channel_id, CHANNEL_FILE), LIMITS.CHANNEL_MAX_BYTES);
        if (doc === null) throw corrupt('channel_missing');
        checked(schema.validateChannelDoc(doc, entry.channel_id));
        states.set(entry.channel_id, channels.newState(doc));
      }
      this._index = index;
      this._channels = states;
      return { ok: true };
    } catch (error) {
      return this._fail(error, 'open');
    }
  }

  _loadChannel(state) {
    let outcome;
    try {
      outcome = channels.loadChannel(state, this._io);
    } catch (error) {
      if (error?.brokenReason) error.channelId = state.doc.channel_id;
      throw error;
    }
    if (outcome.strays > 0 || outcome.rolledForward > 0) {
      this._log('WARN', 'team_chat.reconciled', { channel_id: state.doc.channel_id, strays: outcome.strays,
        rolled_forward: outcome.rolledForward });
    }
  }

  _readSegment(channelId, n) {
    const segment = this._files.read(this._file(channelId, `seg-${n}.json`), HARD);
    const result = segment === null ? { ok: false, reason: 'segment_missing' } : schema.validateSegmentDoc(segment, channelId, n);
    if (!result.ok) throw Object.assign(corrupt(result.reason, result.schema), { channelId });
    return segment;
  }

  // The channel document only (no segment load): read state, archive, listing.
  _channelDoc(channelId) {
    if (schema.channelKind(channelId) === null) refuse('forbidden', 'team_chat_not_found');
    const state = this._channels.get(channelId);
    if (!state) refuse('forbidden', 'team_chat_not_found');
    if (state.broken) refuse('persistence', state.broken);
    return state;
  }

  _channel(channelId) {
    const state = this._channelDoc(channelId);
    const failed = state.loaded ? undefined : this._takeLoadFailure(channelId);
    if (failed !== undefined) throw failed;
    this._loadChannel(state);
    return state;
  }

  _find(state, messageId) { return channels.findMessage(state, messageId, this._io); }

  _materialize(state, entries) { return channels.materialize(state, entries, this._io); }

  // ------------------------------------------------------------ plumbing

  _mutate(fn) {
    const run = () => {
      const loaded = this.open();
      if (!loaded.ok) return loaded;
      this._files.written = 0;
      this._pruned = [];
      try {
        return fn();
      } catch (error) {
        const failure = this._fail(error, 'mutate');
        return this._pruned.length > 0 ? { ...failure, pruned: this._pruned } : failure;
      }
    };
    const result = this._chain.then(run, run);
    this._chain = result.catch(() => undefined);
    return result;
  }

  _readOp(fn) {
    const loaded = this.open();
    if (!loaded.ok) return loaded;
    this._files.written = 0;
    try {
      return fn();
    } catch (error) {
      return this._fail(error, 'read');
    }
  }

  _requestKey(input) {
    if (!schema.isMemberId(input.actorId) || !schema.isDeviceId(input.deviceId)
      || typeof input.requestId !== 'string' || !schema.PATTERNS.token.test(input.requestId)) {
      refuse('invalid', 'team_chat_request_invalid');
    }
    return { actorId: input.actorId, deviceId: input.deviceId, requestId: input.requestId };
  }

  _replay(state, key, digest) {
    const entry = channels.findRequest(state.doc, key, this._clock());
    if (!entry) return null;
    if (entry.digest !== digest) refuse('conflict', 'request_payload_changed');
    return { ok: true, ...entry.result, replayed: true, pruned: [] };
  }

  _textInput(input) {
    if (!schema.isMessageText(input.text)) refuse('invalid', 'team_chat_text_invalid');
    const mentions = input.mentions === undefined ? [] : input.mentions;
    if (!schema.isMentionList(mentions)) refuse('invalid', 'team_chat_request_invalid');
    return { text: input.text, mentions };
  }

  _meta(state, n) { return state.doc.segments.find((meta) => meta.n === n); }

  // The thread root a message id names: itself, or the root of a reply.
  _rootEntry(state, messageId) {
    const found = schema.isMessageId(messageId) ? state.byId.get(messageId) : undefined;
    if (!found) refuse('forbidden', 'team_chat_not_found');
    return found.root === null ? found : state.byId.get(found.root);
  }

  // Draws again on a collision; repeated collisions are refused, never latched.
  _newId(state, now) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = schema.newMessageId(now, this._randomBytes);
      if (!state.byId.has(id)) return id;
    }
    this._log('WARN', 'team_chat.id_collision', { channel_id: state.doc.channel_id });
    return refuse('persistence', 'team_chat_store_failed');
  }

  _commitChannel(state, nextDoc) {
    this._files.write(this._file(nextDoc.channel_id, CHANNEL_FILE), nextDoc, LIMITS.CHANNEL_MAX_BYTES);
    state.doc = nextDoc;
  }

  // Removes strays left by a torn write, never a segment the channel now lists.
  _sweep(state) {
    if (state.strays.length === 0) return;
    const listed = new Set(state.doc.segments.map((meta) => `seg-${meta.n}.json`));
    state.strays = state.strays.filter((name) => !listed.has(name)
      && !this._files.remove(this._file(state.doc.channel_id, name), state.doc.channel_id));
  }

  // ------------------------------------------------------------ retention

  // Plans from segment metadata and applies the pruning a mutation needs.
  // Refuses team_chat_storage_limit, writing nothing, when no plan makes room.
  _makeRoom(state, protectedNs, incoming, delta) {
    const removals = retention.planRoom({ states: [...this._channels.values()], target: state, protectedNs, incoming,
      delta, now: this._clock(), limits: this._limits });
    if (removals === null) refuse('limit', 'team_chat_storage_limit');
    return [...removals].map(([id, count]) => this._prune(this._channels.get(id), count));
  }

  // Commits the removal of the channel's `count` oldest segments (loading the
  // channel only now), then unlinks them. A whole commit on its own.
  _prune(state, count) {
    this._loadChannel(state);
    const doc = state.doc;
    const removed = doc.segments.slice(0, count);
    const kept = doc.segments.slice(count);
    const floorSeq = removed[removed.length - 1].last_seq + 1;
    const { removedIds, orphanIds } = retention.prunedThreads(state.entries, floorSeq);
    const gone = (messageId) => removedIds.has(messageId) || orphanIds.has(messageId);
    this._commitChannel(state, { ...doc, segments: kept, floor_seq: floorSeq, rev: doc.rev + 1, bytes: sumBytes(kept),
      pins: doc.pins.filter((messageId) => !gone(messageId)) });
    channels.forgetMessages(state, gone);
    for (const meta of removed) {
      const name = `seg-${meta.n}.json`;
      if (!this._files.remove(this._file(doc.channel_id, name), doc.channel_id)) state.strays.push(name);
    }
    this._files.written = 0;
    const report = {
      channel_id: doc.channel_id, reason: 'pruned', floor_seq: floorSeq, channel_rev: state.doc.rev,
      segments_removed: count, messages_removed: removedIds.size, replies_removed: orphanIds.size,
      bytes_removed: sumBytes(removed),
    };
    this._log('INFO', 'team_chat.pruned', report);
    this._pruned.push(report);
    return report;
  }

  applyRetention() {
    return this._afterLoads(() => this._mutate(() => {
      const plan = retention.planSweep({ states: [...this._channels.values()], now: this._clock(), limits: this._limits });
      const pruned = plan.map(([id, count]) => this._prune(this._channels.get(id), count));
      for (const state of this._channels.values()) if (state.loaded) this._sweep(state);
      return { ok: true, pruned };
    }));
  }

  // ------------------------------------------------------------ channels

  createChannel(input = {}) {
    return this._mutate(() => {
      const channelId = input.channelId;
      const kind = schema.channelKind(channelId);
      if (kind === null) refuse('forbidden', 'team_chat_not_found');
      const existing = this._channels.get(channelId);
      if (existing) return { ok: true, channel_id: channelId, kind, created: false, rev: existing.doc.rev };
      const folded = channelId.toLowerCase();
      if ([...this._channels.keys()].some((other) => other.toLowerCase() === folded)) {
        refuse('invalid', 'team_chat_request_invalid');
      }
      if (this._channels.size >= LIMITS.CHANNELS_MAX) refuse('limit', 'team_chat_storage_limit');
      const createdAt = iso(this._clock());
      const doc = schema.emptyChannelDoc(channelId, kind, createdAt);
      this._files.write(this._file(channelId, CHANNEL_FILE), doc, LIMITS.CHANNEL_MAX_BYTES);
      const index = { schema_version: SCHEMA_VERSION,
        channels: [...this._index.channels, { channel_id: channelId, kind, created_at: createdAt }] };
      this._files.write(path.join(this.dir, INDEX_FILE), index, LIMITS.INDEX_MAX_BYTES);
      this._index = index;
      this._channels.set(channelId, channels.newState(doc));
      this._log('INFO', 'team_chat.channel_created', { channel_id: channelId });
      return { ok: true, channel_id: channelId, kind, created: true, rev: 0 };
    });
  }

  archiveChannel(input = {}) {
    return this._mutate(() => {
      const state = this._channelDoc(input.channelId);
      if (state.doc.archived) return { ok: true, rev: state.doc.rev };
      this._commitChannel(state, { ...state.doc, archived: { at: iso(this._clock()) }, rev: state.doc.rev + 1 });
      return { ok: true, rev: state.doc.rev };
    });
  }

  // ------------------------------------------------------------ messages

  post(input = {}) {
    return this._afterLoad(input.channelId, () => this._mutate(() => {
      const state = this._channel(input.channelId);
      const key = this._requestKey(input);
      const authorKind = input.authorKind === undefined ? 'member' : input.authorKind;
      if (!schema.AUTHOR_KINDS.includes(authorKind)) refuse('invalid', 'team_chat_request_invalid');
      const { text, mentions } = this._textInput(input);
      if (input.refs !== undefined && !schema.isRefList(input.refs)) refuse('invalid', 'team_chat_ref_invalid');
      const refs = schema.normalizeRefs(input.refs || []);
      const threadRootId = input.threadRootId === undefined ? null : input.threadRootId;
      const digest = channels.digestOf('post', [key.actorId, authorKind, text, refs, threadRootId]);
      const replay = this._replay(state, key, digest);
      if (replay) return replay;
      if (state.doc.archived) refuse('forbidden', 'team_chat_archived');
      const root = threadRootId === null ? null : this._find(state, this._rootEntry(state, threadRootId).id);
      const now = this._clock();
      const message = {
        id: this._newId(state, now), channel_id: state.doc.channel_id, seq: state.doc.next_seq, rev: state.doc.rev + 2,
        author: { kind: authorKind, member_id: key.actorId }, created_at: iso(now), edited_at: null, text,
        thread_root_id: root ? root.entry.id : null, reply_count: 0, last_reply_at: null, mentions: [...mentions],
        refs, attachments: [], edits: [], reactions: {}, pinned: null, deleted: null, served_by: null,
      };
      if (!schema.validateMessage(message, state.doc.channel_id)) throw corrupt('message_build_invalid');
      return this._append(state, key, digest, message, root);
    }));
  }

  // The room check runs on segments built with a revision at least as long as
  // the real one (a prune adds at most one), so it never under-counts. The
  // current head is protected as well as the target: retention removes it on
  // a later pass.
  _append(state, key, digest, message, root) {
    const channelId = state.doc.channel_id;
    const estimate = channels.buildAppend(state, message, root, this._limits);
    const rootSegment = estimate.rootSegment;
    if (rootSegment && bytesOf(rootSegment) > HARD) refuse('limit', 'team_chat_storage_limit');
    const rootGrowth = rootSegment ? bytesOf(rootSegment) - this._meta(state, root.entry.n).bytes : 0;
    const headN = state.head ? state.head.n : null;
    const protectedNs = new Set([estimate.n, headN, root ? root.entry.n : null].filter((n) => n !== null));
    const pruned = this._makeRoom(state, protectedNs, 1, bytesOf(estimate.target) - estimate.headBytes + rootGrowth);
    message.rev = state.doc.rev + 1;
    const built = channels.buildAppend(state, message, root, this._limits);
    if (built.roll && state.headDirty) this._files.write(this._file(channelId, `seg-${headN}.json`), state.head, HARD);
    const targetBytes = this._files.write(this._file(channelId, `seg-${built.n}.json`), built.target, HARD);
    const rootBytes = built.rootSegment
      ? this._files.write(this._file(channelId, `seg-${root.entry.n}.json`), built.rootSegment, HARD) : 0;
    const metas = state.doc.segments.filter((meta) => meta.n !== built.n).map((meta) => (
      built.rootSegment && meta.n === root.entry.n ? segmentMeta(meta.n, built.rootSegment, rootBytes, meta.newest_at) : meta));
    metas.push(segmentMeta(built.n, built.target, targetBytes, built.newestAt));
    const result = { message_id: message.id, seq: message.seq, rev: message.rev };
    this._commitChannel(state, {
      ...state.doc, next_seq: message.seq + 1, rev: message.rev, segments: metas, bytes: sumBytes(metas),
      requests: channels.requestsWith(state.doc, key, digest, result, this._clock()),
    });
    channels.rememberAppend(state, message, built.n, built.target, root ? root.message : null);
    this._sweep(state);
    this._log('INFO', 'team_chat.posted', { channel_id: channelId, seq: message.seq, rev: message.rev, bytes: targetBytes });
    return { ok: true, ...result, replayed: false, pruned };
  }

  edit(input = {}) {
    return this._afterLoad(input.channelId, () => this._mutate(() => {
      const state = this._channel(input.channelId);
      const key = this._requestKey(input);
      const { text, mentions } = this._textInput(input);
      if (!schema.isPositive(input.expectedRev)) refuse('invalid', 'team_chat_request_invalid');
      const digest = channels.digestOf('edit', [key.actorId, input.messageId, text, input.expectedRev]);
      const replay = this._replay(state, key, digest);
      if (replay) return replay;
      if (state.doc.archived) refuse('forbidden', 'team_chat_archived');
      const found = this._find(state, input.messageId);
      if (!found || found.message.deleted !== null) refuse('forbidden', 'team_chat_not_found');
      if (found.message.rev !== input.expectedRev) refuse('conflict', 'team_chat_stale');
      const old = found.message;
      const edits = [...old.edits, { text: old.text, edited_at: old.edited_at || old.created_at }].slice(-LIMITS.EDITS_MAX);
      return this._rewrite(state, key, digest, found,
        (rev) => ({ ...old, text, mentions: [...mentions], edits, edited_at: iso(this._clock()), rev }));
    }));
  }

  delete(input = {}) {
    return this._afterLoad(input.channelId, () => this._mutate(() => {
      const state = this._channel(input.channelId);
      const key = this._requestKey(input);
      const digest = channels.digestOf('delete', [key.actorId, input.messageId]);
      const replay = this._replay(state, key, digest);
      if (replay) return replay;
      if (state.doc.archived) refuse('forbidden', 'team_chat_archived');
      const found = this._find(state, input.messageId);
      if (!found) refuse('forbidden', 'team_chat_not_found');
      // Already deleted: its tombstone's revision, flagged so nothing is announced twice.
      if (found.message.deleted !== null) {
        return { ok: true, rev: found.message.rev, replayed: false, already_deleted: true, pruned: [] };
      }
      const old = found.message;
      return this._rewrite(state, key, digest, found, (rev) => ({
        ...old, text: '', edits: [], reactions: {}, attachments: [], refs: [], pinned: null,
        deleted: { by: key.actorId, at: iso(this._clock()) }, rev,
      }), (pins) => pins.filter((messageId) => messageId !== old.id));
    }));
  }

  // Rewrites the one segment holding a message, then channel.json.
  _rewrite(state, key, digest, found, change, pinsAfter = (pins) => pins) {
    const channelId = state.doc.channel_id;
    const n = found.entry.n;
    let updated = null;
    const build = (rev) => {
      updated = change(rev);
      if (!schema.validateMessage(updated, channelId)) throw corrupt('message_build_invalid');
      return channels.withMessage(found.segment, updated);
    };
    const estimate = bytesOf(build(state.doc.rev + 2));
    if (estimate > HARD) refuse('limit', 'team_chat_storage_limit');
    const pruned = this._makeRoom(state, new Set([n, ...retention.headOnly(state.doc.segments)]), 0,
      estimate - this._meta(state, n).bytes);
    const rev = state.doc.rev + 1;
    const segment = build(rev);
    const bytes = this._files.write(this._file(channelId, `seg-${n}.json`), segment, HARD);
    const metas = state.doc.segments.map((meta) => (meta.n === n ? segmentMeta(n, segment, bytes, meta.newest_at) : meta));
    this._commitChannel(state, {
      ...state.doc, rev, segments: metas, bytes: sumBytes(metas), pins: pinsAfter(state.doc.pins),
      requests: channels.requestsWith(state.doc, key, digest, { rev }, this._clock()),
    });
    if (state.head && state.head.n === n) Object.assign(state, { head: segment, headDirty: false });
    found.entry.rev = rev;
    channels.rememberMentions(state, updated);
    this._sweep(state);
    this._log('INFO', 'team_chat.rewritten', { channel_id: channelId, seq: found.entry.seq, rev });
    return { ok: true, rev, replayed: false, pruned };
  }
}

Object.assign(TeamChatStore.prototype, readStateMethods, readMethods, loaderMethods);

module.exports = { TeamChatStore };
