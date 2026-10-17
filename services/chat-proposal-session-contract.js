'use strict';

/* services/chat-proposal-session-contract.js - closed request validators for the checkpoint-5a
 * session-kind methods of the sessionProposals.* bridge (getCapabilities, setOptions, startAll,
 * authorizeLaunch) and the capabilities response builder. Pure: no I/O, no logging. Unknown
 * keys, malformed ids and out-of-range numbers fail closed with `invalid_request`; nothing here
 * reads title, description, task or background text.
 */

const {
  INVALID, envelopeOk, hasExactKeys, isPlainObject, validDecisionId, validProposalId, validRevision,
} = require('./chat-proposal-contract');
const { GROUP_ID_RE, validOptions } = require('./backend/chat-proposal-session-records');

const MAX_START_ALL_ITEMS = 10;
const MAX_DESTINATIONS = 8;
const MAX_MAX_CHILDREN = 10;
const MAX_LABEL_BYTES = 512;
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHORT_ID_MAX = 256;

const shortString = (value) => typeof value === 'string' && value.length > 0 && value.length <= SHORT_ID_MAX;

function validateCapabilitiesRequest(raw) {
  if (!envelopeOk(raw, ['proposal_id']) || !validProposalId(raw.proposal_id)) return INVALID;
  return { ok: true, value: { session_id: raw.session_id, proposal_id: raw.proposal_id } };
}

function validateSetOptionsRequest(raw) {
  if (!envelopeOk(raw, ['proposal_id', 'expected_revision', 'options']) || !validProposalId(raw.proposal_id)
    || !validRevision(raw.expected_revision) || !isPlainObject(raw.options) || !validOptions(raw.options)) {
    return INVALID;
  }
  return {
    ok: true,
    value: {
      session_id: raw.session_id,
      proposal_id: raw.proposal_id,
      expected_revision: raw.expected_revision,
      options: { ...raw.options },
    },
  };
}

function validateStartAllRequest(raw) {
  if (!envelopeOk(raw, ['group_id', 'decision_id', 'items']) || typeof raw.group_id !== 'string' || !GROUP_ID_RE.test(raw.group_id)
    || !validDecisionId(raw.decision_id) || !Array.isArray(raw.items)
    || raw.items.length < 1 || raw.items.length > MAX_START_ALL_ITEMS) {
    return INVALID;
  }
  const seen = new Set();
  for (const item of raw.items) {
    if (!isPlainObject(item) || !hasExactKeys(item, ['proposal_id', 'expected_revision'])
      || !validProposalId(item.proposal_id) || !validRevision(item.expected_revision) || seen.has(item.proposal_id)) {
      return INVALID;
    }
    seen.add(item.proposal_id);
  }
  return {
    ok: true,
    value: {
      session_id: raw.session_id,
      group_id: raw.group_id,
      decision_id: raw.decision_id,
      items: raw.items.map((item) => ({ proposal_id: item.proposal_id, expected_revision: item.expected_revision })),
    },
  };
}

function validDestinations(list) {
  return Array.isArray(list) && list.length >= 1 && list.length <= MAX_DESTINATIONS
    && list.every((id) => id === null || shortString(id)) && new Set(list).size === list.length;
}

function validateAuthorizeLaunchRequest(raw) {
  const required = ['source_user_message_id', 'expected_session_incarnation', 'max_children', 'destination_project_ids', 'action_id'];
  if (!envelopeOk(raw, required) || typeof raw.source_user_message_id !== 'string' || !MESSAGE_ID_RE.test(raw.source_user_message_id)
    || !shortString(raw.expected_session_incarnation)
    || !Number.isSafeInteger(raw.max_children) || raw.max_children < 1 || raw.max_children > MAX_MAX_CHILDREN
    || !validDestinations(raw.destination_project_ids) || !validDecisionId(raw.action_id)) {
    return INVALID;
  }
  return {
    ok: true,
    value: {
      session_id: raw.session_id,
      source_user_message_id: raw.source_user_message_id,
      expected_session_incarnation: raw.expected_session_incarnation,
      max_children: raw.max_children,
      destination_project_ids: [...raw.destination_project_ids],
      action_id: raw.action_id,
    },
  };
}

// A label is display text from a catalog; never a path. Clipped to MAX_LABEL_BYTES of UTF-8.
function clipLabel(value, fallback = '') {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (Buffer.byteLength(text, 'utf8') <= MAX_LABEL_BYTES) return text;
  let out = '';
  for (const point of text) {
    if (Buffer.byteLength(out + point, 'utf8') > MAX_LABEL_BYTES) break;
    out += point;
  }
  return out;
}

module.exports = {
  MAX_LABEL_BYTES,
  MAX_START_ALL_ITEMS,
  clipLabel,
  validateAuthorizeLaunchRequest,
  validateCapabilitiesRequest,
  validateSetOptionsRequest,
  validateStartAllRequest,
};
