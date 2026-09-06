'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');

function normalizeAutomationId(input) {
  return String(input?.automation_id || input?.id || '').trim();
}

function serviceUnavailable() {
  return {
    content: 'Automation service is unavailable.',
    summary: 'Automation read unavailable',
    isError: true,
    errorCode: TOOL_ERROR_CODES.DISABLED,
    metadata: {
      result_kind: 'automation_read',
      unavailable: true,
    },
  };
}

function renderAutomationDetail(automation) {
  return JSON.stringify({ automation });
}

module.exports = {
  name: 'automation_read',
  description: 'Read one Jenny automation definition and bounded run history by automation id.',
  category: 'builtin',
  readOnly: true,
  workspaceRequired: true,
  parameters: {
    type: 'object',
    properties: {
      automation_id: {
        type: 'string',
        description: 'Automation id returned by automation_list, such as automation:project_health.',
      },
    },
    required: ['automation_id'],
  },

  summarize(input) {
    return `Read automation ${normalizeAutomationId(input) || 'details'}`;
  },

  async execute(input, context) {
    if (!context.automationService || typeof context.automationService.readAutomation !== 'function') {
      return serviceUnavailable();
    }
    const automationId = normalizeAutomationId(input);
    if (!automationId) {
      return {
        content: 'automation_id is required.',
        summary: 'Automation read failed',
        isError: true,
        errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
        metadata: {
          result_kind: 'automation_read',
          reason: 'invalid_arguments',
        },
      };
    }
    const result = await context.automationService.readAutomation(automationId);
    if (!result?.success) {
      return {
        content: result?.message || `Automation "${automationId}" was not found.`,
        summary: 'Automation read failed',
        isError: true,
        errorCode: result?.error_code || TOOL_ERROR_CODES.UNKNOWN,
        metadata: {
          result_kind: 'automation_read',
          reason: result?.reason || 'not_found',
          automation_id: automationId,
        },
      };
    }
    return {
      content: renderAutomationDetail(result.automation),
      summary: `Read automation ${automationId}`,
      isError: false,
      metadata: {
        result_kind: 'automation_read',
        automation: result.automation,
      },
    };
  },
};
