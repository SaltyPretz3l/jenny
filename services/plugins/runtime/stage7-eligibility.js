'use strict';

const { OFFICIAL_PUBLISHER_ID } = require('../view/contribution-compiler');
const OFFICIAL_CURRENT_KEY_ID = '7ed60652328f0fbbdb7417c97a9fbd4f2f54ef223af774e9d83ddf213a1291f5';

const STAGE7_KINDS = Object.freeze([
  'setup_scene', 'panel', 'artifact_renderer', 'provider_descriptor',
]);
const STAGE7_KIND_SET = new Set(STAGE7_KINDS);

function evaluateStage7Eligibility({ pluginEntry, verdict, kinds, eligibility }) {
  const requested = new Set(verdict.manifest.requested_permissions || []);
  const allowedPermissions = new Set(['ui.view', 'network.fetch', 'secret.brokered_use']);
  if (requested.size !== (verdict.manifest.requested_permissions || []).length
    || [...requested].some((permission) => !allowedPermissions.has(permission))) {
    return eligibility('permissions_requested', kinds);
  }
  if (kinds.length === 0) return eligibility('no_supported_contributions', kinds);
  if (kinds.some((kind) => !STAGE7_KIND_SET.has(kind))) {
    return eligibility('mixed_or_unsupported_contributions', kinds);
  }
  if (kinds.includes('provider_descriptor') && (
    pluginEntry?.publisher_id !== OFFICIAL_PUBLISHER_ID
    || verdict.publisher_id !== OFFICIAL_PUBLISHER_ID
    || pluginEntry?.publisher_key_id !== OFFICIAL_CURRENT_KEY_ID
    || verdict.publisher_key_id !== OFFICIAL_CURRENT_KEY_ID
  )) return eligibility('publisher_key_not_current', kinds);
  if (pluginEntry?.effective_state === 'active') return eligibility('already_active', kinds);
  return eligibility('eligible', kinds);
}

module.exports = { OFFICIAL_CURRENT_KEY_ID, STAGE7_KINDS, evaluateStage7Eligibility };
