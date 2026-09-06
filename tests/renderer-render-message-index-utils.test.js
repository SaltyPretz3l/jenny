const test = require('node:test');
const assert = require('node:assert/strict');

const {
  indexRowsByRenderMessageId,
  _SOURCE_RANK,
} = require('../renderer/chat/renderer-render-message-index-utils');

function row(overrides) {
  return {
    row_id: 'row:test',
    turn_id: 'turn_test',
    kind: 'assistant_text',
    primary_message_id: 'msg_test',
    payload: { text: 'body' },
    ...overrides,
  };
}

test('indexRowsByRenderMessageId buckets rows by render_message_id', () => {
  const rowsByTurnId = new Map([
    ['turn_a', [row({ row_id: 'row:a1', primary_message_id: 'msg_a' })]],
    ['turn_b', [row({ row_id: 'row:b1', primary_message_id: 'msg_b' })]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  assert.equal(index.get('msg_a')?.length, 1);
  assert.equal(index.get('msg_b')?.length, 1);
});

test('indexRowsByRenderMessageId falls back to primary_message_id when render_message_id is unset', () => {
  const rowsByTurnId = new Map([
    ['turn_a', [{ row_id: 'row:a', turn_id: 'turn_a', kind: 'assistant_text', primary_message_id: 'msg_a', payload: {} }]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  assert.equal(index.get('msg_a')?.length, 1);
});

test('indexRowsByRenderMessageId prefers canonical assistant_text over live overlay for the same primary_message_id', () => {
  const canonical = row({
    row_id: 'row:canon',
    turn_id: 'turn_canon',
    primary_message_id: 'msg_collide',
    render_message_id: 'msg_collide',
    payload: { text: 'Canonical final body' },
  });
  const live = row({
    row_id: 'row:live',
    turn_id: 'turn_live',
    primary_message_id: 'msg_collide',
    render_message_id: 'msg_collide',
    _dedup_source: 'live',
    payload: { text: 'Live partial body' },
  });
  // Two turns claim the same render_message_id. Canonical wins.
  const rowsByTurnId = new Map([
    ['turn_canon', [canonical]],
    ['turn_live', [live]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get('msg_collide') || [];
  assert.equal(bucket.length, 1, 'multi-turn collision must collapse to a single bucket entry');
  assert.equal(bucket[0].payload.text, 'Canonical final body');
});

test('indexRowsByRenderMessageId lets a live running tool row beat a canonical interrupted misprojection', () => {
  // While a tool is still executing, the messages-derived canonical
  // projection marks it 'interrupted' (settled-replay verdict for
  // executing-with-no-result). The live reducer row carries the real
  // 'running' state and must win that one matchup.
  const canonicalInterrupted = row({
    row_id: 'row:canon-tool',
    turn_id: 'turn_canon',
    kind: 'tool_call',
    primary_message_id: 'tool_use_1',
    render_message_id: 'tool_use_1',
    tool_call_id: 'call_1',
    payload: { tool_call_id: 'call_1', tool_name: 'Read', state: 'interrupted' },
  });
  const liveRunning = row({
    row_id: 'row:live-tool',
    turn_id: 'turn_live',
    kind: 'tool_call',
    primary_message_id: 'tool_use_1',
    render_message_id: 'tool_use_1',
    tool_call_id: 'call_1',
    _dedup_source: 'live',
    payload: { tool_call_id: 'call_1', tool_name: 'Read', state: 'running' },
  });
  // Order-independent: live-then-canonical and canonical-then-live both keep
  // the live running row.
  for (const ordered of [[canonicalInterrupted, liveRunning], [liveRunning, canonicalInterrupted]]) {
    const index = indexRowsByRenderMessageId(new Map([
      ['turn_a', [ordered[0]]],
      ['turn_b', [ordered[1]]],
    ]));
    const bucket = index.get('tool_use_1') || [];
    assert.equal(bucket.length, 1);
    assert.equal(bucket[0].payload.state, 'running');
  }
  // A genuinely settled interrupted tool (no live overlay row) is untouched.
  const aloneIndex = indexRowsByRenderMessageId(new Map([['turn_a', [canonicalInterrupted]]]));
  assert.equal((aloneIndex.get('tool_use_1') || [])[0].payload.state, 'interrupted');
});

test('indexRowsByRenderMessageId prefers reconciled over live when both are tagged', () => {
  const reconciled = row({
    row_id: 'row:rec',
    turn_id: 'turn_a',
    primary_message_id: 'msg_collide',
    _dedup_source: 'reconciled',
    payload: { text: 'Reconciled body' },
  });
  const live = row({
    row_id: 'row:live',
    turn_id: 'turn_b',
    primary_message_id: 'msg_collide',
    _dedup_source: 'live',
    payload: { text: 'Live body' },
  });
  const rowsByTurnId = new Map([
    ['turn_a', [reconciled]],
    ['turn_b', [live]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get('msg_collide') || [];
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0].payload.text, 'Reconciled body');
});

test('indexRowsByRenderMessageId dedups reasoning rows by (primary_message_id, phase_id)', () => {
  const canonical = row({
    row_id: 'row:reason_canon',
    turn_id: 'turn_a',
    kind: 'reasoning',
    primary_message_id: 'msg_reason',
    phase_id: 'phase_1',
    payload: { phase_id: 'phase_1', entries: [{ text: 'Final settled thought' }] },
  });
  const live = row({
    row_id: 'row:reason_live',
    turn_id: 'turn_b',
    kind: 'reasoning',
    primary_message_id: 'msg_reason',
    phase_id: 'phase_1',
    _dedup_source: 'live',
    payload: { phase_id: 'phase_1', entries: [{ text: 'Streaming partial thought' }] },
  });
  const rowsByTurnId = new Map([
    ['turn_a', [canonical]],
    ['turn_b', [live]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get('msg_reason') || [];
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0].payload.entries[0].text, 'Final settled thought');
});

test('indexRowsByRenderMessageId keeps multi-phase reasoning rows distinct (different phase_ids do not collapse)', () => {
  const phaseOne = row({
    row_id: 'row:phase_1',
    turn_id: 'turn_a',
    kind: 'reasoning',
    primary_message_id: 'msg_multi',
    phase_id: 'phase_one',
    payload: { phase_id: 'phase_one', entries: [{ text: 'Step one body' }] },
  });
  const phaseTwo = row({
    row_id: 'row:phase_2',
    turn_id: 'turn_a',
    kind: 'reasoning',
    primary_message_id: 'msg_multi',
    phase_id: 'phase_two',
    payload: { phase_id: 'phase_two', entries: [{ text: 'Step two body' }] },
  });
  const rowsByTurnId = new Map([
    ['turn_a', [phaseOne, phaseTwo]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get('msg_multi') || [];
  assert.equal(bucket.length, 2, 'distinct phases must stay distinct');
  assert.equal(bucket[0].phase_id, 'phase_one');
  assert.equal(bucket[1].phase_id, 'phase_two');
});

test('indexRowsByRenderMessageId dedups tool and approval rows by stable call ids', () => {
  const canonicalTool = row({
    row_id: 'row:tool:canonical',
    turn_id: 'turn_a',
    kind: 'tool_step',
    primary_message_id: 'msg_tool',
    tool_call_id: 'call-1',
    payload: { state: 'completed' },
  });
  const liveTool = row({
    row_id: 'row:tool:live',
    turn_id: 'turn_b',
    kind: 'tool_step',
    primary_message_id: 'msg_tool',
    tool_call_id: 'call-1',
    _dedup_source: 'live',
    payload: { state: 'running' },
  });
  const canonicalApproval = row({
    row_id: 'row:approval:canonical',
    turn_id: 'turn_a',
    kind: 'approval_gap',
    primary_message_id: 'msg_tool',
    approval_id: 'approval-1',
    payload: { status: 'approved' },
  });
  const liveApproval = row({
    row_id: 'row:approval:live',
    turn_id: 'turn_b',
    kind: 'approval_gap',
    primary_message_id: 'msg_tool',
    approval_id: 'approval-1',
    _dedup_source: 'live',
    payload: { status: 'pending' },
  });
  const rowsByTurnId = new Map([
    ['turn_b', [liveTool, liveApproval]],
    ['turn_a', [canonicalTool, canonicalApproval]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get('msg_tool') || [];
  assert.equal(bucket.length, 2);
  assert.equal(bucket[0].row_id, 'row:tool:canonical');
  assert.equal(bucket[1].row_id, 'row:approval:canonical');
});

test('indexRowsByRenderMessageId leaves non-dedupable kinds such as system_notice untouched', () => {
  const toolRow = row({
    row_id: 'row:tool',
    turn_id: 'turn_a',
    kind: 'tool_step',
    primary_message_id: 'msg_tool',
    tool_call_id: 'call-unique',
    payload: { state: 'completed' },
  });
  const noticeRow = row({
    row_id: 'row:notice',
    turn_id: 'turn_a',
    kind: 'system_notice',
    primary_message_id: 'msg_tool',
    payload: { subkind: 'orphan_carry' },
  });
  const rowsByTurnId = new Map([
    ['turn_a', [toolRow, noticeRow]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get('msg_tool') || [];
  assert.equal(bucket.length, 2);
});

test('indexRowsByRenderMessageId preserves first-sighting position when canonical replaces live in place', () => {
  // Liveness order: live arrives first (it streams), then canonical
  // overwrites. The replacement must keep canonical at the original slot
  // so siblings around it (tool_steps, system_notices) don't reorder.
  const live = row({
    row_id: 'row:live',
    turn_id: 'turn_live',
    primary_message_id: 'msg_pos',
    _dedup_source: 'live',
    payload: { text: 'Live body' },
  });
  const toolBefore = row({
    row_id: 'row:tool_before',
    turn_id: 'turn_canon',
    kind: 'tool_step',
    primary_message_id: 'msg_pos',
    payload: { state: 'completed' },
  });
  const canonical = row({
    row_id: 'row:canon',
    turn_id: 'turn_canon',
    primary_message_id: 'msg_pos',
    payload: { text: 'Canonical body' },
  });
  // Iteration order is by turn (Map preserves insertion order). Live comes
  // first as turn_live, then canonical as part of turn_canon along with the
  // tool row that should sit between them.
  const rowsByTurnId = new Map([
    ['turn_live', [live]],
    ['turn_canon', [toolBefore, canonical]],
  ]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get('msg_pos') || [];
  assert.equal(bucket.length, 2);
  // assistant_text slot stays at index 0 (where live originally landed),
  // but the row at that slot is now canonical. tool_step keeps its order.
  assert.equal(bucket[0].kind, 'assistant_text');
  assert.equal(bucket[0].payload.text, 'Canonical body');
  assert.equal(bucket[1].kind, 'tool_step');
});

test('indexRowsByRenderMessageId returns empty Map for missing or non-iterable input', () => {
  assert.equal(indexRowsByRenderMessageId(null).size, 0);
  assert.equal(indexRowsByRenderMessageId(undefined).size, 0);
  assert.equal(indexRowsByRenderMessageId({}).size, 0);
  assert.equal(indexRowsByRenderMessageId(new Map()).size, 0);
});

test('SOURCE_RANK is canonical > reconciled > live', () => {
  assert.ok(_SOURCE_RANK.canonical > _SOURCE_RANK.reconciled);
  assert.ok(_SOURCE_RANK.reconciled > _SOURCE_RANK.live);
});

test('indexRowsByRenderMessageId remaps tool_result rows into their paired call row bucket', () => {
  const toolCallRow = {
    row_id: 'row:call',
    turn_id: 'turn_tools',
    kind: 'tool_call',
    tool_call_id: 'call_1',
    primary_message_id: 'tool_use_stream_call_1',
    render_message_id: 'tool_use_stream_call_1',
    payload: { tool_call_id: 'call_1', tool_name: 'mermaid_generate' },
  };
  const toolResultRow = {
    row_id: 'row:result',
    turn_id: 'turn_tools',
    kind: 'tool_result',
    tool_call_id: 'call_1',
    primary_message_id: 'tool_result_stream_call_1',
    render_message_id: 'tool_result_stream_call_1',
    payload: { tool_call_id: 'call_1', tool_name: 'mermaid_generate', output_text: '{"mermaid":"graph TD"}' },
  };
  const rowsByTurnId = new Map([['turn_tools', [toolCallRow, toolResultRow]]]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  // tool_result articles are suppressed (anchor only), so the result row must
  // land in the call row''s bucket — directly after the call — to render.
  const bucket = index.get('tool_use_stream_call_1') || [];
  assert.deepEqual(bucket.map((entry) => entry.row_id), ['row:call', 'row:result']);
  assert.equal(index.has('tool_result_stream_call_1'), false);
});

test('indexRowsByRenderMessageId keeps orphan tool_result rows in their own bucket', () => {
  const orphanResultRow = {
    row_id: 'row:orphan',
    turn_id: 'turn_orphan',
    kind: 'tool_result',
    tool_call_id: 'call_lost',
    primary_message_id: 'tool_result_stream_call_lost',
    render_message_id: 'tool_result_stream_call_lost',
    payload: { tool_call_id: 'call_lost' },
  };
  const rowsByTurnId = new Map([['turn_orphan', [orphanResultRow]]]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  assert.equal(index.get('tool_result_stream_call_lost')?.length, 1);
});

// Regression (queue #13 R3 remediation): the collector derives source_citations
// events from the tool_result event, so the projected row inherits that event's
// primary_message_id — the tool_result message — even though its row kind is
// system_notice, not tool_result. Before this fix that left the chip row in the
// same suppressed-article bucket a bare tool_result row would land in, except
// the tool_result-only remap above never matched kind 'system_notice', so the
// bucket was never redirected to the call row and the chips were silently
// dropped (zero citation-chip elements, matching the live drive evidence).
test('indexRowsByRenderMessageId remaps a source_citations system_notice row into its paired call row bucket', () => {
  const toolCallRow = {
    row_id: 'row:call',
    turn_id: 'turn_web',
    kind: 'tool_call',
    tool_call_id: 'call_web',
    primary_message_id: 'tool_use_stream_call_web',
    render_message_id: 'tool_use_stream_call_web',
    payload: { tool_call_id: 'call_web', tool_name: 'web_search' },
  };
  const citationRow = {
    row_id: 'row:citations',
    turn_id: 'turn_web',
    kind: 'system_notice',
    tool_call_id: 'call_web',
    primary_message_id: 'tool_result_stream_call_web',
    render_message_id: 'tool_result_stream_call_web',
    payload: { subkind: 'source_citations', tool_call_id: 'call_web', refs: [{ url: 'https://example.com', title: 'Example' }] },
  };
  const rowsByTurnId = new Map([['turn_web', [toolCallRow, citationRow]]]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get('tool_use_stream_call_web') || [];
  assert.deepEqual(bucket.map((entry) => entry.row_id), ['row:call', 'row:citations'],
    'citations row joins the call row bucket instead of its own suppressed tool_result-message bucket');
  assert.equal(index.has('tool_result_stream_call_web'), false, 'the orphaned tool_result-message bucket is empty');
});

test('indexRowsByRenderMessageId keeps an orphan source_citations row in its own bucket when no call row exists', () => {
  const orphanCitationRow = {
    row_id: 'row:orphan-citations',
    turn_id: 'turn_web_orphan',
    kind: 'system_notice',
    tool_call_id: 'call_lost',
    primary_message_id: 'tool_result_stream_call_lost',
    render_message_id: 'tool_result_stream_call_lost',
    payload: { subkind: 'source_citations', tool_call_id: 'call_lost', refs: [{ url: 'https://example.com', title: 'Example' }] },
  };
  const rowsByTurnId = new Map([['turn_web_orphan', [orphanCitationRow]]]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  assert.equal(index.get('tool_result_stream_call_lost')?.length, 1);
});

test('indexRowsByRenderMessageId leaves other system_notice subkinds (e.g. orphan_carry) unremapped', () => {
  const otherNoticeRow = {
    row_id: 'row:other-notice',
    turn_id: 'turn_notice',
    kind: 'system_notice',
    tool_call_id: 'call_web',
    primary_message_id: 'tool_result_stream_call_web',
    render_message_id: 'tool_result_stream_call_web',
    payload: { subkind: 'orphan_carry' },
  };
  const toolCallRow = {
    row_id: 'row:call',
    turn_id: 'turn_notice',
    kind: 'tool_call',
    tool_call_id: 'call_web',
    primary_message_id: 'tool_use_stream_call_web',
    render_message_id: 'tool_use_stream_call_web',
    payload: { tool_call_id: 'call_web', tool_name: 'web_search' },
  };
  const rowsByTurnId = new Map([['turn_notice', [toolCallRow, otherNoticeRow]]]);
  const index = indexRowsByRenderMessageId(rowsByTurnId);
  assert.equal(index.get('tool_result_stream_call_web')?.length, 1, 'non-citations notices keep their own bucket');
  assert.equal(index.get('tool_use_stream_call_web')?.length, 1, 'call row bucket is untouched by unrelated notices');
});
