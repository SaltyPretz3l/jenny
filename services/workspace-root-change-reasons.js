'use strict';

const TRANSACTION_APPLY_REASON = 'workspace_root_transaction_applied';
const TRANSACTION_ROLLBACK_REASON = 'workspace_root_transaction_rolled_back';

const WORKSPACE_ROOT_CHANGE_REASONS = new Set([
  'workspace_root_updated',
  'workspace_root_cleared',
  'workspace_root_seeded_from_env',
  TRANSACTION_APPLY_REASON,
  TRANSACTION_ROLLBACK_REASON,
]);

function isWorkspaceRootChangeReason(reason) {
  return WORKSPACE_ROOT_CHANGE_REASONS.has(String(reason || '').trim());
}

module.exports = {
  TRANSACTION_APPLY_REASON,
  TRANSACTION_ROLLBACK_REASON,
  isWorkspaceRootChangeReason,
};
