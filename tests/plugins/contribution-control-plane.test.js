'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SETTINGS_FIELDS,
  MAX_PLUGIN_PAYLOAD_BYTES,
  readContributionEnvelope,
  dependencyMapFor,
} = require('../../services/plugins/contribution-control-plane');

function base(values) {
  return {
    publisher_id: 'jenny-official',
    plugin_id: 'owner-smoke',
    contribution_id: 'settings-main',
    expected_generation_id: 'gen-test',
    values,
  };
}

test('settings envelopes enforce field, byte, and cycle bounds before mutation', () => {
  const tooMany = Object.fromEntries(Array.from(
    { length: MAX_SETTINGS_FIELDS + 1 },
    (_entry, index) => [`key_${index}`, index]
  ));
  assert.equal(
    readContributionEnvelope(base(tooMany), 'update_settings').reason,
    'settings_values_too_many'
  );
  assert.equal(
    readContributionEnvelope(
      base({ value: 'x'.repeat(MAX_PLUGIN_PAYLOAD_BYTES + 1) }),
      'update_settings'
    ).reason,
    'settings_values_too_large'
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(
    readContributionEnvelope(base(cyclic), 'update_settings').reason,
    'invalid_settings_values'
  );
});

test('dependency mapping includes prompt targets and same-plugin settings bindings', () => {
  const contents = [
    { contribution_id: 'prompt-main', payload: { kind: 'prompt' } },
    {
      contribution_id: 'workflow-main',
      payload: {
        kind: 'workflow',
        nodes: [
          {
            type: 'prompt',
            target_contribution_id: 'prompt-main',
            bindings: [{ value: { source: 'setting', settings_contribution_id: 'settings-main' } }],
          },
        ],
      },
    },
    {
      contribution_id: 'command-main',
      payload: { kind: 'command', target_contribution_id: 'workflow-main' },
    },
  ];
  assert.deepEqual(dependencyMapFor(contents).get('workflow-main').sort(), ['prompt-main', 'settings-main']);
  assert.deepEqual(dependencyMapFor(contents).get('command-main'), ['workflow-main']);
});
