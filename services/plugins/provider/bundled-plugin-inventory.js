'use strict';

const DIGEST_RE = /^[0-9a-f]{64}$/;
const SAFE_RESOURCE_RE = /^plugins\/[a-z0-9][a-z0-9._-]{0,127}\.jenny-plugin$/;

function resolveBundledPluginRecord(inventory, identity) {
  const records = Array.isArray(inventory?.plugins) ? inventory.plugins : [];
  const record = records.find((item) => item?.publisher_id === identity?.publisher_id
    && item?.plugin_id === identity?.plugin_id);
  if (!record) return { ok: false, reason: 'bundled_package_inventory_invalid' };
  if (record.status === 'awaiting_owner_signature' && record.package_sha256 === null
    && SAFE_RESOURCE_RE.test(record.package_resource || '')) {
    return { ok: false, reason: 'bundled_package_awaiting_owner_signature' };
  }
  if (record.status !== 'pinned' || !DIGEST_RE.test(record.package_sha256 || '')
    || !DIGEST_RE.test(record.signing_key_id || '')
    || !SAFE_RESOURCE_RE.test(record.package_resource || '')) {
    return { ok: false, reason: 'bundled_package_inventory_invalid' };
  }
  return { ok: true, record };
}

module.exports = { resolveBundledPluginRecord };
