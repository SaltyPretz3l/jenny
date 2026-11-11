'use strict';

// Team chat read state (row 123 slice 2a-1): <channel>/read.json, one entry
// per member with last_read_seq, notify level and followed threads. Methods
// installed on TeamChatStore.prototype; they use only the channel document
// (no segment load) except `follow`, which resolves a thread root. The store
// does not authorize: any well-formed member id is accepted, so the command
// layer (slice 2a-3) passes only authorized members.

const schema = require('./team-chat-schema');
const { clone } = require('./team-chat-channel');
const { corrupt, refuse } = require('./team-chat-files');

const READ_FILE = 'read.json';
const { LIMITS, SCHEMA_VERSION } = schema;

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

// An explicit follow or unfollow, newest last, at most 200; pruned roots drop out.
function followedWith(state, entry, rootId, on) {
  const followed = entry.followed.filter((item) => item.root_id !== rootId && state.byId.has(item.root_id));
  followed.push({ root_id: rootId, on });
  return followed.slice(-LIMITS.FOLLOWED_MAX);
}

const readStateMethods = {
  // read.json, read and validated once; a corrupt one breaks only its channel.
  _readDoc(state) {
    if (state.read === undefined) {
      const id = state.doc.channel_id;
      let doc;
      try {
        doc = this._files.read(this._file(id, READ_FILE), LIMITS.READ_MAX_BYTES)
          || { schema_version: SCHEMA_VERSION, channel_id: id, members: [] };
        const result = schema.validateReadDoc(doc, id);
        if (!result.ok) throw corrupt(result.reason, result.schema);
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
    const doc = { schema_version: SCHEMA_VERSION, channel_id: state.doc.channel_id,
      members: [...others.slice(Math.max(0, others.length - room)), { ...entry, updated_at: this._clock() }] };
    this._files.write(this._file(state.doc.channel_id, READ_FILE), doc, LIMITS.READ_MAX_BYTES);
    state.read = doc;
  },

  // Raises last_read_seq, never past the last seq; `unread` lowers it.
  markRead(input = {}) {
    return this._mutate(() => {
      const state = this._channelDoc(input.channelId);
      const entry = this._readEntry(state, member(input.actorId));
      if (!schema.isCount(input.seq) || (input.unread !== undefined && typeof input.unread !== 'boolean')) {
        refuse('invalid', 'team_chat_request_invalid');
      }
      const target = nextReadSeq(entry.last_read_seq, input, state.doc.next_seq - 1);
      if (target === null) return { ok: true, last_read_seq: entry.last_read_seq };
      this._commitRead(state, { ...entry, last_read_seq: target });
      return { ok: true, last_read_seq: target };
    });
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

  readStates(channelId) {
    return this._readOp(() => ({ ok: true, members: clone(this._readDoc(this._channelDoc(channelId)).members) }));
  },
};

module.exports = { READ_FILE, followedWith, nextReadSeq, readStateMethods };
