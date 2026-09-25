'use strict';
const { normalizeQuotaState, assertQuotaCoverage, quotaEffects } = require('../session-runtime/quota-state');

// Keep the legacy artifact validator authoritative for every underlying body.
function normalizeQuotaEntry(value, { normalizeEntry, exact, digest, fail }) {
  exact(value, ['body', 'checkpoint_id', 'revision', 'schema_version', 'sha256', 'base_schema_version'], 'runtime_continuation_entry');
  const base = value.base_schema_version;
  if (!Number.isInteger(base) || base < 1 || base > 4) fail('invalid_quota_base_version');
  const { quota_state: quota, ...body } = value.body || {};
  const state = normalizeQuotaState(quota);
  const normalized = normalizeEntry({ schema_version: base, revision: value.revision,
    checkpoint_id: value.checkpoint_id, sha256: digest(body), body });
  const normalizedBody = { ...normalized.body, quota_state: state };
  if (digest(normalizedBody) !== value.sha256) fail('runtime_continuation_digest_mismatch');
  return { ...normalized, schema_version: 5, base_schema_version: base,
    sha256: value.sha256, body: normalizedBody };
}
function prepareQuotaEntry(proposal, body, baseVersion, events, { normalizeEntry, digest }) {
  const state = Object.hasOwn(proposal, 'quota_state') ? normalizeQuotaState(proposal.quota_state) : null;
  const captured = state ? { ...body, quota_state: state } : body;
  const entry = normalizeEntry({ schema_version: state ? 5 : baseVersion,
    ...(state ? { base_schema_version: baseVersion } : {}), revision: 1,
    checkpoint_id: proposal.checkpoint_id, sha256: digest(captured), body: captured });
  if (state) assertQuotaCoverage(state, body.tool_batch.calls, quotaEffects(events));
  return entry;
}
module.exports = { normalizeQuotaEntry, prepareQuotaEntry };
