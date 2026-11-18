'use strict';

// Custom channels and a channel's profile in the team chat store (row 173, TEAM_CHANNELS_2026-11-16.md "Host
// contract"). Methods installed on TeamChatStore.prototype. Pure store logic: the command layer
// (team-chat-channel-ops.js) decides who may act; this module keeps what must hold inside the write chain:
//
//   - name and topic rules (team-chat-names.js), the team-wide unique name across `team` and `channel` kinds
//     (archived ones included, case ignored) and the cap of 32 live custom channels, checked under the same chain
//     that writes, so two concurrent creates of one name make one channel;
//   - the stale and archived checks, a replay receipt per change in the channel's own `requests`, and the change
//     records (at most 10, oldest dropped first);
//   - the audit entry of an archive or unarchive, written before the channel commits (`audited`): a failed audit
//     refuses the change with nothing written.
//
// A create writes channel.json then index.json (`_create`). Names and topics are never logged: logs carry ids,
// revisions and counts.

const { hostFailure } = require('../../server/api-contract');
const schema = require('./team-chat-schema');
const channels = require('./team-chat-channel');
const names = require('./team-chat-names');
const { corrupt, logChannel, refuse } = require('./team-chat-files');

const { LIMITS } = schema;
// The kinds with a name and topic; the others take no profile operation.
const PROFILE_KINDS = new Set(['team', 'channel']);
const TEAM_NAME_KEY = names.nameKey('team');
const ID_ATTEMPTS = 3;

const iso = (ms) => new Date(ms).toISOString();
const withChanges = (doc, added) => [...doc.changes, ...added].slice(-LIMITS.CHANNEL_CHANGES_MAX);

// Runs the injected audit (`audit(name)` answers { ok } or a host failure) before anything is written. Absent, there
// is nothing to audit (the host's own archive); a throw or a malformed answer refuses as unavailable.
function audited(audit, name) {
  if (typeof audit !== 'function') return;
  let written;
  try { written = audit(name); } catch { written = null; }
  if (written?.ok === true) return;
  const failure = written?.ok === false && written.error ? written : hostFailure('unavailable', 'team_unavailable');
  throw Object.assign(new Error('audit_failed'), { refusal: failure });
}

const manageMethods = {
  // A custom channel named by its creator: { ok, channel_id, rev, replayed }. Its first change record is
  // `created` and its revision 1. A retry with the same device and request id answers the channel it made.
  createCustomChannel(input = {}) {
    return this._mutate(() => {
      const key = this._requestKey(input);
      const name = schema.channelName(input.name);
      if (name === null) refuse('invalid', 'team_chat_channel_name_invalid');
      const topic = input.topic === undefined ? '' : schema.channelTopic(input.topic);
      if (topic === null) refuse('invalid', 'team_chat_channel_topic_invalid');
      const digest = channels.digestOf('channel_create', [key.actorId, name, topic]);
      const replay = this._createReplay(key, digest);
      if (replay) return replay;
      this._nameFree(name, null);
      if (this._liveCustomCount() >= LIMITS.CUSTOM_CHANNELS_MAX) refuse('limit', 'team_chat_channel_cap');
      const channelId = this._newChannelId();
      const now = this._clock();
      const made = this._create(channelId, null, (createdAt) => ({
        name, topic, created_by: key.actorId, rev: 1, profile_rev: 1,
        changes: [{ kind: 'created', by: key.actorId, at: createdAt, seq_after: 0 }],
        requests: channels.requestsWith({ requests: [] }, key, digest, { rev: 1 }, now),
      }));
      return { ok: true, channel_id: made.channel_id, rev: made.rev, replayed: false };
    });
  },

  // A new name, a new topic or both on the team channel (topic only) or a custom channel: { ok, rev, changed,
  // replayed }. Values equal to the stored ones change nothing and answer the current revision.
  updateChannel(input = {}) {
    return this._mutate(() => {
      const state = this._channelDoc(input.channelId);
      const key = this._requestKey(input);
      const { doc } = state;
      if (!PROFILE_KINDS.has(doc.kind)) refuse('forbidden', 'team_chat_channel_fixed');
      const name = input.name === undefined ? undefined : schema.channelName(input.name);
      if (name === null) refuse('invalid', 'team_chat_channel_name_invalid');
      const topic = input.topic === undefined ? undefined : schema.channelTopic(input.topic);
      if (topic === null) refuse('invalid', 'team_chat_channel_topic_invalid');
      if ((name === undefined && topic === undefined) || !schema.isCount(input.expectedRev)) {
        refuse('invalid', 'team_chat_request_invalid');
      }
      if (doc.kind === 'team' && name !== undefined) refuse('forbidden', 'team_chat_channel_fixed');
      const digest = channels.digestOf('channel_update', [key.actorId, doc.channel_id, name ?? null, topic ?? null,
        input.expectedRev]);
      const replay = this._replay(state, key, digest);
      if (replay) return replay;
      if (doc.archived) refuse('forbidden', 'team_chat_archived');
      // Stale only when the name, topic or archive changed after the revision the editor saw; messages and marks
      // move `rev` too and must not fail a rename.
      if (input.expectedRev < doc.profile_rev || input.expectedRev > doc.rev) refuse('conflict', 'team_chat_stale');
      const renamed = name !== undefined && name !== doc.name;
      const retopic = topic !== undefined && topic !== doc.topic;
      if (!renamed && !retopic) return { ok: true, rev: doc.rev, changed: false, replayed: false };
      if (renamed) this._nameFree(name, doc.channel_id);
      const stamp = { by: key.actorId, at: iso(this._clock()), seq_after: doc.next_seq - 1 };
      const added = [...(renamed ? [{ kind: 'renamed', ...stamp, from: doc.name, to: name }] : []),
        ...(retopic ? [{ kind: 'topic', ...stamp }] : [])];
      const rev = doc.rev + 1;
      this._commitProfile(state, { ...doc, name: renamed ? name : doc.name, topic: retopic ? topic : doc.topic, rev, profile_rev: rev,
        changes: withChanges(doc, added), requests: channels.requestsWith(doc, key, digest, { rev }, this._clock()) });
      return { ok: true, rev, changed: true, replayed: false };
    });
  },

  // Archive (`on` true, the default) or unarchive: { ok, rev, changed, replayed }. With an actor (the channel
  // operations) only a custom channel, with a replay receipt and the actor recorded; without one the host archives
  // any channel and `by` is null. Archiving an archived channel or unarchiving a live one answers the current
  // revision with `changed: false`. `audit(name)` runs before the commit (the channel operations pass it).
  archiveChannel(input = {}) {
    return this._mutate(() => {
      const state = this._channelDoc(input.channelId);
      const on = input.on === undefined ? true : input.on;
      const key = input.actorId === undefined ? null : this._requestKey(input);
      if (typeof on !== 'boolean' || (key === null && !on)) refuse('invalid', 'team_chat_request_invalid');
      const { doc } = state;
      if (key && doc.kind !== 'channel') refuse('forbidden', 'team_chat_channel_fixed');
      const digest = key ? channels.digestOf('channel_archive', [key.actorId, doc.channel_id, on]) : null;
      const replay = key ? this._replay(state, key, digest) : null;
      if (replay) return replay;
      if ((doc.archived !== null) === on) return { ok: true, rev: doc.rev, changed: false, replayed: false };
      // Unarchiving makes a channel live again, so it counts against the live cap.
      if (!on && doc.kind === 'channel' && this._liveCustomCount() >= LIMITS.CUSTOM_CHANNELS_MAX) refuse('limit', 'team_chat_channel_cap');
      audited(input.audit, doc.name);
      const by = key ? key.actorId : null;
      const at = iso(this._clock());
      const rev = doc.rev + 1;
      this._commitProfile(state, { ...doc, archived: on ? { at, by } : null, rev, profile_rev: rev,
        changes: withChanges(doc, [{ kind: on ? 'archived' : 'unarchived', by, at, seq_after: doc.next_seq - 1 }]),
        requests: key ? channels.requestsWith(doc, key, digest, { rev }, this._clock()) : doc.requests });
      return { ok: true, rev, changed: true, replayed: false };
    });
  },

  // A create's receipt lives in the channel it made: every custom channel is asked (at most CHANNELS_MAX).
  _createReplay(key, digest) {
    const now = this._clock();
    for (const state of this._channels.values()) {
      if (state.doc.kind !== 'channel') continue;
      const entry = channels.findRequest(state.doc, key, now);
      if (!entry) continue;
      if (entry.digest !== digest) refuse('conflict', 'request_payload_changed');
      return { ok: true, channel_id: state.doc.channel_id, rev: entry.result.rev, replayed: true };
    }
    return null;
  },

  // Refuses a name another team or custom channel holds, archived ones included, case ignored. `team` is the team
  // channel's even before that channel exists.
  _nameFree(name, exceptId) {
    const wanted = names.nameKey(name);
    if (wanted === TEAM_NAME_KEY && exceptId !== 'chan_team') refuse('invalid', 'team_chat_channel_name_taken');
    for (const state of this._channels.values()) {
      const { doc } = state;
      if (doc.channel_id !== exceptId && PROFILE_KINDS.has(doc.kind) && typeof doc.name === 'string'
        && names.nameKey(doc.name) === wanted) refuse('invalid', 'team_chat_channel_name_taken');
    }
  },

  _liveCustomCount() {
    let live = 0;
    for (const state of this._channels.values()) if (state.doc.kind === 'channel' && state.doc.archived === null) live += 1;
    return live;
  },

  // Draws again on a collision; repeated collisions are refused, never latched.
  _newChannelId() {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      const channelId = names.newCustomChannelId(this._randomBytes);
      if (!this._channels.has(channelId)) return channelId;
    }
    this._log('WARN', 'team_chat.id_collision', { kind: 'channel' });
    return refuse('persistence', 'team_chat_store_failed');
  },

  _commitProfile(state, nextDoc) {
    if (channels.bytesOf(nextDoc) > LIMITS.CHANNEL_MAX_BYTES) refuse('limit', 'team_chat_storage_limit');
    if (!schema.validateChannelDoc(nextDoc, nextDoc.channel_id).ok) throw corrupt('channel_build_invalid');
    this._commitChannel(state, nextDoc);
    this._log('INFO', 'team_chat.channel_changed', { channel_id: logChannel(nextDoc.channel_id), rev: nextDoc.rev });
  },
};

module.exports = { audited, manageMethods };
