'use strict';

// Team chat read state (row 123 slice 2a-1): <channel>/read.json, one entry
// per member with last_read_seq, notify level and followed threads. Methods
// installed on TeamChatStore.prototype; they use only the channel document
// (no segment load) except `follow` and `markRead`, which read the loaded index
// (E59: a thread's own mark, team-chat-thread-marks.js). The store
// does not authorize: any well-formed member id is accepted, so the command
// layer (slice 2a-3) passes only authorized members.

const schema = require('./team-chat-schema');
const { clone } = require('./team-chat-channel');
const { corrupt, refuse } = require('./team-chat-files');
const marks = require('./team-chat-thread-marks');

const READ_FILE = 'read.json';
const { LIMITS, READ_SCHEMA_VERSION } = schema;

function member(actorId) {
  if (!schema.isMemberId(actorId)) refuse('invalid', 'team_chat_request_invalid');
  return actorId;
}

// Unread position after a mark: raised to at most the last seq, or with
// `unread` lowered to just before `seq` ("mark unread from here"). Null when
// the position would not move in the asked direction.
function nextReadSeq(current, { seq, unread }, lastSeq) {
  const target = unread ? Math.max(0, Math.min(seq, lastSeq + 1) - 1) : Math.min(seq, lastSeq);
  const moves = unread ? target < current : target > current;
  return moves ? target : null;
}

// An explicit follow or unfollow, newest last, within the bound; pruned roots drop out. Unfollowing drops the
// thread's mark; following keeps a stored one, else starts at the channel mark as it stands.
function followedWith(state, entry, rootId, on) {
  const held = entry.followed.find((item) => item.root_id === rootId);
  const followed = entry.followed.filter((item) => item.root_id !== rootId && state.byId.has(item.root_id));
  const mark = held && Number.isSafeInteger(held.read_seq) ? held.read_seq : entry.last_read_seq;
  followed.push({ root_id: rootId, on, read_seq: on ? mark : null });
  return marks.boundFollowed(state, followed);
}

const invalid = () => refuse('invalid', 'team_chat_request_invalid');

const readStateMethods = {
  // read.json, read and validated once; a corrupt one breaks only its channel.
  _readDoc(state) {
    if (state.read === undefined) {
      const id = state.doc.channel_id;
      let doc;
      try {
        doc = this._files.read(this._file(id, READ_FILE), LIMITS.READ_MAX_BYTES)
          || { schema_version: READ_SCHEMA_VERSION, channel_id: id, members: [] };
        const result = schema.validateReadDoc(doc, id);
        if (!result.ok) throw corrupt(result.reason, result.schema);
        doc = schema.currentReadDoc(doc);
      } catch (error) {
        if (error?.brokenReason) error.channelId = id;
        throw error;
      }
      state.read = doc;
    }
    return state.read;
  },

  _readEntry(state, memberId) {
    const found = this._readDoc(state).members.find((entry) => entry.member_id === memberId);
    return found ? clone(found) : {
      member_id: memberId, last_read_seq: 0, notify: schema.defaultNotify(state.doc.kind), followed: [], updated_at: 0,
    };
  },

  // Writes read.json with `entry` replaced and stamped; when it is full the
  // least recently updated other member's entry is dropped.
  _commitRead(state, entry) {
    const others = this._readDoc(state).members.filter((item) => item.member_id !== entry.member_id)
      .sort((a, b) => a.updated_at - b.updated_at);
    const room = LIMITS.MEMBERS_MAX - 1;
    const doc = { schema_version: READ_SCHEMA_VERSION, channel_id: state.doc.channel_id,
      members: [...others.slice(Math.max(0, others.length - room)), { ...entry, updated_at: this._clock() }] };
    this._files.write(this._file(state.doc.channel_id, READ_FILE), doc, LIMITS.READ_MAX_BYTES);
    state.read = doc;
  },

  // Raises last_read_seq, never past the last seq; `unread` lowers it. `changed` says whether it moved,
  // decided inside the write chain. Followed threads tracking the channel mark are pinned as it moves (E59), so a
  // mark that moves waits for the channel's load (implicit followers hold no item, so an empty follow list does
  // not tell); a mark that does not move answers from the channel document alone. With `threadRootId` the
  // thread's own mark is raised instead (team-chat-thread-marks.js).
  markRead(input = {}) {
    const run = () => this._mutate(() => {
      const docState = this._channelDoc(input.channelId);
      const entry = this._readEntry(docState, member(input.actorId));
      if (!schema.isCount(input.seq) || (input.unread !== undefined && typeof input.unread !== 'boolean')) invalid();
      if (input.threadRootId !== undefined) return this._markThread(this._channel(input.channelId), entry, input);
      const target = nextReadSeq(entry.last_read_seq, input, docState.doc.next_seq - 1);
      if (target === null) return { ok: true, last_read_seq: entry.last_read_seq, changed: false };
      const state = this._channel(input.channelId);
      const followed = marks.followedAfterChannelMark(state, entry, entry.last_read_seq, target);
      this._commitRead(state, { ...entry, last_read_seq: target, followed });
      return { ok: true, last_read_seq: target, changed: true };
    });
    return input.threadRootId === undefined && this._markStays(input) ? run() : this._afterLoad(input.channelId, run);
  },

  // Whether `markRead(input)` waits for the channel's load before it writes (the command layer loads first and
  // checks the caller again after it: review round two, R07-F04).
  markReadLoads(input = {}) {
    return input.threadRootId !== undefined || !this._markStays(input);
  },

  // Whether a channel mark would not move, read before the write chain (the chain decides again and loads the
  // channel itself in the rare case it now moves). Any doubt, or a mutation queued behind a load, says no, and the
  // loaded path answers in order.
  _markStays(input) {
    if (this._tails.has(input.channelId)) return false;
    try {
      const state = this._channelDoc(input.channelId);
      const entry = this._readEntry(state, input.actorId);
      return schema.isCount(input.seq) && nextReadSeq(entry.last_read_seq, input, state.doc.next_seq - 1) === null;
    } catch (_error) {
      return false;
    }
  },

  // A thread's own mark: the root must be a root of this channel; `unread` is refused; a thread the member does
  // not follow answers ok and stores nothing. Raised only, never past the thread's newest reply; the channel mark
  // never moves. A mark whose replies are all read and under the channel mark is stored as null again.
  _markThread(state, entry, input) {
    if (input.unread !== undefined) invalid();
    const root = schema.isMessageId(input.threadRootId) ? state.byId.get(input.threadRootId) : undefined;
    if (!root || root.root !== null) refuse('forbidden', 'team_chat_not_found');
    const found = state.threads.has(root.id) ? null : this._find(state, root.id);
    const members = marks.implicitMembers(state, root, found ? found.message : null);
    const current = marks.threadMarkOf(entry, root.id, members);
    const unchanged = { ok: true, last_read_seq: entry.last_read_seq, thread_read_seq: current, changed: false };
    if (!marks.followsFor(entry.member_id, entry.followed)(root.id, members)) return { ...unchanged, thread_read_seq: null };
    const last = marks.lastReplyOf(state, root.id);
    const target = Math.min(input.seq, last);
    if (target <= current) return unchanged;
    const stored = target >= last && last <= entry.last_read_seq ? null : target;
    const followed = marks.boundFollowed(state, marks.withMark(entry.followed.filter((item) => state.byId.has(item.root_id)),
      root.id, stored));
    this._commitRead(state, { ...entry, followed });
    return { ...unchanged, thread_read_seq: target, changed: true };
  },

  setNotify(input = {}) {
    return this._mutate(() => {
      const state = this._channelDoc(input.channelId);
      const entry = this._readEntry(state, member(input.actorId));
      if (!schema.NOTIFY_LEVELS.includes(input.level)) refuse('invalid', 'team_chat_request_invalid');
      if (entry.notify !== input.level) this._commitRead(state, { ...entry, notify: input.level });
      return { ok: true, level: input.level };
    });
  },

  // A reply id resolves to its root; an unchanged follow writes nothing.
  follow(input = {}) {
    return this._afterLoad(input.channelId, () => this._mutate(() => {
      const state = this._channel(input.channelId);
      const entry = this._readEntry(state, member(input.actorId));
      if (typeof input.on !== 'boolean') refuse('invalid', 'team_chat_request_invalid');
      const rootId = this._rootEntry(state, input.rootId).id;
      const current = entry.followed.find((item) => item.root_id === rootId);
      if (!current || current.on !== input.on) {
        this._commitRead(state, { ...entry, followed: followedWith(state, entry, rootId, input.on) });
      }
      return { ok: true, root_id: rootId, on: input.on };
    }));
  },

  readState(channelId, memberId) {
    return this._readOp(() => {
      const state = this._channelDoc(channelId);
      const entry = this._readEntry(state, member(memberId));
      return { ok: true, member_id: entry.member_id, last_read_seq: entry.last_read_seq, notify: entry.notify,
        followed: entry.followed };
    });
  },

  // The members the unread rule counts as following a thread without an explicit entry (its root's author and
  // mentions, and every reply's author and mentions), as the Map (member id -> the seq that made them one)
  // `followsFor` and `markFor` take. A root with no reply has no
  // stats yet: it is seeded from the record, as the first reply would seed it (team-chat-channel.js addMembers).
  threadMembers(channelId, rootId) {
    return this._readOp(() => {
      const state = this._channel(channelId);
      const root = this._rootEntry(state, rootId);
      const found = state.threads.has(root.id) ? null : this._find(state, root.id);
      return { ok: true, members: new Map(marks.implicitMembers(state, root, found ? found.message : null)) };
    });
  },

  // Every member's stored position and nothing else, for the overview's "seen by": the cached read document,
  // no copy of an entry (a follow list can hold 200 items).
  readPositions(channelId) {
    return this._readOp(() => ({ ok: true, positions: this._readDoc(this._channelDoc(channelId)).members
      .map((entry) => ({ member_id: entry.member_id, last_read_seq: entry.last_read_seq })) }));
  },

  readStates(channelId) {
    return this._readOp(() => ({ ok: true, members: clone(this._readDoc(this._channelDoc(channelId)).members) }));
  },
};

module.exports = { READ_FILE, followedWith, nextReadSeq, readStateMethods };
