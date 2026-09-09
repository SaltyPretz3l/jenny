'use strict';
const STATUSES = new Set(['completed','cancelled','timed_out','output_limit','interrupted','failed']);
function normalizeSandboxResultMetadata(value) {
  const source = value?.execution;
  if (!source || source.backend !== 'docker' || !STATUSES.has(source.status)) return null;
  const result = { backend: 'docker', status: source.status, workspace: 'disposable_copy',
    cleanup_confirmed: source.cleanup_confirmed === true, output_truncated: source.output_truncated === true };
  if (/^[a-f0-9-]{36}$/u.test(source.job_id || '')) result.job_id = source.job_id;
  if (Number.isInteger(source.exit_code) && source.exit_code >= -255 && source.exit_code <= 255) result.exit_code = source.exit_code;
  if (/^[a-z_]{1,100}$/u.test(source.reason || '')) result.reason = source.reason;
  return { execution: result };
}
module.exports = { normalizeSandboxResultMetadata };