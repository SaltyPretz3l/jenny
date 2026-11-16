'use strict';

// Making room for one request, and the retention sweep (review round two, R07-F01; TEAM_CHAT_SPEC "2c host as
// built", "Review round two fixes"). Methods installed on TeamChatStore.prototype.
//
// The whole plan is made before the first prune and must prove that the request fits: the segment bytes a prune
// frees plus the attachment blobs it frees (credited per segment from the loaded index: a message's blobs go with
// the segment that removes it, an orphaned reply's with its root's). A request no plan fits is refused
// team_chat_storage_limit with nothing removed. Which segments may go:
//   - the target channel's own count and age limits first (the retention rule, room or not);
//   - for the tree limit (a post, an edit, the sweep), the globally oldest removable segment, one at a time;
//   - while an upload is short of attachment bytes or files, only a run of segments that ends in one that frees a
//     blob, oldest such segment first: a text-only segment frees no attachment byte and is never pruned for one
//     unless it precedes that segment in its own channel (pruning is by prefix);
//   - never a head (the target keeps `protectedNs`), never a broken channel, and for an upload never a direct
//     conversation other than the upload's own.
// A prune that could not unlink a blob leaves it a counted stray; the request is then refused after the prunes.

const schema = require('./team-chat-schema');
const { refuse, logChannel } = require('./team-chat-files');
const channels = require('./team-chat-channel');
const { headOnly, planChannelPrune, planSweep, prunedThreads, sumBytes } = require('./team-chat-retention');

const NOTHING_FREED = Object.freeze({ tree: 0, blobBytes: 0, files: 0 });

// What pruning each prefix of a loaded channel frees in attachment blobs: credits[k] for its k oldest segments.
// `heldBy(message id)` answers { bytes, files } of the blobs on disk that message names.
function blobCredits(state, heldBy) {
  const { segments } = state.doc;
  const position = new Map(segments.map((meta, i) => [meta.n, i]));
  const removedAt = new Map();
  const credits = Array.from({ length: segments.length + 1 }, () => ({ bytes: 0, files: 0 }));
  for (const entry of state.entries) {
    const own = position.get(entry.n) + 1;
    const at = entry.root === null ? own : Math.min(own, removedAt.get(entry.root) ?? own);
    removedAt.set(entry.id, at);
    const held = heldBy(entry.id);
    credits[at].bytes += held.bytes;
    credits[at].files += held.files;
  }
  for (let k = 1; k < credits.length; k += 1) {
    credits[k].bytes += credits[k - 1].bytes;
    credits[k].files += credits[k - 1].files;
  }
  return credits;
}

const roomMethods = {
  // Whether the request fits once `freed` is removed: the tree (segments and blobs) and, for an upload, the
  // attachment bytes and files.
  _roomFits(delta, upload, freed = NOTHING_FREED) {
    if (this.totalBytes() - freed.tree + delta > this._limits.treeMaxBytes) return false;
    return upload === null || this._blobRoom(freed, upload);
  },

  _blobRoom(freed, upload) {
    return this._blobs.total() - freed.blobBytes + upload.bytes <= this._limits.attachmentMaxBytes
      && this._blobs.fileCount() - freed.files + 1 <= this._limits.attachmentMaxFiles;
  },

  // Map(channel id -> prefix length) that makes the request fit, or null. `target` null is the sweep.
  _planRoom(target, protectedNs, incoming, delta, upload) {
    const freed = { tree: 0, blobBytes: 0, files: 0 };
    const lanes = new Map();
    const guardOf = (state) => (state === target ? protectedNs : headOnly(state.doc.segments));
    // A channel's place in the plan, loaded and reconciled on first use so its blobs can be credited.
    const lane = (state) => {
      const id = state.doc.channel_id;
      if (!lanes.has(id)) {
        this._loadChannel(state);
        this._blobsReady(state);
        lanes.set(id, { state, cursor: 0, credits: blobCredits(state, (messageId) => this._blobs.heldBy(id, messageId)) });
      }
      return lanes.get(id);
    };
    const take = (entry, to) => {
      const { credits, cursor } = entry;
      const blobBytes = credits[to].bytes - credits[cursor].bytes;
      freed.tree += sumBytes(entry.state.doc.segments.slice(cursor, to)) + blobBytes;
      freed.blobBytes += blobBytes;
      freed.files += credits[to].files - credits[cursor].files;
      entry.cursor = to;
    };
    if (target) {
      const ownOf = () => planChannelPrune({ segments: target.doc.segments, protectedNs, now: this._clock(),
        limits: this._limits, incoming });
      // Planned from metadata, then again on the loaded segments (a load may rewrite a torn head's metadata).
      if (ownOf() > 0) {
        const entry = lane(target);
        const own = ownOf();
        if (own > 0) take(entry, own);
      }
    }
    const states = [...this._channels.values()].filter((state) => !state.broken
      && !(upload && state !== target && schema.channelKind(state.doc.channel_id) === 'dm'));
    while (!this._roomFits(delta, upload, freed)) {
      const blobShort = upload !== null && !this._blobRoom(freed, upload);
      let best = null;
      for (const state of states) {
        // A channel with no attachment frees none: it is not loaded for an upload short of attachment room.
        if (blobShort && !lanes.has(state.doc.channel_id) && !this._blobs.holdsFiles(state.doc.channel_id)) continue;
        const step = blobShort ? this._blobStep(lane(state), guardOf(state)) : treeStep(state, lanes, guardOf(state));
        if (step === null) continue;
        const key = state.doc.segments[step - 1].newest_at;
        if (!best || key < best.key || (key === best.key && state.doc.channel_id < best.state.doc.channel_id)) {
          best = { state, step, key };
        }
      }
      if (!best) return null;
      take(lane(best.state), best.step);
    }
    return new Map([...lanes.values()].filter((entry) => entry.cursor > 0)
      .map((entry) => [entry.state.doc.channel_id, entry.cursor]));
  },

  // The shortest prefix past the lane's cursor that ends in a segment freeing a blob, all of it removable; or null.
  _blobStep(entry, guard) {
    const { segments } = entry.state.doc;
    for (let to = entry.cursor + 1; to <= segments.length; to += 1) {
      if (guard.has(segments[to - 1].n)) return null;
      if (entry.credits[to].files > entry.credits[entry.cursor].files) return to;
    }
    return null;
  },

  // Plans first, then commits every prune the plan names; refuses with nothing removed when no plan fits.
  _makeRoom(state, protectedNs, incoming, delta, upload = null) {
    const plan = this._planRoom(state, protectedNs, incoming, delta, upload);
    if (plan === null) refuse('limit', 'team_chat_storage_limit');
    const reports = [...plan].map(([id, count]) => this._prune(this._channels.get(id), count));
    if (!this._roomFits(delta, upload)) refuse('limit', 'team_chat_storage_limit');
    return reports;
  },

  // Commits the removal of the channel's `count` oldest segments (loading the channel only now), then unlinks
  // them. A whole commit on its own.
  _prune(state, count) {
    this._loadChannel(state);
    const doc = state.doc;
    const removed = doc.segments.slice(0, count);
    const kept = doc.segments.slice(count);
    const floorSeq = removed[removed.length - 1].last_seq + 1;
    const { removedIds, orphanIds } = prunedThreads(state.entries, floorSeq);
    const gone = (messageId) => removedIds.has(messageId) || orphanIds.has(messageId);
    this._commitChannel(state, { ...doc, segments: kept, floor_seq: floorSeq, rev: doc.rev + 1, bytes: sumBytes(kept),
      pins: doc.pins.filter((messageId) => !gone(messageId)) });
    channels.forgetMessages(state, gone);
    this._dropBlobs(state, gone);
    for (const meta of removed) {
      const name = `seg-${meta.n}.json`;
      if (!this._files.remove(this._file(doc.channel_id, name), doc.channel_id)) state.strays.push(name);
    }
    this._files.written = 0;
    const report = {
      channel_id: doc.channel_id, reason: 'pruned', floor_seq: floorSeq, channel_rev: state.doc.rev,
      pin_count: state.doc.pins.length,
      segments_removed: count, messages_removed: removedIds.size, replies_removed: orphanIds.size,
      bytes_removed: sumBytes(removed),
    };
    this._log('INFO', 'team_chat.pruned', { ...report, channel_id: logChannel(report.channel_id) });
    this._pruned.push(report);
    return report;
  },

  // Each channel's count and age limits (head kept), then the tree limit when a plan fits it; nothing for the tree
  // when none does (best effort, never a prune that frees what cannot help).
  applyRetention() {
    return this._afterLoads(() => this._mutate(() => {
      for (const [id, count] of planSweep({ states: [...this._channels.values()], now: this._clock(), limits: this._limits })) {
        this._prune(this._channels.get(id), count);
      }
      const plan = this._planRoom(null, null, 0, 0, null);
      for (const [id, count] of plan ?? []) this._prune(this._channels.get(id), count);
      for (const state of this._channels.values()) if (state.loaded) this._sweep(state);
      return { ok: true, pruned: [...this._pruned] };
    }));
  },
};

// The next oldest segment of a channel for the tree limit, from its metadata (the lane, once planned), or null.
function treeStep(state, lanes, guard) {
  const cursor = lanes.get(state.doc.channel_id)?.cursor ?? 0;
  const meta = state.doc.segments[cursor];
  return meta && !guard.has(meta.n) ? cursor + 1 : null;
}

module.exports = { blobCredits, roomMethods };
