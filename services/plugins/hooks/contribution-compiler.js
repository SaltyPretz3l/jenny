'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');

function compileHookContributions(candidates = [], authority = {}) {
  const accepted = [];
  const rejected = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const checked = validate('PluginHookDescriptorV6', candidate);
    const mismatch = checked.ok && (checked.value.active_generation_id !== authority.active_generation_id
      || checked.value.commit_epoch !== authority.commit_epoch);
    if (!checked.ok || mismatch) rejected.push({ contribution_id: candidate?.contribution_id || '', reason: mismatch ? 'authority_mismatch' : 'contract_invalid' });
    else accepted.push(Object.freeze(checked.value));
  }
  accepted.sort((a, b) => Buffer.compare(Buffer.from(a.binding_digest), Buffer.from(b.binding_digest)));
  return { accepted, rejected };
}

module.exports = { compileHookContributions };
