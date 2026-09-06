'use strict';

// Bounded, redacted audit evidence (PluginAuditEventV1) at `audit.jsonl`.
// "Durable generation commit" step 6: "Finalize the durable operation receipt
// and append bounded journal/audit evidence." Like journal.js, this log is
// evidence, never authority and never idempotency (PLUG-D01, PLUG-D15) -- an
// append failure after a pointer commit is degraded observability, not an
// implicit rollback.
//
// It is a separate file from journal.jsonl because the two have different
// audiences and different retention: the journal is Jenny-internal recovery
// evidence, while the audit log is the user/admin-visible record that Stage 9
// exports. Mixing them would either leak internal recovery detail into an
// export or force the export to filter, and a filter is a redaction decision
// made at read time -- exactly the kind that gets forgotten. Redacting at write
// time means nothing unredacted is ever on disk to leak.
//
// The contract already bounds every field; this module adds the checks a JSON
// schema cannot express: that no field carries a filesystem path or a
// secret-shaped value. `appendAuditEvent` fails closed rather than writing a
// suspect record, because an audit log that silently swallowed a leak is worse
// than one that recorded a rejection.

const { appendJsonLine, readJsonLines } = require('../store/json-file-io');
const { validate } = require('../contracts/generated-plugin-contracts');
const { redactText } = require('./operation-result');

const CONTRACT_NAME = 'PluginAuditEventV1';
const AUDIT_FILE = 'audit.jsonl';
const DEFAULT_MAX_ENTRIES = 1000;

// Walks every string leaf of a candidate event through the same redaction
// predicate used for operation-result guidance. Structural bounds come from the
// contract; this catches a short, well-formed, in-bounds string that happens to
// be `C:\Users\...` or `token: abc`.
function findUnredactedLeaf(value, path = '') {
  if (typeof value === 'string') {
    const verdict = redactText(value, { maxBytes: 200 });
    return verdict.ok ? null : { path: path || '<root>', reason: verdict.reason };
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnredactedLeaf(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = findUnredactedLeaf(value[key], path ? `${path}.${key}` : key);
      if (found) return found;
    }
    return null;
  }
  return null;
}

function buildAuditEvent({
  eventId,
  sequence,
  recordedAt,
  actor,
  action,
  outcome,
  commitEpoch,
  lifecycleEpoch,
  operationId,
  subject,
  detail,
}) {
  const candidate = {
    audit_schema_version: 1,
    event_id: eventId,
    sequence,
    recorded_at: recordedAt,
    actor,
    action,
    outcome,
    commit_epoch: commitEpoch,
    lifecycle_epoch: lifecycleEpoch,
  };
  if (operationId !== undefined) candidate.operation_id = operationId;
  if (subject !== undefined) candidate.subject = subject;
  if (detail !== undefined) candidate.detail = detail;

  const validated = validate(CONTRACT_NAME, candidate);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_audit_event', detail: validated.error };
  }
  const leak = findUnredactedLeaf(validated.value);
  if (leak) {
    return { ok: false, reason: 'audit_event_not_redacted', detail: leak };
  }
  return { ok: true, event: validated.value };
}

// Appends one bounded audit event. Returns a structured result for a domain
// rejection; only a facade-level I/O failure propagates, and callers treat that
// as degraded observability rather than failing an already-committed mutation.
async function appendAuditEvent(facade, baseDir, event, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const validated = validate(CONTRACT_NAME, event);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_audit_event', detail: validated.error };
  }
  const leak = findUnredactedLeaf(validated.value);
  if (leak) {
    return { ok: false, reason: 'audit_event_not_redacted', detail: leak };
  }
  const { entryCount } = await appendJsonLine(facade, baseDir, AUDIT_FILE, validated.value, {
    maxLines: maxEntries,
  });
  return { ok: true, entryCount };
}

// Tolerant read, mirroring journal.js: a torn trailing line is counted, never
// thrown. An entry that no longer validates is counted separately from one that
// failed to parse, so a contract change and a torn write are distinguishable.
async function readAuditLog(facade, baseDir) {
  const { entries, corruptCount } = await readJsonLines(facade, baseDir, AUDIT_FILE);
  const events = [];
  let invalidCount = 0;
  for (const entry of entries) {
    const validated = validate(CONTRACT_NAME, entry);
    if (validated.ok) {
      events.push(validated.value);
    } else {
      invalidCount += 1;
    }
  }
  return { events, corruptCount, invalidCount };
}

// Audit sequence numbers must be strictly increasing within the retained
// window. A gap is legal (retention dropped older entries); a repeat or a
// regression is not, and means two writers raced without the mutation lease.
function findSequenceViolation(events) {
  let previous = -1;
  for (const event of events) {
    if (event.sequence <= previous) {
      return { ok: false, reason: 'audit_sequence_not_monotonic', detail: { previous, received: event.sequence } };
    }
    previous = event.sequence;
  }
  return { ok: true };
}

module.exports = {
  CONTRACT_NAME,
  AUDIT_FILE,
  DEFAULT_MAX_ENTRIES,
  buildAuditEvent,
  appendAuditEvent,
  readAuditLog,
  findSequenceViolation,
  findUnredactedLeaf,
};
