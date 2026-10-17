// The canonical turn.event bridge swaps a tool result's wire attachment ids
// for the refs Electron stored from the live tool.result
// (services/backend/tool-result-attachments.js withIngestedAttachmentRefs).
// Split from chat-stream-managed-runtime-notifications-behavior.test.js at its
// 600-line ceiling; the shared harness is tests/helpers/.
//
// Static-literal require (source->test existence gate walks this graph):
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const { withIngestedAttachmentRefs } = require('../services/backend/tool-result-attachments');

const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
  canonicalEvent,
} = require('./helpers/managed-runtime-notification-harness');

// A Python chart reaches the canonical event as a wire ref (att_*) with no
// stored asset, so the journal could not render it. The refs Electron stored
// from the live tool.result replace it before capture.
test('canonical tool_execution_completed journals the stored attachment refs, not the wire ids', () => {
  const capture = (seed) => {
    const ctx = makeCtx();
    if (seed) ctx.service._toolResultAttachmentIndex = new Map([[`session-1\0${seed.id}`, seed]]);
    handleNotification(ctx, {
      method: 'turn.event',
      params: canonicalEvent('tool_execution_completed', {
        tool_call_id: 'call-py', tool_name: 'python_execute', success: true, tool_output_summary: 'ok',
        trusted_attachment_refs: [
          { id: 'att_chart', kind: 'image', mime_type: 'image/png', byte_length: 10, width: 64, height: 48 },
          { id: 'att_unknown', kind: 'image', mime_type: 'image/png', byte_length: 4, width: 1, height: 1 },
        ],
      }, { tool_call_id: 'call-py' }),
    }, { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx, false) });
    return callsOf(ctx, 'noteEvent')[0].params.payload.trusted_attachment_refs;
  };
  const stored = {
    id: 'image_1', sourceId: 'att_chart', kind: 'image', mimeType: 'image/png', byteLength: 10,
    width: 64, height: 48, assetPath: 'C:/assets/image_1.png', streamId: 'stream-1',
    toolCallId: 'call-py', toolName: 'python_execute', sessionId: 'session-1',
  };

  const refs = capture(stored);
  assert.equal(refs[0].id, 'image_1');
  assert.equal(refs[0].source_id, 'att_chart');
  assert.equal(refs[0].asset_path, 'C:/assets/image_1.png');
  assert.equal(refs[1].id, 'att_unknown', 'a ref with no stored asset passes through');
  assert.equal(capture(null)[0].id, 'att_chart', 'nothing stored: the event is unchanged');
  assert.equal(capture({ ...stored, toolCallId: 'call-other' })[0].id, 'att_chart', 'another call is not borrowed');
});

test('withIngestedAttachmentRefs leaves events without trusted refs untouched', () => {
  const ctx = makeCtx();
  const event = { type: 'text_delta', payload: { text: 'hi' } };
  assert.equal(withIngestedAttachmentRefs(ctx, event), event);
  const empty = { type: 'tool_execution_completed', payload: { trusted_attachment_refs: [] } };
  assert.equal(withIngestedAttachmentRefs(ctx, empty), empty);
});
