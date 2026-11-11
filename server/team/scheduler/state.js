'use strict';

// The node table and the lease table of the team pool scheduler (row 123, slice
// 4a-1; spec "Lease state table"). Pure: no timers and no I/O; the clock value
// and random bytes are passed in. Every lease state change goes through
// transitionLease, which names the from-state, the to-state and the trigger and
// refuses anything outside LEASE_TRANSITIONS without changing the record.

const crypto = require('node:crypto');

const { isId } = require('../ids');
const { CANCEL_REASONS } = require('./limits');

const LEASE_STATES = Object.freeze(['queued', 'active', 'released', 'failed', 'expired']);
const LEASE_TERMINAL = Object.freeze(new Set(['released', 'failed', 'expired']));

// 'from>to' -> the triggers that may cause it. 'new' is a lease being created.
const LEASE_TRANSITIONS = Object.freeze({
  'new>queued': Object.freeze(['requested']),
  'queued>active': Object.freeze(['node_assigned']),
  'queued>failed': Object.freeze(['queue_timeout', ...CANCEL_REASONS]),
  'active>released': Object.freeze(['settled']),
  'active>failed': Object.freeze(['job_failed', 'node_stopped', ...CANCEL_REASONS]),
  'active>expired': Object.freeze(['node_contact_timeout', 'idle_timeout']),
});

const LEASE_REFUSED = Object.freeze({ ok: false, reason: 'lease_transition_refused' });

function transitionLease(record, from, to, trigger, reason, now) {
  const actual = record.state === undefined ? 'new' : record.state;
  const allowed = LEASE_TRANSITIONS[`${from}>${to}`];
  if (actual !== from || !allowed || !allowed.includes(trigger)) return LEASE_REFUSED;
  record.state = to;
  record.reason = reason === undefined ? null : reason;
  if (to === 'queued') record.queued_at = now;
  if (to === 'active') record.active_at = now;
  if (LEASE_TERMINAL.has(to)) record.terminal_at = now;
  return { ok: true, transition: { table: 'lease', from, to, trigger, reason: record.reason } };
}

// ---------------------------------------------------------------------------
// Validation and ids shared by the tables.

const PRINTABLE = /^[\x21-\x7e][\x20-\x7e]*$/u;

function isPrintable(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && PRINTABLE.test(value);
}

function newId(prefix, randomBytes) {
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw new TypeError('randomBytes must return the bytes asked for.');
  return `${prefix}${bytes.toString('base64url')}`;
}

// Returns normalized model entries, or null when the list is not acceptable.
function normalizeModels(models, limits) {
  if (!Array.isArray(models) || models.length > limits.maxModelsPerNode) return null;
  const seen = new Set();
  const out = [];
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') return null;
    const { id, context_length: contextLength, vision, thinking } = entry;
    if (!isPrintable(id, limits.maxModelIdLength) || seen.has(id)) return null;
    if (contextLength !== null && !(Number.isSafeInteger(contextLength) && contextLength > 0)) return null;
    if (typeof vision !== 'boolean' || typeof thinking !== 'boolean') return null;
    seen.add(id);
    out.push(Object.freeze({ id, context_length: contextLength, vision, thinking }));
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Node table. Bounded at limits.maxNodes nodes, limits.maxNodesPerMember a
// member, from limits.maxMembers members.

function createNodeTable({ limits, randomBytes }) {
  const nodes = new Map(); // node_id -> record
  let order = 0;

  // The one mutator for node records.
  function setNodeFields(node, fields) {
    Object.assign(node, fields);
  }

  function byDevice(deviceId) {
    for (const node of nodes.values()) if (node.device_id === deviceId) return node;
    return null;
  }

  // Decides a registration without changing anything: { ok, existing, models } or { ok: false, kind, reason }.
  function planRegister({ deviceId, memberId, slots, models }) {
    if (!isId('device', deviceId) || !isId('member', memberId)) return { ok: false, kind: 'invalid', reason: 'node_protocol_invalid' };
    if (!Number.isSafeInteger(slots) || slots < 1 || slots > limits.maxSlots) {
      return { ok: false, kind: 'limit', reason: 'node_slots_exceeded' };
    }
    const normalized = normalizeModels(models, limits);
    if (!normalized) return { ok: false, kind: 'invalid', reason: 'node_protocol_invalid' };
    const existing = byDevice(deviceId);
    if (existing && existing.member_id !== memberId) return { ok: false, kind: 'forbidden', reason: 'node_not_found' };
    if (!existing) {
      const all = [...nodes.values()];
      const members = new Set(all.map((node) => node.member_id));
      const own = all.filter((node) => node.member_id === memberId).length;
      if (nodes.size >= limits.maxNodes || own >= limits.maxNodesPerMember
        || (!members.has(memberId) && members.size >= limits.maxMembers)) {
        return { ok: false, kind: 'limit', reason: 'node_limit_reached' };
      }
    }
    return { ok: true, existing, models: normalized };
  }

  function applyRegister(plan, { deviceId, memberId, slots }, now) {
    if (plan.existing) {
      setNodeFields(plan.existing, { slots, models: plan.models, online: true, offline_at: null, last_contact_at: now });
      return plan.existing;
    }
    const node = {
      node_id: newId('node_', randomBytes), device_id: deviceId, member_id: memberId, slots, models: plan.models,
      online: true, offline_at: null, paused: false, last_contact_at: now, last_served_at: 0, order: order++,
      claims: new Map(),
    };
    nodes.set(node.node_id, node);
    return node;
  }

  return {
    get: (nodeId) => (typeof nodeId === 'string' ? nodes.get(nodeId) || null : null),
    all: () => [...nodes.values()],
    byDevice,
    planRegister,
    applyRegister,
    remove: (nodeId) => nodes.delete(nodeId),
    setNodeFields,
  };
}

function nodeView(node, busySlots) {
  return {
    node_id: node.node_id, device_id: node.device_id, member_id: node.member_id, online: node.online,
    paused: node.paused, slots: node.slots, busy_slots: busySlots, last_served_at: node.last_served_at,
    order: node.order, models: node.models.map((entry) => ({ ...entry })),
  };
}

// ---------------------------------------------------------------------------
// Lease table. Queued leases are bounded by limits.maxQueued (checked by the
// facade before creation), active leases by the online slots, and terminal ones
// by limits.maxTerminalLeases and limits.terminalKeepMs.

const TOKEN_BYTES = 32;
const TOKEN_CHARS = Math.ceil((TOKEN_BYTES * 8) / 6); // unpadded base64url
const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_CHARS}}$`, 'u');

function tokenHex(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function createLeaseTable({ limits, randomBytes }) {
  const leases = new Map(); // lease_id -> record
  // Keyed by the SHA-256 of the token, so neither map holds a token. A lookup
  // compares digests, never the token itself.
  const activeTokens = new Map(); // token digest -> lease_id, only while the lease is active
  const revokedTokens = new Map(); // token digest -> lease_id, while the terminal lease is kept
  let seq = 0;

  function create({ conversationKey, memberId, model, wantsVision }, now) {
    const record = {
      lease_id: newId('lease_', randomBytes), conversation_key: conversationKey, member_id: memberId, model,
      wants_vision: wantsVision, state: undefined, reason: null, node_id: null, model_info: null, seq: seq++,
      created_at: now, queued_at: null, active_at: null, terminal_at: null, last_job_at: null, job_count: 0,
      live_job_id: null, token_hex: null, token_plain: null,
    };
    const result = transitionLease(record, 'new', 'queued', 'requested', null, now);
    leases.set(record.lease_id, record);
    return { record, transition: result.transition };
  }

  function mintToken() {
    const bytes = randomBytes(TOKEN_BYTES);
    if (!Buffer.isBuffer(bytes) || bytes.length !== TOKEN_BYTES) throw new TypeError('randomBytes must return the bytes asked for.');
    const plain = bytes.toString('base64url');
    return { plain, hex: tokenHex(plain) };
  }

  // The lease table's one transition function: the record change plus the token
  // index. Entering active mints the token (before anything changes, so a mint
  // that throws changes nothing); leaving active revokes it.
  function transition(record, from, to, trigger, reason, now) {
    const token = to === 'active' ? mintToken() : null;
    const result = transitionLease(record, from, to, trigger, reason, now);
    if (!result.ok) return result;
    if (token) {
      Object.assign(record, { token_hex: token.hex, token_plain: token.plain });
      activeTokens.set(token.hex, record.lease_id);
    } else if (from === 'active' && record.token_hex) {
      activeTokens.delete(record.token_hex);
      revokedTokens.set(record.token_hex, record.lease_id);
      record.token_plain = null;
    }
    if (LEASE_TERMINAL.has(to)) trimTerminal();
    return result;
  }

  function drop(record) {
    leases.delete(record.lease_id);
    if (record.token_hex) {
      activeTokens.delete(record.token_hex);
      revokedTokens.delete(record.token_hex);
    }
  }

  function trimTerminal() {
    const terminal = [...leases.values()].filter((lease) => LEASE_TERMINAL.has(lease.state));
    terminal.sort((a, b) => a.terminal_at - b.terminal_at || a.seq - b.seq);
    for (let i = 0; i < terminal.length - limits.maxTerminalLeases; i += 1) drop(terminal[i]);
  }

  function purge(now) {
    for (const lease of [...leases.values()]) {
      if (LEASE_TERMINAL.has(lease.state) && now - lease.terminal_at >= limits.terminalKeepMs) drop(lease);
    }
  }

  // Hands the token out once, while the lease is active.
  function takeToken(record) {
    if (record.state !== 'active' || record.token_plain === null) return null;
    const plain = record.token_plain;
    record.token_plain = null;
    return plain;
  }

  // { status: 'active', record } | { status: 'inactive' } | null. A malformed
  // token returns before hashing: its format is public, so the time saved tells
  // a caller nothing it did not send.
  function resolveToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const hex = tokenHex(token);
    const active = leases.get(activeTokens.get(hex));
    if (active && active.state === 'active') return { status: 'active', record: active };
    return revokedTokens.has(hex) ? { status: 'inactive' } : null;
  }

  return {
    get: (leaseId) => (typeof leaseId === 'string' ? leases.get(leaseId) || null : null),
    all: () => [...leases.values()],
    create,
    transition,
    purge,
    takeToken,
    resolveToken,
  };
}

// The lease as callers see it. No token or token digest, ever.
function leaseView(record, position) {
  return {
    lease_id: record.lease_id, conversation_key: record.conversation_key, member_id: record.member_id,
    model: record.model, wants_vision: record.wants_vision, state: record.state, reason: record.reason,
    node_id: record.node_id, model_info: record.model_info ? { ...record.model_info } : null,
    position: record.state === 'queued' ? position : null, created_at: record.created_at,
    active_at: record.active_at, terminal_at: record.terminal_at,
  };
}

module.exports = {
  LEASE_STATES, LEASE_TERMINAL, LEASE_TRANSITIONS, createLeaseTable, createNodeTable, isPrintable, leaseView,
  newId, nodeView, transitionLease,
};
