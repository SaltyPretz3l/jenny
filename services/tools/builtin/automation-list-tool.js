'use strict';

const {
  invalidArguments,
  manifestSchema,
  readStringArgument,
  serviceFailure,
  serviceUnavailable,
  summaryArgument,
} = require('./tool-result');

const RESULT_KIND = 'automation_list';
const LABEL = 'Automation list';
const MAX_AUTOMATION_ID_CHARS = 256;

function renderAutomation(entry) {
  const enabled = entry.enabled ? 'enabled' : 'disabled';
  const intervalSeconds = Number(entry.trigger?.interval_seconds || 0);
  const cadence = intervalSeconds > 0 ? `every ${intervalSeconds}s` : 'unknown cadence';
  const lastStatus = entry.last_status ? `, last ${entry.last_status}` : '';
  return `- ${entry.task || entry.id} (${enabled}, ${cadence}${lastStatus}, id ${entry.id})`;
}

// One automation's definition and bounded run history, by the id the list gives.
async function readOne(input, context) {
  if (!context.automationService || typeof context.automationService.readAutomation !== 'function') {
    return serviceUnavailable(RESULT_KIND, { label: LABEL, content: 'Automation service is unavailable.' });
  }
  const idArgument = readStringArgument(input, 'automation_id', { required: true, maxLength: MAX_AUTOMATION_ID_CHARS });
  if (idArgument.error) return invalidArguments(RESULT_KIND, { label: LABEL, content: idArgument.error });
  const automationId = idArgument.value;
  const result = await context.automationService.readAutomation(automationId);
  if (!result?.success) {
    // A missing id is a normal not-found outcome, never CMP-TOOL-0005 ("Unknown tool").
    const failure = serviceFailure(RESULT_KIND, result, {
      label: LABEL,
      reason: 'not_found',
      content: `Automation "${automationId}" was not found.`,
      metadata: { automation_id: automationId },
    });
    return { ...failure, content: `${failure.content} Call automation_list with no arguments to see the ids.` };
  }
  return {
    content: JSON.stringify({ automation: result.automation }),
    summary: `Read automation ${automationId}`,
    isError: false,
    metadata: { result_kind: RESULT_KIND, automation: result.automation },
  };
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

  summarize(input) {
    const id = summaryArgument(input, 'automation_id', MAX_AUTOMATION_ID_CHARS);
    return id ? `Read automation ${id}` : 'List automations';
  },

  async execute(input, context) {
    // An empty or null id is how some models leave an optional argument out: list.
    const id = input ? input.automation_id : undefined;
    if (id !== undefined && id !== null && id !== '') return readOne(input, context);
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
