'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultRegistry } = require('../services/tools');
const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');

describe('automation_list tool with an automation_id', () => {
  test('automation_list with an id delegates by id and returns not_found as a tool error', async () => {
    const registry = createDefaultRegistry({ toolsAutomationsEnabled: true });
    const tool = registry.getTool('automation_list');
    let readId = '';

    const result = await tool.execute({ automation_id: 'automation:missing' }, {
      automationService: {
        async readAutomation(id) {
          readId = id;
          return {
            success: false,
            reason: 'not_found',
            message: 'Automation "automation:missing" was not found.',
          };
        },
      },
    });

    assert.equal(readId, 'automation:missing');
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.EXECUTION_FAILED, 'not CMP-TOOL-0005 Unknown tool');
    assert.equal(result.metadata.result_kind, 'automation_list');
    assert.equal(result.metadata.reason, 'not_found');
    assert.match(result.content, /Call automation_list with no arguments/);
  });

  test('automation_list lists when the id is empty or null', async () => {
    const registry = createDefaultRegistry({ toolsAutomationsEnabled: true });
    const tool = registry.getTool('automation_list');
    for (const automationId of ['', null]) {
      let reads = 0;
      const result = await tool.execute({ automation_id: automationId }, {
        automationService: {
          async readAutomation() { reads += 1; return { success: true }; },
          async listAutomations() { return { success: true, automations: [] }; },
        },
      });
      assert.equal(result.isError, false);
      assert.equal(result.content, 'Found 0 automation(s).');
      assert.equal(reads, 0);
    }
  });

  test('automation_list rejects a non-string id without calling the service', async () => {
    const registry = createDefaultRegistry({ toolsAutomationsEnabled: true });
    const tool = registry.getTool('automation_list');
    let calls = 0;
    const result = await tool.execute({ automation_id: { id: 'automation:x' } }, {
      automationService: {
        async readAutomation() { calls += 1; return { success: true }; },
        async listAutomations() { calls += 1; return { success: true, automations: [] }; },
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'invalid_arguments');
    assert.equal(calls, 0);
    assert.equal(tool.summarize({ automation_id: { id: 'x' } }), 'List automations');
    assert.equal(tool.summarize({ automation_id: 'automation:x' }), 'Read automation automation:x');
  });

  test('automation_list with an id includes the bounded definition and run history in model-visible content', async () => {
    const registry = createDefaultRegistry({ toolsAutomationsEnabled: true });
    const tool = registry.getTool('automation_list');
    const automation = {
      id: 'automation:project_health',
      task: 'project_health',
      task_spec: 'Run project checks.',
      automation_runs: [{ id: 'run-1', status: 'completed', artifacts: ['report.json'] }],
    };

    const result = await tool.execute({ automation_id: automation.id }, {
      automationService: {
        async readAutomation() {
          return { success: true, automation };
        },
      },
    });

    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content), { automation });
  });
});
