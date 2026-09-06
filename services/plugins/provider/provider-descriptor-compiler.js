'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');

const ALLOWED_SECRET_PLACEHOLDERS = new Set(['{secret:access_token}']);
const REQUIRED_STREAM_EVENTS = Object.freeze({
  'response.output_text.delta': 'text_delta',
  'response.reasoning_summary_text.delta': 'reasoning_delta',
  'response.output_item.done': 'output_item',
  'response.completed': 'completed',
  'response.failed': 'failed',
});

function compileProviderDescriptor(raw, authority) {
  const checked = validate('PluginProviderDescriptorV5', raw);
  if (!checked.ok) return { ok: false, reason: 'provider_descriptor_invalid', detail: checked.error };
  for (const header of checked.value.headers) {
    const placeholders = header.value.match(/\{secret:[^}]+\}/g) || [];
    if (placeholders.some((value) => !ALLOWED_SECRET_PLACEHOLDERS.has(value))) {
      return { ok: false, reason: 'provider_secret_placeholder_invalid' };
    }
  }
  let origin;
  try { origin = new URL(checked.value.endpoint).origin; } catch (_error) {
    return { ok: false, reason: 'provider_endpoint_invalid' };
  }
  if (origin !== 'https://chatgpt.com') return { ok: false, reason: 'provider_endpoint_not_allowlisted' };
  if (checked.value.safe_scalar_rules.some((rule) => rule.minimum > rule.maximum)) {
    return { ok: false, reason: 'provider_safe_scalar_rule_invalid' };
  }
  const streams = new Map(checked.value.stream_map.map((item) => [item.event, item.output_kind]));
  if (Object.entries(REQUIRED_STREAM_EVENTS).some(([event, kind]) => streams.get(event) !== kind)) {
    return { ok: false, reason: 'provider_stream_map_incomplete' };
  }
  if (!checked.value.error_map.some((item) => item.status_code === 401
    && item.reason_code === 'authentication_required' && item.retryable === false)) {
    return { ok: false, reason: 'provider_error_map_incomplete' };
  }
  if (!checked.value.lookup_tables.some((item) => item.name === 'reasoning_effort')) {
    return { ok: false, reason: 'provider_lookup_table_incomplete' };
  }
  return { ok: true, descriptor: Object.freeze({ ...checked.value, authority: Object.freeze({ ...authority }) }) };
}

module.exports = { compileProviderDescriptor };
