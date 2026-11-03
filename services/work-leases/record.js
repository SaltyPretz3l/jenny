'use strict';
// Work Leases Protocol v1: the ticket record and its forward-compatible reading rules.
// See docs/architecture/WORK_LEASES_PROTOCOL.md. No Electron, backend or renderer imports.

const crypto = require('node:crypto');

const MAX_RESOURCES = 16;
const MAX_TICKET_BYTES = 8 * 1024;
const MAX_LABEL_CHARS = 120;
const MAX_KEY_CHARS = 512;
const MAX_APP_CHARS = 40;
const MAX_PROFILE_CHARS = 64;
const MAX_SESSION_CHARS = 128;
const MAX_PURPOSE_CHARS = 64;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}@(repo|tree:.+)$/u;

// Infrastructure failures (I/O, guard timeout, git resolution, capacity) make the caller proceed
// uncoordinated; only a definite "busy" decision may delay work (principle 2).
class WorkLeaseInfraError extends Error {
  constructor(reason, message, cause) {
    super(message || reason);
    this.name = 'WorkLeaseInfraError';
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function effectiveState(value) {
  return value === 'waiting' ? 'waiting' : 'held'; // unknown state counts as held
}

function effectiveEnforcement(value) {
  return value === 'advisory' ? 'advisory' : 'blocking'; // unknown enforcement counts as blocking
}

function effectiveUnits(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : 'all'; // unknown, 0, negative: exclusive
}

function effectiveCapacity(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null; // unknown or missing: unlimited
}

function effectiveResource(resource) {
  return Object.freeze({
    key: resource.key,
    units: effectiveUnits(resource.units),
    capacity: effectiveCapacity(resource.capacity),
  });
}

function strOrNull(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : null;
}

function normalizeOwner(owner) {
  const host = owner.host;
  return Object.freeze({
    app: strOrNull(owner.app, MAX_APP_CHARS),
    pid: owner.pid,
    pid_start: isFiniteNumber(owner.pid_start) ? owner.pid_start : null,
    host: Object.freeze({
      name: host.name,
      boot: isFiniteNumber(host.boot) ? host.boot : null,
    }),
    profile: strOrNull(owner.profile, MAX_PROFILE_CHARS),
    session: strOrNull(owner.session, MAX_SESSION_CHARS),
    label: strOrNull(owner.label, MAX_LABEL_CHARS),
  });
}

function findCorruption(record) {
  if (!isPlainObject(record)) return 'not an object';
  if (!Number.isSafeInteger(record.v)) return 'v is not an integer';
  if (typeof record.ticket !== 'string' || !record.ticket) return 'ticket id missing';
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) return 'seq is not a positive integer';
  if (typeof record.state !== 'string') return 'state missing';
  if (!Array.isArray(record.resources)) return 'resources is not a list';
  if (record.resources.length > MAX_RESOURCES) return 'too many resources';
  if (!record.resources.every((r) => isPlainObject(r) && typeof r.key === 'string')) {
    return 'resources must be objects with string keys';
  }
  if (!isPlainObject(record.owner) || !Number.isSafeInteger(record.owner.pid)) return 'owner.pid missing';
  if (!isPlainObject(record.owner.host) || typeof record.owner.host.name !== 'string') {
    return 'owner.host.name missing';
  }
  return null;
}

// Returns { ok: true, ticket } with the effective (normalized) values, or { ok: false, reason }.
// Unknown fields are left out of the view; callers never rewrite a foreign file from it.
function parseTicket(input) {
  let record = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_TICKET_BYTES) return { ok: false, reason: 'too_large' };
    try {
      record = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
  }
  const reason = findCorruption(record);
  if (reason) return { ok: false, reason };
  const created = isFiniteNumber(record.created_at) ? record.created_at : null;
  return {
    ok: true,
    ticket: Object.freeze({
      v: record.v,
      ticket: record.ticket,
      seq: record.seq,
      state: effectiveState(record.state),
      enforcement: effectiveEnforcement(record.enforcement),
      resources: Object.freeze(record.resources.map(effectiveResource)),
      owner: normalizeOwner(record.owner),
      purpose: strOrNull(record.purpose, MAX_PURPOSE_CHARS),
      created_at: created,
      granted_at: isFiniteNumber(record.granted_at) ? record.granted_at : null,
      heartbeat_at: isFiniteNumber(record.heartbeat_at) ? record.heartbeat_at : created,
      ttl_s: null,
      paths: null,
      priority: 0,
    }),
  };
}

// Canonical v1 field order; v1 writers write null/null/0 for the reserved fields.
function serializeTicket(ticket) {
  const owner = ticket.owner;
  const record = {
    v: 1,
    ticket: ticket.ticket,
    seq: ticket.seq,
    state: ticket.state,
    enforcement: ticket.enforcement || 'blocking',
    resources: ticket.resources.map((r) => ({ key: r.key, units: r.units, capacity: r.capacity })),
    owner: {
      app: owner.app ?? null,
      pid: owner.pid,
      pid_start: owner.pid_start ?? null,
      host: { name: owner.host.name, boot: owner.host.boot ?? null },
      profile: owner.profile ?? null,
      session: owner.session ?? null,
      label: owner.label ?? null,
    },
    purpose: ticket.purpose ?? null,
    created_at: ticket.created_at ?? null,
    granted_at: ticket.granted_at ?? null,
    heartbeat_at: ticket.heartbeat_at ?? null,
    ttl_s: null,
    paths: null,
    priority: 0,
  };
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_TICKET_BYTES) throw new RangeError('ticket exceeds 8 KiB');
  return text;
}

// A command preview, not a transcript: one line, URL credentials hidden, capped.
function redactLabel(text) {
  // eslint-disable-next-line no-control-regex -- control bytes never belong in a label.
  const oneLine = String(text ?? '').replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim();
  const redacted = oneLine.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/giu, '$1***@');
  return redacted.slice(0, MAX_LABEL_CHARS);
}

// Validates a publish request's takes. Throws TypeError: a malformed request is a caller bug.
function validateRequestResources(resources) {
  if (!Array.isArray(resources) || resources.length < 1 || resources.length > MAX_RESOURCES) {
    throw new TypeError(`resources must be a list of 1-${MAX_RESOURCES} takes`);
  }
  const seen = new Set();
  return resources.map((r) => {
    if (!isPlainObject(r) || typeof r.key !== 'string' || r.key.length > MAX_KEY_CHARS || !KEY_PATTERN.test(r.key)) {
      throw new TypeError('resource key must be kind@repo or kind@tree:<path> (at most 512 characters)');
    }
    if (seen.has(r.key)) throw new TypeError(`duplicate resource ${r.key}`);
    seen.add(r.key);
    if (r.units !== 'all' && !(Number.isSafeInteger(r.units) && r.units >= 1)) {
      throw new TypeError('units must be "all" or an integer >= 1');
    }
    if (r.capacity !== null && r.capacity !== undefined && !(Number.isSafeInteger(r.capacity) && r.capacity >= 1)) {
      throw new TypeError('capacity must be null or an integer >= 1');
    }
    return Object.freeze({ key: r.key, units: r.units, capacity: r.capacity ?? null });
  });
}

// A new waiting ticket for a publish request; the store fills in seq and the times under the guard.
function buildTicketRecord({ resources, owner = {}, purpose = null, pid, pidStart, host }) {
  return {
    v: 1,
    ticket: crypto.randomBytes(8).toString('hex'),
    seq: Number.MAX_SAFE_INTEGER,
    state: 'waiting',
    enforcement: 'blocking',
    resources: validateRequestResources(resources),
    owner: {
      app: String(owner.app || 'jenny').slice(0, MAX_APP_CHARS),
      pid,
      pid_start: pidStart,
      host,
      profile: owner.profile ? String(owner.profile).slice(0, MAX_PROFILE_CHARS) : null,
      session: owner.session ? String(owner.session).slice(0, MAX_SESSION_CHARS) : null,
      label: owner.label ? redactLabel(owner.label) : null,
    },
    purpose: purpose ? String(purpose).slice(0, MAX_PURPOSE_CHARS) : null,
    created_at: 0,
    granted_at: null,
    heartbeat_at: 0,
  };
}

module.exports = {
  buildTicketRecord,
  MAX_RESOURCES,
  MAX_TICKET_BYTES,
  MAX_LABEL_CHARS,
  MAX_KEY_CHARS,
  MAX_APP_CHARS,
  MAX_PROFILE_CHARS,
  MAX_SESSION_CHARS,
  MAX_PURPOSE_CHARS,
  KIND_PATTERN,
  KEY_PATTERN,
  WorkLeaseInfraError,
  effectiveState,
  effectiveEnforcement,
  effectiveUnits,
  effectiveCapacity,
  effectiveResource,
  parseTicket,
  serializeTicket,
  redactLabel,
  validateRequestResources,
};
