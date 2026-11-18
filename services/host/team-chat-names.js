'use strict';

// Channel names, topics and custom channel ids (row 173, TEAM_CHANNELS_2026-11-16.md "Names and topics"). Pure
// functions: no disk, no clock, no logging. Names and topics are untrusted text: they are checked here, stored
// as normalized, and never logged.
//
//   name   NFC, trimmed, inner runs of white space collapsed to one space, 1 to `max` code points, no C0/C1
//          control characters, no bidi controls, no leading `#`.
//   topic  NFC, trimmed, one line, the same characters, 0 to `max` code points.
//
// A stored name or topic is valid when it is its own normalization, so the schema check and the input check are
// one rule.

// U+202A-U+202E (embeddings and overrides) and U+2066-U+2069 (isolates).
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/u;
const LINE_BREAKS = /[\n\r\u0085\u2028\u2029]/u;
// The id suffix alphabet: lowercase RFC 4648 base32.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_BYTES = 10;

const wellFormed = (value) => (typeof value.isWellFormed === 'function' ? value.isWellFormed() : !/\p{Cs}/u.test(value));
const codePoints = (value) => [...value].length;
// The wire bound: four UTF-16 units per allowed code point leaves room for white space that trimming and
// collapsing take away; a longer string is refused unread.
const bounded = (value, max) => typeof value === 'string' && value.length <= max * 4 && wellFormed(value);
const hasForbidden = (value) => /\p{Cc}/u.test(value) || BIDI_CONTROLS.test(value);

// The normalized name, or null when the value breaks the rule.
function normalizeName(value, max) {
  if (!bounded(value, max)) return null;
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (name.length === 0 || codePoints(name) > max || hasForbidden(name) || name.startsWith('#')) return null;
  return name;
}

// The normalized topic ('' allowed), or null when the value breaks the rule.
function normalizeTopic(value, max) {
  if (!bounded(value, max)) return null;
  const topic = value.normalize('NFC').trim();
  if (LINE_BREAKS.test(topic) || hasForbidden(topic) || codePoints(topic) > max) return null;
  return topic;
}

const isStoredName = (value, max) => typeof value === 'string' && normalizeName(value, max) === value;
const isStoredTopic = (value, max) => typeof value === 'string' && normalizeTopic(value, max) === value;

// The uniqueness key of a name: names compare after toLowerCase().
const nameKey = (name) => name.toLowerCase();

function base32(bytes) {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

// A custom channel id from 10 random bytes: `chan_c_` plus 16 base32 characters.
function newCustomChannelId(randomBytes) {
  const bytes = randomBytes(ID_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== ID_BYTES) throw new TypeError('randomBytes must return 10 bytes.');
  return `chan_c_${base32(bytes)}`;
}

module.exports = { isStoredName, isStoredTopic, nameKey, newCustomChannelId, normalizeName, normalizeTopic };
