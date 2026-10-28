'use strict';

const {
  invalidArguments,
  manifestSchema,
  readStringArgument,
  serviceFailure,
  serviceUnavailable,
  summaryArgument,
} = require('./tool-result');

const RESULT_KIND = 'automation_read';
const LABEL = 'Automation read';
const MAX_AUTOMATION_ID_CHARS = 256;

function renderAutomationDetail(automation) {
  return JSON.stringify({ automation });
}

module.exports = {
  name: 'automation_read',
  ...manifestSchema('automation_read'),
  category: 'builtin',
  readOnly: true,
  workspaceRequired: true,

  summarize(input) {
    return `Read automation ${summaryArgument(input, 'automation_id', MAX_AUTOMATION_ID_CHARS) || 'details'}`;
  },

  async execute(input, context) {
    if (!context.automationService || typeof context.automationService.readAutomation !== 'function') {
      return serviceUnavailable(RESULT_KIND, {
        label: LABEL,
        content: 'Automation service is unavailable.',
      });
    }
    const idArgument = readStringArgument(input, 'automation_id', {
      required: true,
      maxLength: MAX_AUTOMATION_ID_CHARS,
    });
    if (idArgument.error) {
      return invalidArguments(RESULT_KIND, { label: LABEL, content: idArgument.error });
    }
    const automationId = idArgument.value;
    const result = await context.automationService.readAutomation(automationId);
    if (!result?.success) {
      // A missing id is a normal not-found outcome like the other tools',
      // never CMP-TOOL-0005 ("Unknown tool").
      return serviceFailure(RESULT_KIND, result, {
        label: LABEL,
        reason: 'not_found',
        content: `Automation "${automationId}" was not found.`,
        metadata: { automation_id: automationId },
      });
    }
    return {
      content: renderAutomationDetail(result.automation),
      summary: `Read automation ${automationId}`,
      isError: false,
      metadata: {
        result_kind: RESULT_KIND,
        automation: result.automation,
      },
    };
  },
};
