'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');

function schemasMatch(binding) {
  return (binding?.tools || []).every((tool) => (
    crypto.createHash('sha256').update(tool.schema_json, 'utf8').digest('hex')
      === tool.schema_digest
  ));
}

function compileNativeMcpContributions(candidates = [], authority = {}) {
  const accepted = [];
  const rejected = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const checked = validate('PluginNativeMcpBindingV6', candidate);
    const mismatch = checked.ok && (checked.value.active_generation_id !== authority.active_generation_id
      || checked.value.commit_epoch !== authority.commit_epoch);
    const schemaMismatch = checked.ok && !schemasMatch(checked.value);
    if (!checked.ok || mismatch || schemaMismatch) {
      rejected.push({ contribution_id: candidate?.contribution_id || '', reason: mismatch
        ? 'authority_mismatch' : (schemaMismatch ? 'schema_digest_mismatch' : 'contract_invalid') });
      continue;
    }
    accepted.push(Object.freeze(checked.value));
  }
  accepted.sort((a, b) => Buffer.compare(Buffer.from(a.binding_digest), Buffer.from(b.binding_digest)));
  return { accepted, rejected };
}

module.exports = { compileNativeMcpContributions };
