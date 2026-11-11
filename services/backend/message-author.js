'use strict';

/**
 * The one definition of a message author (team slice 3-5, schema 27).
 *
 * A team host stamps the member who wrote a user message as
 * `author: { kind: 'member', member_id }`, exactly those two keys. Assistant,
 * tool, system and context rows never carry an author, and no display name is
 * stored. The value comes only from the host's authenticated actor through a
 * trusted options argument (see `application-service.js`), never from a
 * payload, so every write re-applies this rule and drops anything else.
 *
 * `services/` must not import `server/team/`, so the member id pattern is a
 * copy of `ID_PATTERNS.member` in `server/team/ids.js`; a test pins the two.
 */

const MEMBER_ID_PATTERN = /^member_[A-Za-z0-9_-]{1,64}$/u;

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A valid author as a fresh `{ kind, member_id }`, or null for anything else. */
function normalizeMessageAuthor(value) {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || value.kind !== 'member' || !Object.hasOwn(value, 'member_id')) return null;
  const memberId = value.member_id;
  if (typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId)) return null;
  return { kind: 'member', member_id: memberId };
}

/** The author for a host actor's member id, or null when the id is not a valid member id. */
function memberAuthor(memberId) {
  return normalizeMessageAuthor({ kind: 'member', member_id: memberId });
}

/** The author a user row may keep: null on every other role. */
function messageAuthorFor(role, value) {
  return role === 'user' ? normalizeMessageAuthor(value) : null;
}

/**
 * Apply the rule to one stored message. A message without an `author` key is
 * returned as is (old messages gain nothing); a valid author on a user row is
 * kept in place; anything else is removed.
 */
function applyMessageAuthorRule(message) {
  if (!isPlainRecord(message) || !Object.hasOwn(message, 'author')) return message;
  const author = messageAuthorFor(message.role, message.author);
  if (author) return { ...message, author };
  const { author: _dropped, ...rest } = message;
  return rest;
}

// v27 adds the optional user-message `author`; the step keeps only a valid one.
function repairSessionForV27(session = {}) {
  const source = isPlainRecord(session) ? session : {};
  if (!Array.isArray(source.messages)) return { ...source };
  return { ...source, messages: source.messages.map(applyMessageAuthorRule) };
}

module.exports = {
  MEMBER_ID_PATTERN,
  memberAuthor,
  messageAuthorFor,
  normalizeMessageAuthor,
  repairSessionForV27,
};
