'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizePersistedToolResultMetadata,
  normalizeToolResultMetadataForStorage,
} = require('../services/backend/tool-result-diff-metadata');

const CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e1f21';

function validSummary(overrides = {}) {
  return {
    schema_version: 1,
    change_set_id: CHANGE_SET_ID,
    state: 'in_progress',
    operation_sequences: [1, 2],
    protected: true,
    partially_undoable: false,
    warning: 'Shell mutations are not journaled.',
    ...overrides,
  };
}

test('workspace_change_set persists only the bounded public summary', () => {
  const source = {
    path: 'notes.txt',
    workspace_change_set: validSummary({
      operation_sequences: Array.from({ length: 120 }, (_value, index) => index + 1),
      warning: 'w'.repeat(800),
      private_extra: 'discard me',
    }),
  };

  const structured = normalizePersistedToolResultMetadata(source);
  const stored = normalizeToolResultMetadataForStorage(source);

  assert.deepEqual(Object.keys(structured.workspace_change_set), [
    'schema_version',
    'change_set_id',
    'state',
    'operation_sequences',
    'protected',
    'partially_undoable',
    'warning',
  ]);
  assert.equal(structured.workspace_change_set.operation_sequences.length, 100);
  assert.equal(structured.workspace_change_set.warning.length, 512);
  assert.deepEqual(stored.workspace_change_set, structured.workspace_change_set);
  assert.equal(Object.hasOwn(stored.workspace_change_set, 'private_extra'), false);
});

test('absolute userData and raw recovery-object paths drop the whole summary', () => {
  const absolutePath = normalizeToolResultMetadataForStorage({
    path: 'kept.txt',
    workspace_change_set: validSummary({ warning: 'C:\\Users\\name\\AppData\\Roaming\\jenny' }),
  });
  const recoveryPath = normalizeToolResultMetadataForStorage({
    path: 'kept.txt',
    workspace_change_set: validSummary({
      recovery_object_path: '.jenny/trash/20260904/file.txt',
    }),
  });

  assert.equal(absolutePath.path, 'kept.txt');
  assert.equal(Object.hasOwn(absolutePath, 'workspace_change_set'), false);
  assert.equal(recoveryPath.path, 'kept.txt');
  assert.equal(Object.hasOwn(recoveryPath, 'workspace_change_set'), false);
  assert.equal(JSON.stringify(absolutePath).includes('AppData'), false);
  assert.equal(JSON.stringify(recoveryPath).includes('.jenny/trash'), false);
});

test('malformed change-set summaries are not persisted', () => {
  for (const workspaceChangeSet of [
    validSummary({ change_set_id: 'not-a-change-set' }),
    validSummary({ state: 'unknown' }),
    validSummary({ protected: 'yes' }),
    validSummary({ operation_sequences: [0] }),
  ]) {
    const stored = normalizeToolResultMetadataForStorage({ workspace_change_set: workspaceChangeSet });
    assert.equal(Object.hasOwn(stored, 'workspace_change_set'), false);
  }
});
