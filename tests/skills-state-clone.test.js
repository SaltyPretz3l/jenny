const test = require('node:test');
const assert = require('node:assert/strict');

const { cloneSkillScope, cloneSkillsState } = require('../services/skills-state-clone');

test('cloneSkillsState returns a deep copy that cannot reach the source', () => {
  const entry = { id: 'user:a', scope: 'user', name: 'A', allowedTools: ['read_file'], always: true };
  const source = {
    featureEnabled: true,
    settings: { userEnabled: true, disabledSkillIds: ['user:b'] },
    scopes: [{ scope: 'user', enabled: true, status: 'ready', entries: [entry], warnings: [{ code: 'x' }] }],
    entries: [entry],
    warnings: [{ scope: 'user', path: 'p', code: 'x', message: 'm' }],
    counts: { total: 1, always: 1, warnings: 1 },
  };

  const copy = cloneSkillsState(source);
  copy.entries[0].allowedTools.push('run_command');
  copy.scopes[0].entries[0].name = 'changed';
  copy.settings.disabledSkillIds.push('user:c');
  copy.warnings[0].code = 'changed';

  assert.deepEqual(entry.allowedTools, ['read_file']);
  assert.equal(entry.name, 'A');
  assert.deepEqual(source.settings.disabledSkillIds, ['user:b']);
  assert.equal(source.warnings[0].code, 'x');
  assert.equal(copy.settings.userEnabled, true);
  assert.deepEqual(copy.counts, { total: 1, always: 1, warnings: 1 });
});

test('clone helpers normalise missing or malformed fields', () => {
  const state = cloneSkillsState({ settings: [], counts: { total: 'n/a' }, scopes: 'nope' });
  assert.equal(state.featureEnabled, false);
  assert.deepEqual(state.settings, { disabledSkillIds: [] });
  assert.deepEqual(state.scopes, []);
  assert.deepEqual(state.counts, { total: 0, always: 0, warnings: 0 });

  const scope = cloneSkillScope({ scope: 'project', entries: [{}], blocked: true });
  assert.equal(scope.enabled, false);
  assert.equal(scope.blocked, true);
  assert.equal(scope.entries[0].enabled, true, 'an entry is enabled unless explicitly disabled');
  assert.deepEqual(scope.entries[0].allowedTools, []);
  assert.deepEqual(scope.warnings, []);
});
