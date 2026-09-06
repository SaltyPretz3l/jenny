'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');

function serviceUnavailable() {
  return {
    content: 'Automation service is unavailable.',
    summary: 'Automation list unavailable',
    isError: true,
    errorCode: TOOL_ERROR_CODES.DISABLED,
    metadata: {
      result_kind: 'automation_list',
      unavailable: true,
    },
  };
}

function renderAutomation(entry) {
  const enabled = entry.enabled ? 'enabled' : 'disabled';
  const intervalSeconds = Number(entry.trigger?.interval_seconds || 0);
  const cadence = intervalSeconds > 0 ? `every ${intervalSeconds}s` : 'unknown cadence';
  const lastStatus = entry.last_status ? `, last ${entry.last_status}` : '';
  return `- ${entry.task || entry.id} (${enabled}, ${cadence}${lastStatus}, id ${entry.id})`;
}

function normalizeCount(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

module.exports = {
  name: 'automation_list',
  description: 'List read-only time-based automations from Jenny scheduler records.',
  category: 'builtin',
  readOnly: true,
  workspaceRequired: true,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },

  summarize() {
    return 'List automations';
  },

  async execute(_input, context) {
    if (!context.automationService || typeof context.automationService.listAutomations !== 'function') {
      return serviceUnavailable();
    }
    const result = await context.automationService.listAutomations();
    if (!result?.success) {
      return {
        content: result?.message || 'Automation list failed.',
        summary: 'Automation list failed',
        isError: true,
        errorCode: result?.error_code || TOOL_ERROR_CODES.EXECUTION_FAILED,
        metadata: {
          result_kind: 'automation_list',
          reason: result?.reason || 'execution_failed',
        },
      };
    }
    const automations = Array.isArray(result.automations) ? result.automations : [];
    const totalCount = normalizeCount(result.total_count, automations.length);
    const omittedCount = normalizeCount(result.omitted_count, Math.max(totalCount - automations.length, 0));
    const suffix = omittedCount > 0
      ? `\n${omittedCount} additional automation(s) omitted from this bounded list.`
      : '';
    return {
      content: automations.length
        ? `Found ${totalCount} automation(s), showing ${automations.length}:\n${automations.map(renderAutomation).join('\n')}${suffix}`
        : 'Found 0 automation(s).',
      summary: `List ${automations.length} automation(s)`,
      isError: false,
      metadata: {
        result_kind: 'automation_list',
        count: automations.length,
        total_count: totalCount,
        omitted_count: omittedCount,
        automations,
      },
    };
  },
};
