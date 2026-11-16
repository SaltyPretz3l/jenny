'use strict';

// The rule combinators the member-side answer modules share (admin-answers.js, E49; project-answers.js, slice 3-9).
// A rule answers the checked value or BAD; `fields` keeps exactly a spec's keys, each through its rule (a missing
// key is BAD unless its rule is `optional`), and drops every other key. No state.

const { isCount, isPlainObject } = require('../../server/team/member-schema');

const BAD = Symbol('bad');
const is = (test) => (value) => (test(value) ? value : BAD);
const nullable = (rule) => (value) => (value === null ? null : rule(value));
const optional = (rule) => Object.assign((value) => rule(value), { optional: true });
const oneOf = (values) => is((value) => values.includes(value));
const count = is(isCount);
const flag = is((value) => typeof value === 'boolean');

function fields(value, spec) {
  if (!isPlainObject(value)) return BAD;
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      if (rule.optional) continue;
      return BAD;
    }
    const checked = rule(value[key]);
    if (checked === BAD) return BAD;
    out[key] = checked;
  }
  return out;
}

const record = (spec) => (value) => fields(value, spec);

/** At most `max` items, every one through `rule`; one bad item refuses the list. */
function list(rule, max) {
  return (value) => {
    if (!Array.isArray(value) || value.length > max) return BAD;
    const out = [];
    for (const item of value) {
      const checked = rule(item);
      if (checked === BAD) return BAD;
      out.push(checked);
    }
    return out;
  };
}

/** A plain-data copy of `value` through JSON within `maxBytes`, or BAD (a cycle, a BigInt, too large). */
function jsonCopy(maxBytes) {
  return (value) => {
    let encoded;
    try { encoded = JSON.stringify(value); } catch { return BAD; }
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maxBytes) return BAD;
    return JSON.parse(encoded);
  };
}

module.exports = { BAD, count, fields, flag, is, jsonCopy, list, nullable, oneOf, optional, record };
