'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { REPLAY_SCRIPT_DIR } = require('../scripts/demo/demo-scenes');

const TOOL_IDS = new Set([
  'read_file',
  'list_dir',
  'git_status',
  'git_log',
  'git_diff',
  'git_show',
  'write_file',
  'create_artifact',
  'glob_files',
  'grep_search',
  'edit_file',
  'mermaid_generate',
  'home',
]);
const INTERNAL_COPY = /\b(?:replay|smoke|deterministic)\b/i;

function callIndex(messages, callCount) {
  if (callCount <= 0 || !messages.length) {
    return 0;
  }
  const relevant = messages.filter((message) => message.role === 'user' || message.role === 'tool').length;
  return Math.max(relevant - 1, 0) % callCount;
}

function assertScriptedTurnTerminates(calls, fileName) {
  const messages = [{ role: 'user' }];
  for (let resolution = 1; resolution <= calls.length + 1; resolution += 1) {
    const call = calls[callIndex(messages, calls.length)];
    if (!Array.isArray(call.tool_calls) || call.tool_calls.length === 0) {
      assert.ok(resolution <= calls.length + 1, `${fileName} terminates within its call bound`);
      return;
    }
    for (const _toolCall of call.tool_calls) {
      messages.push({ role: 'tool' });
    }
  }
  assert.fail(`${fileName} scripted turn does not reach a call without tool_calls`);
}

test('demo replay scripts are valid, promo-facing, and terminate', () => {
  const fileNames = fs.readdirSync(REPLAY_SCRIPT_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.ok(fileNames.length > 0, 'at least one demo replay script exists');

  for (const fileName of fileNames) {
    const script = JSON.parse(fs.readFileSync(path.join(REPLAY_SCRIPT_DIR, fileName), 'utf8'));
    assert.strictEqual(script.version, 1, `${fileName} uses replay schema version 1`);
    assert.ok(Array.isArray(script.calls) && script.calls.length > 0, `${fileName} has calls`);
    for (const call of script.calls) {
      assert.ok(call && typeof call === 'object' && !Array.isArray(call), `${fileName} call is an object`);
      for (const field of ['text', 'reasoning']) {
        if (call[field] !== undefined) {
          assert.strictEqual(typeof call[field], 'string', `${fileName} ${field} is a string`);
          assert.ok(!INTERNAL_COPY.test(call[field]), `${fileName} ${field} stays promo-facing`);
        }
      }
      for (const toolCall of call.tool_calls || []) {
        assert.ok(TOOL_IDS.has(toolCall.tool_id), `${fileName} tool ${toolCall.tool_id} is allowed`);
      }
    }
    assertScriptedTurnTerminates(script.calls, fileName);
  }
});

test('the assistant-edit strings carry no slash (the tool-input panel redacts /,/g as a path)', () => {
  const { WORKING_TREE_EDIT } = require('../scripts/demo/demo-fixture');
  const script = JSON.parse(fs.readFileSync(path.join(REPLAY_SCRIPT_DIR, 'assistant-edit.json'), 'utf8'));
  const edit = script.calls.flatMap((call) => call.tool_calls || []).find((call) => call.tool_id === 'edit_file');
  assert.ok(edit, 'assistant-edit.json has an edit_file call');
  assert.ok(WORKING_TREE_EDIT.replace.includes(edit.arguments.old_string), 'old_string matches the seeded working-tree edit');
  for (const value of [edit.arguments.old_string, edit.arguments.new_string]) {
    assert.ok(!value.includes('/'), `${value} must not contain a slash`);
  }
});
