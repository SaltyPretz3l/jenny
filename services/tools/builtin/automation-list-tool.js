'use strict';

const { manifestSchema, serviceFailure, serviceUnavailable } = require('./tool-result');

const RESULT_KIND = 'automation_list';
const LABEL = 'Automation list';

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
  ...manifestSchema('automation_list'),
  category: 'builtin',
  readOnly: true,
  workspaceRequired: true,

  summarize() {
    return 'List automations';
  },

  async execute(_input, context) {
    if (!context.automationService || typeof context.automationService.listAutomations !== 'function') {
      return serviceUnavailable(RESULT_KIND, {
        label: LABEL,
        content: 'Automation service is unavailable.',
      });
    }
    const result = await context.automationService.listAutomations();
    if (!result?.success) {
      return serviceFailure(RESULT_KIND, result, { label: LABEL });
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
        result_kind: RESULT_KIND,
        count: automations.length,
        total_count: totalCount,
        omitted_count: omittedCount,
        automations,
      },
    };
  },
};
