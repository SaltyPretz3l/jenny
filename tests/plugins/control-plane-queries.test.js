'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  indexDeclarativeContents,
} = require('../../services/plugins/control-plane-queries');

test('V5 declarative contents inherit contribution identity from verified parallel metadata', () => {
  const setup = Object.freeze({
    content_schema_version: 5,
    view_kind: 'setup_scene',
    provider_ref: 'chatgpt',
  });
  const indexed = indexDeclarativeContents({
    declarative_contents: [setup],
    declarative_content_texts: [{ contribution_id: 'chatgpt-setup' }],
  });

  assert.strictEqual(indexed.get('chatgpt-setup'), setup);
});

test('embedded identity remains authoritative and duplicate metadata cannot replace it', () => {
  const embedded = Object.freeze({ contribution_id: 'skill-main', payload: { kind: 'skill' } });
  const duplicate = Object.freeze({ content_schema_version: 5, view_kind: 'panel' });
  const indexed = indexDeclarativeContents({
    declarative_contents: [embedded, duplicate],
    declarative_content_texts: [
      { contribution_id: 'metadata-mismatch' },
      { contribution_id: 'skill-main' },
    ],
  });

  assert.strictEqual(indexed.get('skill-main'), embedded);
  assert.equal(indexed.has('metadata-mismatch'), false);
});
