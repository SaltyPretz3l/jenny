'use strict';

// renderer-render-pipeline-render-signatures.js: the source-structure and
// ambient-UI render signatures of the message renderer, split out of
// renderer-render-pipeline-message-renderer.js at its line cap. Contract: the
// structure signature moves with structural fields and ignores streamed
// content growth; the ambient signature folds the edit target and the
// selection membership of the pane that owns selection.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSourceStructureSignature,
  createAmbientUiSignature,
} = require('../renderer/chat/renderer-render-pipeline-render-signatures');

test('the structure signature follows structural fields, not streamed content', () => {
  const tool = (status) => ({ id: 't1', role: 'tool', status: 'running', tool_call: { status } });
  const base = buildSourceStructureSignature([{ id: 'a1', role: 'assistant', content: 'Hel' }, tool('running')]);
  assert.equal(
    buildSourceStructureSignature([{ id: 'a1', role: 'assistant', content: 'Hello there' }, tool('running')]),
    base,
    'content growth is a structure-stable hit'
  );
  assert.notEqual(
    buildSourceStructureSignature([{ id: 'a1', role: 'assistant', content: 'Hel' }, tool('pending_approval')]),
    base,
    'a tool lifecycle flip rebuilds the projection'
  );
  const recap = (answer) => ({ id: 'r1', role: 'assistant', kind: 'interactive_round_recap', interactive_round_recap: { answer } });
  assert.notEqual(buildSourceStructureSignature([recap('Node')]), buildSourceStructureSignature([recap('Deno')]));
  assert.equal(buildSourceStructureSignature(null), '');
  assert.equal(buildSourceStructureSignature([null, { id: 'x' }]).split('\n').length, 1, 'holes are skipped');
});

test('the ambient signature folds the edit target and the sorted selection of the selecting pane', () => {
  const state = { ui: { editingMessageId: 'm9', selectedMessageIdsBySession: new Map([['s1', new Set(['b', 'a'])]]) } };
  let selecting = true;
  const buildAmbientUiSignature = createAmbientUiSignature({ state, isPaneSelecting: () => selecting });
  assert.equal(buildAmbientUiSignature('s1'), 'E:m9\u001dB:\u001dS:1\u001dSEL:a,b');
  state.ui.branchCommitting = true;
  assert.equal(buildAmbientUiSignature('s2'), 'E:m9\u001dB:1\u001dS:1\u001dSEL:');
  selecting = false;
  assert.equal(buildAmbientUiSignature('s1'), 'E:m9\u001dB:1\u001dS:\u001dSEL:', 'another pane owns selection: no membership');
  assert.equal(createAmbientUiSignature({ state: {} })('s1'), 'E:\u001dB:\u001dS:\u001dSEL:');
});
