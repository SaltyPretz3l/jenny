'use strict';

const HINTS = Object.freeze({
  archive_invalid: 'rebuild the archive with only plugin.json, the signature bundle, content/**, and permitted metadata',
  manifest_invalid: 'fix plugin.json to match the declared PluginManifestV1..V6 contract',
  manifest_contract_unsupported: 'set manifest_schema_version to one of 1, 2, 3, 4, 5, or 6',
  display_string_invalid: 'use NFC text without control, bidi, zero-width, reserved, or overlong display strings',
  content_invalid: 'fix the contribution JSON to match its declared content schema and manifest authority',
  content_path_unsafe: 'content_path must be a relative path inside the plugin folder',
  digest_mismatch: 'replace content_sha256 with the true digest shown above or rerun with --write-digests',
  budget_exceeded: 'reduce the affected content or view assets to the published plugin budget',
  signature_bundle_invalid: 'use exactly the documented signature-bundle and signature entry keys',
  developer_intake_failed: 'fix the reported package intake rejection before installing the archive',
});

function formatText(result) {
  const lines = [];
  for (const check of result.checks) {
    const label = check.status === 'fail' ? 'FAIL' : check.status;
    const reason = check.status === 'skip' && check.problem ? `  (${check.problem})` : '';
    lines.push(`${label}  ${check.id.padEnd(26)}  ${check.target}${reason}`);
    if (check.status === 'fail') {
      lines.push(`  problem: ${check.problem}`);
      lines.push(`  hint: ${check.hint}`);
    }
  }
  lines.push(`${result.summary.passed} checks passed, ${result.summary.failed} failed, `
    + `${result.summary.skipped} skipped  —  ${result.target}`);
  return `${lines.join('\n')}\n`;
}

function formatJson(result) {
  return `${JSON.stringify(result)}\n`;
}

module.exports = { HINTS, formatText, formatJson };
