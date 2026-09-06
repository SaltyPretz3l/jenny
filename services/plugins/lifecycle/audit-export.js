'use strict';

// The bounded export path over lifecycle/audit-log.js. Architecture doc line
// ~385 lists "audit export" among the allowlisted `plugins:<verb>` IPC
// surfaces this eventually backs; this module is the pure, IPC-free library
// that surface will call (rule 5: no reference to main/renderer/IPC here).
//
// Export is the surface where an internal leak becomes an external one: an
// audit event that slipped past write-time redaction (a defense-in-depth bug,
// not a normal occurrence -- appendAuditEvent/buildAuditEvent already refuse
// to persist an unredacted leaf) would otherwise ride out through export
// completely unnoticed. So this module independently re-runs the same
// leaf-walk on the way OUT and refuses to produce a document at all if it
// finds one, rather than exporting with a warning: a warning is something a
// human can miss; a refusal is not. Similarly, a sequence gap from retention
// is legal (findSequenceViolation already treats it that way) but a genuine
// regression/repeat must be visible in the exported document's own
// `integrity` field, not just detectable by someone who happens to re-run
// findSequenceViolation over the export later. And silent truncation would
// itself be an audit defect -- an export that quietly drops rows is worse
// than one that is merely small -- so truncation is always reported with an
// exact count.
//
// Returns a structured document, never a string: JSON-vs-other
// serialization, content-type, and transport are the caller's business, not
// this module's.

const { readAuditLog, findSequenceViolation, findUnredactedLeaf } = require('./audit-log');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE, CONTRIBUTION_ID_RE } = require('../identity/authority-id');

const DEFAULT_EXPORT_MAX_ENTRIES = 1000;
const KNOWN_FILTER_KEYS = Object.freeze(new Set(['authority', 'action', 'since', 'until']));
const KNOWN_AUTHORITY_FILTER_KEYS = Object.freeze(new Set(['publisherId', 'pluginId', 'contributionId']));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Rejects a filter carrying any key this module does not know how to apply,
// rather than silently ignoring it -- an ignored filter key would make the
// export APPEAR scoped to a caller who does not read this module's source,
// while actually returning a broader set of events than they asked for.
function validateFilterShape(filter) {
  if (filter === undefined || filter === null) {
    return { ok: true, value: {} };
  }
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    return { ok: false, reason: 'filter_not_object' };
  }
  for (const key of Object.keys(filter)) {
    if (!KNOWN_FILTER_KEYS.has(key)) {
      return { ok: false, reason: 'filter_unknown_key', detail: { key } };
    }
  }
  if (filter.action !== undefined && !isNonEmptyString(filter.action)) {
    return { ok: false, reason: 'filter_action_invalid' };
  }
  if (filter.authority !== undefined) {
    const authority = filter.authority;
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
      return { ok: false, reason: 'filter_authority_invalid' };
    }
    for (const key of Object.keys(authority)) {
      if (!KNOWN_AUTHORITY_FILTER_KEYS.has(key)) {
        return { ok: false, reason: 'filter_authority_unknown_key', detail: { key } };
      }
    }
    if (!PUBLISHER_ID_RE.test(String(authority.publisherId))) {
      return { ok: false, reason: 'filter_authority_invalid' };
    }
    if (!PLUGIN_ID_RE.test(String(authority.pluginId))) {
      return { ok: false, reason: 'filter_authority_invalid' };
    }
    if (authority.contributionId !== undefined && !CONTRIBUTION_ID_RE.test(String(authority.contributionId))) {
      return { ok: false, reason: 'filter_authority_invalid' };
    }
  }
  if (filter.since !== undefined && (!isNonEmptyString(filter.since) || Number.isNaN(Date.parse(filter.since)))) {
    return { ok: false, reason: 'filter_since_invalid' };
  }
  if (filter.until !== undefined && (!isNonEmptyString(filter.until) || Number.isNaN(Date.parse(filter.until)))) {
    return { ok: false, reason: 'filter_until_invalid' };
  }
  return { ok: true, value: filter };
}

function matchesFilter(event, filter) {
  if (filter.action !== undefined && event.action !== filter.action) {
    return false;
  }
  if (filter.authority !== undefined) {
    const subject = event.subject;
    if (!subject) return false;
    if (subject.publisher_id !== filter.authority.publisherId) return false;
    if (subject.plugin_id !== filter.authority.pluginId) return false;
    if (
      filter.authority.contributionId !== undefined &&
      subject.contribution_id !== filter.authority.contributionId
    ) {
      return false;
    }
  }
  if (filter.since !== undefined || filter.until !== undefined) {
    const recordedMs = Date.parse(event.recorded_at);
    // Fail closed: an event whose own timestamp cannot be parsed is excluded
    // rather than included, the moment ANY time-range filter is active.
    if (Number.isNaN(recordedMs)) return false;
    if (filter.since !== undefined && recordedMs < Date.parse(filter.since)) return false;
    if (filter.until !== undefined && recordedMs > Date.parse(filter.until)) return false;
  }
  return true;
}

// Mirrors findSequenceViolation's exact rule (strictly increasing sequence,
// a gap is legal) but additionally reports the index of the first violation,
// since audit-log.js's own export intentionally does not (it is evidence
// plumbing, not a report). findSequenceViolation remains the source of truth
// for the ok/fail decision itself; this only locates WHERE.
function locateSequenceViolationIndex(events) {
  let previous = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].sequence <= previous) return index;
    previous = events[index].sequence;
  }
  return -1;
}

/**
 * @param {object} facade - injected fs facade (store/fs-facade.js)
 * @param {string} baseDir
 * @param {object} params
 * @param {string} [params.now] - ISO-8601 wall-clock reading, recorded as
 *   the export document's `generated_at`; this module never reads a clock.
 * @param {object} [params.filter] - optional bounded filter: any of
 *   {authority:{publisherId,pluginId,contributionId?}, action, since, until}.
 *   An unknown key or a malformed value in a KNOWN key is rejected outright.
 * @param {number} [params.maxEntries] - caps the exported entry count,
 *   keeping the NEWEST entries (dropping the oldest first), mirroring the
 *   ring-buffer retention convention json-file-io.js's appendJsonLine already
 *   uses for the underlying log.
 * @param {function} [params.redact] - injected leaf-redaction check,
 *   `(event) => null|{path,reason}`; defaults to audit-log.js's
 *   findUnredactedLeaf. Injectable so a caller can supply a stricter check
 *   without this module reaching into audit-log.js's internals.
 * @returns {{ok:true,document:object}|{ok:false,reason:string,detail?:object}}
 */
async function exportAuditLog(facade, baseDir, params = {}) {
  const { now = null, filter, maxEntries, redact = findUnredactedLeaf,
    managedPolicy = null, policyMaxEntries = DEFAULT_EXPORT_MAX_ENTRIES } = params;

  const filterCheck = validateFilterShape(filter);
  if (!filterCheck.ok) {
    return { ok: false, reason: filterCheck.reason, detail: filterCheck.detail };
  }

  const requestedMax = Number.isInteger(maxEntries) && maxEntries >= 0
    ? maxEntries : DEFAULT_EXPORT_MAX_ENTRIES;
  const managedMax = Number.isInteger(policyMaxEntries) && policyMaxEntries >= 1
    ? Math.min(policyMaxEntries, DEFAULT_EXPORT_MAX_ENTRIES) : DEFAULT_EXPORT_MAX_ENTRIES;
  const cappedMax = Math.min(requestedMax, managedMax, DEFAULT_EXPORT_MAX_ENTRIES);

  const { events, corruptCount, invalidCount } = await readAuditLog(facade, baseDir);
  const matched = events.filter((event) => matchesFilter(event, filterCheck.value));

  let truncatedCount = 0;
  let exported = matched;
  if (matched.length > cappedMax) {
    truncatedCount = matched.length - cappedMax;
    exported = matched.slice(matched.length - cappedMax);
  }

  // Redaction re-check on the way OUT, over exactly what would actually be
  // emitted. Refuses the whole export rather than emitting a partial or
  // warned document -- the offending PATH is bounded/closed-vocabulary
  // (a dot/bracket-notation field locator, e.g. "detail.reason"), never the
  // leaked value itself, so reporting it here cannot itself leak anything.
  for (let index = 0; index < exported.length; index += 1) {
    const leak = redact(exported[index]);
    if (leak) {
      return {
        ok: false,
        reason: 'unredacted_leaf_present',
        detail: { eventIndex: index, path: leak.path, leakReason: leak.reason },
      };
    }
  }

  const sequenceResult = findSequenceViolation(exported);
  const sequenceViolationIndex = sequenceResult.ok ? -1 : locateSequenceViolationIndex(exported);

  const policySummary = managedPolicy ? Object.freeze({
    status: managedPolicy.status,
    reason: managedPolicy.reason,
    revision: managedPolicy.revision,
    source_revision: managedPolicy.source_revision,
    policy_digest: managedPolicy.policy_digest,
    source_kind: managedPolicy.source_kind,
    source_fingerprint: managedPolicy.source_fingerprint,
    privileged_execution: managedPolicy.privileged_execution,
    update_ring: managedPolicy.update_ring,
  }) : null;
  const policyLeak = policySummary && redact(policySummary);
  if (policyLeak) return { ok: false, reason: 'managed_policy_provenance_unredacted' };

  const document = Object.freeze({
    generated_at: now,
    filter: Object.freeze({ ...filterCheck.value }),
    entries: Object.freeze(exported),
    entry_count: exported.length,
    matched_count: matched.length,
    truncated: truncatedCount > 0,
    truncated_count: truncatedCount,
    integrity: sequenceResult.ok ? 'ok' : 'sequence_violation',
    sequence_violation: sequenceResult.ok
      ? null
      : Object.freeze({ index: sequenceViolationIndex, ...sequenceResult.detail }),
    corrupt_count: corruptCount,
    invalid_count: invalidCount,
    ...(policySummary ? { managed_policy: policySummary } : {}),
  });

  return { ok: true, document };
}

module.exports = {
  DEFAULT_EXPORT_MAX_ENTRIES,
  KNOWN_FILTER_KEYS,
  exportAuditLog,
};
