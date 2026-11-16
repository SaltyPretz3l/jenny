'use strict';

// Members, presence and typing for the desktop chat client (slice 2a-4c). Pure
// checks and small bounded state; no I/O, no logging.
//
// - checkedMembers: the overview's `members`, each rebuilt from checked fields
//   (the member id check, the host's display-name rule and bound, the host's
//   closed role and presence lists, a timestamp or null), no other key, no
//   member twice, at most the team's live member limit. Any failure answers null.
// - checkedPresence / checkedTyping: the `team_presence` and `team_chat_typing`
//   events rebuilt from their checked fields only (never the frame's cursor or
//   boot epoch).
// - checkedRead / checkedReads / isPinCount: the `team_chat_read` event as exactly
//   { channel_id, member_id, seq } (the frame's own envelope keys aside), a channel row's `reads` as at most one
//   position per other member, and a pin count (an integer 0 to the pin limit).
// - createTypingGate: at most one typing send per TYPING_WINDOW_MS per channel
//   and thread; expired keys are pruned on every check and the table never
//   holds more than `max` keys (the cache's channel bound).
// - createPresenceHold: the state the renderer last asked for, sent only on a
//   change, and once again after each reconnect.

const {
  AUTHOR_KINDS, LIMITS: CHAT_LIMITS, channelKind, isCount, isIso, isMemberId, isMessageId, isPositive,
} = require('../host/team-chat-schema');
const {
  LIMITS: MEMBER_LIMITS, ROLES, hasExactKeys, isCleanText, isPlainObject,
} = require('../../server/team/member-schema');

// The team's live member bound (server/team/member-schema.js LIMITS.MAX_LIVE_MEMBERS).
const MEMBERS_MAX = MEMBER_LIMITS.MAX_LIVE_MEMBERS;
// The host's presence states (services/host/team-presence.js) and the states a client may report.
const PRESENCE_STATES = Object.freeze(['online', 'away', 'offline']);
const PRESENCE_REPORTS = Object.freeze(['active', 'idle']);
// The host drops repeats inside 3 s per device; the client sends at most one per 3 s per channel and thread.
const TYPING_WINDOW_MS = 3000;
const MEMBER_KEYS = Object.freeze(['member_id', 'display_name', 'role', 'state', 'last_seen_at']);

const isSeen = (value) => value === null || isIso(value);
const hasExactly = (value, keys) => isPlainObject(value) && hasExactKeys(value, keys);

/** A search match's author: exactly { kind, member_id } of the host's author kinds. */
const isAuthor = (value) => hasExactly(value, ['kind', 'member_id']) && AUTHOR_KINDS.includes(value.kind)
  && isMemberId(value.member_id);

function checkedMember(value) {
  if (!hasExactly(value, MEMBER_KEYS) || !isMemberId(value.member_id) || !isCleanText(value.display_name)
    || !ROLES.includes(value.role) || !PRESENCE_STATES.includes(value.state) || !isSeen(value.last_seen_at)) return null;
  return { member_id: value.member_id, display_name: value.display_name, role: value.role, state: value.state,
    last_seen_at: value.last_seen_at };
}

/** The overview's members as copies of checked fields, or null when the list or any member fails. */
function checkedMembers(list) {
  if (!Array.isArray(list) || list.length > MEMBERS_MAX) return null;
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const member = checkedMember(value);
    if (!member || seen.has(member.member_id)) return null;
    seen.add(member.member_id);
    out.push(member);
  }
  return out;
}

/** A `team_presence` event as { member_id, state, last_seen_at }, or null. */
function checkedPresence(event) {
  if (!isPlainObject(event) || !isMemberId(event.member_id) || !PRESENCE_STATES.includes(event.state)
    || !isSeen(event.last_seen_at)) return null;
  return { member_id: event.member_id, state: event.state, last_seen_at: event.last_seen_at };
}

/** A `team_chat_typing` event as { channel_id, thread_root_id, member_id }, or null. */
function checkedTyping(event) {
  if (!isPlainObject(event) || channelKind(event.channel_id) === null || !isMemberId(event.member_id)
    || (event.thread_root_id !== null && !isMessageId(event.thread_root_id))) return null;
  return { channel_id: event.channel_id, thread_root_id: event.thread_root_id, member_id: event.member_id };
}

// The keys every event frame carries besides its payload (services/team/event-feed.js).
const ENVELOPE_KEYS = Object.freeze(['event_type', 'cursor', 'boot_epoch', 'api_version']);
const READ_KEYS = Object.freeze(['channel_id', 'member_id', 'seq']);

/** A `team_chat_read` event as { channel_id, member_id, seq }, or null (also for any key beyond those three). */
function checkedRead(event) {
  if (!isPlainObject(event)) return null;
  const keys = Object.keys(event).filter((key) => !ENVELOPE_KEYS.includes(key));
  if (keys.length !== READ_KEYS.length || !READ_KEYS.every((key) => keys.includes(key))) return null;
  if (channelKind(event.channel_id) === null || !isMemberId(event.member_id) || !isCount(event.seq)) return null;
  return { channel_id: event.channel_id, member_id: event.member_id, seq: event.seq };
}

const byMemberId = (a, b) => (a.member_id < b.member_id ? -1 : Number(a.member_id > b.member_id));

/** A row's `reads` as copies sorted by member id; [] when absent or when any entry fails (never a partial list). */
function checkedReads(list, selfId) {
  if (!Array.isArray(list) || list.length > MEMBERS_MAX) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!hasExactly(item, ['member_id', 'seq']) || !isMemberId(item.member_id) || !isPositive(item.seq)
      || item.member_id === selfId || seen.has(item.member_id)) return [];
    seen.add(item.member_id);
    out.push({ member_id: item.member_id, seq: item.seq });
  }
  return out.sort(byMemberId);
}

const isPinCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= CHAT_LIMITS.PINS_MAX;

function createTypingGate({ now, max }) {
  // `${channel_id}/${thread_root_id}` -> time of the last send
  const sent = new Map();
  const keyOf = (channelId, rootId) => `${channelId}/${rootId || ''}`;
  return {
    /** True when a typing send for this channel and thread may go now; the send is then recorded. */
    allow(channelId, rootId) {
      const at = now();
      for (const [key, time] of sent) if (at - time >= TYPING_WINDOW_MS || at < time) sent.delete(key);
      const key = keyOf(channelId, rootId);
      if (sent.has(key)) return false;
      if (sent.size >= max) sent.delete(sent.keys().next().value);
      sent.set(key, at);
      return true;
    },
    /** A send that failed does not hold the window. */
    forget(channelId, rootId) { sent.delete(keyOf(channelId, rootId)); },
    clear() { sent.clear(); },
    size: () => sent.size,
  };
}

function createPresenceHold() {
  let held = null;
  let sent = null;
  let owed = false;
  return {
    /** The renderer asks for `state`: true when it must be sent now (online and a change). */
    want(state, online) {
      held = state;
      if (!online || sent === state) return false;
      sent = state;
      return true;
    },
    /** A send of `state` failed: the next ask (or reconnect) sends it again. */
    failed(state) { if (sent === state) sent = null; },
    /** The connection came back: the held state is owed once. */
    reconnected() { sent = null; owed = held !== null; },
    /** The owed state to send now (recorded as sent), or null. */
    take() {
      if (!owed) return null;
      owed = false;
      if (held === null || sent === held) return null;
      sent = held;
      return held;
    },
    clear() { held = null; sent = null; owed = false; },
  };
}

module.exports = {
  MEMBERS_MAX, PRESENCE_REPORTS, PRESENCE_STATES, TYPING_WINDOW_MS, byMemberId, checkedMembers, checkedPresence,
  checkedRead, checkedReads, checkedTyping, createPresenceHold, createTypingGate, isAuthor, isPinCount,
};
