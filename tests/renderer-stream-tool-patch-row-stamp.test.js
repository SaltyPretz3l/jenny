'use strict';

// Astra finding (timeline-perf 2026-09-30): the live tool patch writes a tool
// row's DOM directly (name, summary, status), outside the row-list reconcile.
// The reconcile keeps a row untouched when its segment markup equals the stamp
// it last applied, so a direct write must drop that stamp: an identical later
// segment then restores the canonical markup instead of trusting the stamp.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const patch = require('../renderer/chat/renderer-stream-dom-patch-utils');
const { createLiveToolPatchController } = require('../renderer/chat/renderer-stream-tool-patch-utils');

test('a live tool patch drops the row stamp so an identical reconcile restores the canonical row', (t) => {
  const dom = new JSDOM('<!doctype html><div id="list" data-turn-row-list="true"></div>');
  t.after(() => dom.window.close());
  const list = dom.window.document.getElementById('list');
  const tools = createTurnRowToolRenderUtils({ toolCallUtils });
  const rows = createTurnRowListUtils({ buildRowBodyMarkup: (row, message, options) => tools.buildToolCallRowMarkup(row, message, options) });
  const row = {
    row_id: 'r', turn_id: 't', kind: 'tool_call', tool_call_id: 'c', primary_message_id: 'tool_c',
    payload: { tool_call_id: 'c', tool_name: 'read_file', state: 'completed', input: { path: 'src/main.js' } },
  };
  const segments = [];
  rows.buildTurnRowListMarkup([row], [], { rowListSegmentSink: segments });
  assert.equal(segments.length, 1);
  let flush = null;
  const controller = createLiveToolPatchController({
    chatTimeline: list,
    windowRef: { requestAnimationFrame: (cb) => { flush = cb; return 1; }, cancelAnimationFrame() {} },
  });
  t.after(() => controller.dispose());
  const outcomes = [];
  const reconcile = () => patch.reconcileKeyedRowList(list, segments, { onOutcome: (record) => outcomes.push(record.stats) });
  const read = () => list.querySelector('.tool-call-name')?.textContent;
  reconcile();
  const canonical = read();
  assert.ok(canonical, 'the row renders a tool name');
  const rowElement = list.firstElementChild;

  controller.queueToolPatch({ sessionId: 's', callId: 'c', type: 'tool_result', toolName: 'read_file', summary: 'Read 20 lines', content: 'example result' });
  assert.equal(typeof flush, 'function', 'the patch is scheduled on a frame');
  flush();
  assert.notEqual(read(), canonical, 'the direct writer changed the row');

  reconcile();
  assert.deepEqual([outcomes[1].kept, outcomes[1].morphed], [0, 1], 'the directly written row is re-morphed, not trusted');
  assert.strictEqual(list.firstElementChild, rowElement, 'row identity is kept');
  assert.equal(read(), canonical, 'the canonical markup is restored');
});
