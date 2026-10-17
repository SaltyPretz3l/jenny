'use strict';

// Chat-workspace capabilities Electron asks the sidecar for at initialize, and
// the closed intersection Electron is willing to act on from the acknowledgment.
// Stage flags advertise only implemented, qualified operations (never the whole
// roadmap): cp4 requests addressed session messages as a context kind; cp5a adds
// the session_handoff context kind and the two session producer tools.
// session_message_receipt is never a wire context kind.

const CHAT_WORKSPACE_VERSION = 1;
const SESSION_MESSAGE_CONTEXT_KIND = 'session_message';
const SESSION_HANDOFF_CONTEXT_KIND = 'session_handoff';
const CAPABILITY_KEYS = Object.freeze(['schema_version', 'producer_tools', 'context_kinds', 'session_messages']);

function freezeCapabilities(value) {
  return Object.freeze({
    schema_version: 1,
    producer_tools: Object.freeze([...value.producer_tools]),
    context_kinds: Object.freeze([...value.context_kinds]),
    session_messages: value.session_messages === true,
  });
}

const EMPTY_CHAT_WORKSPACE_CAPABILITIES = freezeCapabilities({
  producer_tools: [], context_kinds: [], session_messages: false,
});

const REQUESTED_CHAT_WORKSPACE_CAPABILITIES = freezeCapabilities({
  producer_tools: ['propose_session', 'complete_session_handoff'],
  context_kinds: [SESSION_MESSAGE_CONTEXT_KIND, SESSION_HANDOFF_CONTEXT_KIND],
  session_messages: true,
});

function isStringList(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

// The acknowledgment must be the exact closed shape; anything else (an old or
// hosted sidecar, a malformed object) negotiates nothing.
function isClosedCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== CAPABILITY_KEYS.length || !CAPABILITY_KEYS.every(key => keys.includes(key))) return false;
  return value.schema_version === 1 && isStringList(value.producer_tools)
    && isStringList(value.context_kinds) && typeof value.session_messages === 'boolean';
}

// Never trust the ack to be a subset: keep only values Electron requested AND
// the sidecar acknowledged, in the requested order, without duplicates.
function intersectCapabilities(requested, ack) {
  if (!isClosedCapabilities(requested) || !isClosedCapabilities(ack)) return EMPTY_CHAT_WORKSPACE_CAPABILITIES;
  const producerTools = requested.producer_tools.filter((tool, index, list) => list.indexOf(tool) === index
    && ack.producer_tools.includes(tool));
  const contextKinds = requested.context_kinds.filter((kind, index, list) => list.indexOf(kind) === index
    && ack.context_kinds.includes(kind));
  return freezeCapabilities({
    producer_tools: producerTools,
    context_kinds: contextKinds,
    session_messages: requested.session_messages === true && ack.session_messages === true
      && contextKinds.includes(SESSION_MESSAGE_CONTEXT_KIND),
  });
}

module.exports = {
  CHAT_WORKSPACE_VERSION,
  SESSION_MESSAGE_CONTEXT_KIND,
  SESSION_HANDOFF_CONTEXT_KIND,
  EMPTY_CHAT_WORKSPACE_CAPABILITIES,
  REQUESTED_CHAT_WORKSPACE_CAPABILITIES,
  intersectCapabilities,
};
