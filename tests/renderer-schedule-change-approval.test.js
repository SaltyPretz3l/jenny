'use strict';

// Row 85 (owner pick "B · Approval cards"): the schedule_change approval card shows the app's own
// reading of a scheduled-check change from `schedule_change_approval` (label, instruction, cadence in
// words, the next fire times), never the model's input. It reuses the row 88 setting lines. A refused,
// missing or malformed reading has no Allow; Always allow never renders for a check change.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock, normalizeScheduleChangeApproval } = require('../renderer/chat/renderer-approval-block');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { buildTurnEventFromStreamPayload, createTurnReducerState, applyTurnStreamEvent } = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('./helpers/renderer-turn-row-projector-helpers');
const { createToolHandlerHarness } = require('./helpers/stream-tool-handler-harness');
const toolApprovalFacts = require('../renderer/chat/tool-call-utils');
const { buildAttentionInbox } = require('../renderer/shell/renderer-attention-inbox-model');

const FIRES = ['2026-11-03T08:00:00-06:00', '2026-11-04T08:00:00-06:00', '2026-11-05T08:00:00-06:00'];
const LATER = ['2026-11-03T07:30:00-06:00', '2026-11-04T07:30:00-06:00', '2026-11-05T07:30:00-06:00'];
const INSTRUCTION = 'Tell me what finished overnight: background jobs, chats that finished, anything waiting for me.';

function side(extra = {}) {
  return { label: 'What finished overnight', instruction: INSTRUCTION, cadence_text: 'Weekdays at 8 AM', enabled: true,
    next_fires: FIRES, ...extra };
}
function ready(action, before, after) {
  return { schema_version: 1, state: 'ready', action, reminder_id: action === 'create' ? null : 'rem_1', before, after };
}
const CREATE = ready('create', null, side());
const UPDATE = ready('update', side(), side({ cadence_text: 'Weekdays at 7:30 AM', next_fires: LATER }));
const ENABLE = ready('enable', side({ enabled: false, next_fires: [] }), side());
const DISABLE = ready('disable', side(), side({ enabled: false, next_fires: [] }));
const CANCEL = ready('cancel', side({ label: 'Weekly tidy-up summary', cadence_text: 'Fridays at 5 PM' }), null);
function refused(reason) {
  return { schema_version: 1, state: 'refused', reason, before: null, after: null };
}

// The card formats in the same local zone and locale as the test runs in.
function shortFire(iso) {
  const at = new Date(iso);
  const tag = globalThis.jennyI18n?.tag?.();
  const day = at.toLocaleDateString(tag, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = at.toLocaleTimeString(tag, at.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
  return `${day} ${time}`;
}

function parse(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
  return dom.window.document.getElementById('root');
}

function render(extra = {}) {
  return parse(renderApprovalBlock({
    toolCallId: 'call_1', approvalId: 'approval_1', toolName: 'schedule_change', displayToolName: 'Schedule Change',
    mode: 'inline', policyScope: 'Scheduled checks', oneOffOnly: true, purpose: 'A weekday-morning summary of what finished overnight',
    commandText: 'action: create\ninstruction: MODEL TEXT', facts: [{ kind: 'write', label: 'MODEL FACT' }],
    scheduleChangeApproval: CREATE, ...extra,
  }, { escapeHtml }));
}
const facts = (root) => [...root.querySelectorAll('.tool-approval-fact')].map((item) => item.textContent);
const lines = (root) => [...root.querySelectorAll('li.tool-approval-setting')].map((item) => ({
  name: item.querySelector('.tool-approval-setting-name').textContent,
  before: item.querySelector('.tool-approval-setting-before')?.textContent ?? null,
  after: item.querySelector('.tool-approval-setting-after').textContent,
}));
const note = (root) => root.querySelector('[data-approval-schedule] .tool-approval-message-note')?.textContent ?? null;

test('create: facts, the quoted instruction, the Next line and the note, never the model text', () => {
  const root = render();
  assert.deepEqual(facts(root), ['Schedule Change', 'Scheduled checks', 'Schedule a check', 'Weekdays at 8 AM', 'Always asks before tools']);
  const block = root.querySelector('[data-approval-schedule]');
  assert.equal(block.getAttribute('data-approval-schedule'), 'create');
  assert.equal(block.querySelector('.tool-approval-schedule-instruction').textContent, INSTRUCTION);
  assert.deepEqual(lines(root), [{ name: 'Next', before: null, after: FIRES.map(shortFire).join(' · ') }]);
  assert.equal(note(root), 'It runs as a turn in this chat. Turn it off or delete it from Home, or ask Jenny.');
  assert.equal(root.querySelector('.tool-approval-command'), null);
  assert.ok(!root.textContent.includes('MODEL TEXT') && !root.textContent.includes('MODEL FACT'));
  assert.match(root.querySelector('.tool-approval-prompt').textContent, /^Jenny says/);
});

test('the Next line formats the local short form', () => {
  const previous = globalThis.jennyI18n;
  globalThis.jennyI18n = { tag: () => 'en-GB' };
  try {
    const value = render().querySelector('li.tool-approval-setting .tool-approval-setting-after').textContent;
    assert.equal(value, FIRES.map(shortFire).join(' · '));
    assert.match(value.split(' · ')[0], /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} /);
  } finally {
    globalThis.jennyI18n = previous;
  }
});

test('update: one before -> after line per changed field, then Next; the note says when the instruction stays', () => {
  const root = render({ scheduleChangeApproval: UPDATE });
  assert.deepEqual(facts(root).slice(2), ['Change a check', 'What finished overnight']);
  assert.deepEqual(lines(root), [
    { name: 'Time', before: 'Weekdays at 8 AM', after: 'Weekdays at 7:30 AM' },
    { name: 'Next', before: null, after: LATER.map(shortFire).join(' · ') },
  ]);
  assert.equal(root.querySelector('.tool-approval-setting-arrow').getAttribute('aria-hidden'), 'true');
  assert.equal(note(root), 'The instruction stays the same.');
  assert.equal(root.querySelector('.tool-approval-schedule-instruction'), null);

  const all = render({ scheduleChangeApproval: ready('update', side(),
    side({ label: 'Overnight', instruction: 'Only failures.', cadence_text: 'Daily at 9 AM' })) });
  assert.deepEqual(lines(all).map((line) => [line.name, line.before, line.after]).slice(0, 3), [
    ['Title', 'What finished overnight', 'Overnight'],
    ['Instruction', INSTRUCTION, 'Only failures.'],
    ['Time', 'Weekdays at 8 AM', 'Daily at 9 AM'],
  ]);
  assert.equal(note(all), null);
});

test('enable shows the Next line; disable and cancel show no list', () => {
  const on = render({ scheduleChangeApproval: ENABLE });
  assert.deepEqual(facts(on).slice(2), ['Turn on a check', 'What finished overnight']);
  assert.deepEqual(lines(on).map((line) => line.name), ['Next']);
  assert.equal(note(on), null);

  const off = render({ scheduleChangeApproval: DISABLE });
  assert.deepEqual(facts(off).slice(2), ['Turn off a check', 'What finished overnight']);
  assert.equal(off.querySelector('.tool-approval-settings'), null);

  const gone = render({ scheduleChangeApproval: CANCEL });
  assert.deepEqual(facts(gone).slice(2), ['Delete a check', 'Weekly tidy-up summary', 'Fridays at 5 PM']);
  assert.equal(gone.querySelector('.tool-approval-settings'), null);
  assert.equal(note(gone), 'It will not run again. Your plain reminders are not touched.');
});

test('a ready card has Allow once and Deny, never Always allow, and is decided only on its own card', () => {
  for (const approval of [CREATE, UPDATE, ENABLE, DISABLE, CANCEL]) {
    const root = render({ scheduleChangeApproval: approval, oneOffOnly: false });
    assert.ok(root.querySelector('[data-approval-scope="once"]'), approval.action);
    assert.ok(root.querySelector('[data-action="deny"]'), approval.action);
    assert.equal(root.querySelector('[data-approval-scope="always"]'), null, approval.action);
    assert.equal(root.querySelector('.approval-gap-row').getAttribute('data-approval-exact'), 'true', approval.action);
  }
});

test('hostile text stays text and invisible controls show as markers', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const root = render({ scheduleChangeApproval: ready('create', null, side({ label: hostile, instruction: `${hostile}‮evil`, cadence_text: hostile })) });
  assert.equal(root.querySelector('img'), null);
  const quoted = root.querySelector('.tool-approval-schedule-instruction');
  assert.ok(quoted.textContent.startsWith(hostile));
  assert.equal(quoted.querySelector('.tool-approval-invisible').textContent, '⟨U+202E⟩');
});

test('a refused change names why in a plain sentence and offers only Deny', () => {
  const texts = new Set();
  for (const reason of ['invalid_input', 'not_found', 'not_a_check', 'limit_reached', 'denied', 'disabled']) {
    const root = render({ scheduleChangeApproval: refused(reason) });
    const sentence = root.querySelector('[data-approval-schedule-unavailable]');
    assert.equal(sentence.getAttribute('data-approval-schedule-unavailable'), reason);
    texts.add(sentence.textContent);
    assert.equal(root.querySelector('[data-approval-scope]'), null, `${reason}: no Allow of any scope`);
    assert.ok(root.querySelector('[data-action="deny"]'));
    assert.equal(root.querySelector('.approval-gap-row').getAttribute('data-approval-exact'), 'true');
    assert.equal(root.querySelector('li.tool-approval-setting'), null);
    assert.deepEqual(facts(root), ['Schedule Change', 'Scheduled checks']);
  }
  assert.equal(texts.size, 6);
  assert.equal(render({ scheduleChangeApproval: refused('stale') })
    .querySelector('[data-approval-schedule-unavailable]').getAttribute('data-approval-schedule-unavailable'), 'other');
});

test('a missing or malformed approval fails closed: no Allow, no partial card', () => {
  const cases = {
    missing: undefined,
    schema_2: { ...CREATE, schema_version: 2 },
    bad_action: { ...CREATE, action: 'run' },
    create_with_before: ready('create', side(), side()),
    create_without_after: ready('create', null, null),
    cancel_with_after: ready('cancel', side(), side()),
    update_without_before: ready('update', null, side()),
    no_instruction: ready('create', null, side({ instruction: '' })),
    no_cadence: ready('create', null, side({ cadence_text: '   ' })),
    no_label: ready('disable', side({ label: '' }), side({ label: '', enabled: false })),
    side_not_object: ready('enable', 'x', side()),
    bad_state: { ...CREATE, state: 'bogus' },
    not_an_object: 'ready',
  };
  for (const [name, value] of Object.entries(cases)) {
    const root = render({ scheduleChangeApproval: value });
    const sentence = root.querySelector('[data-approval-schedule-unavailable]');
    assert.ok(sentence, name);
    assert.equal(sentence.getAttribute('data-approval-schedule-unavailable'), 'missing', name);
    assert.equal(root.querySelector('li.tool-approval-setting'), null, name);
    assert.equal(root.querySelector('[data-approval-scope]'), null, `${name}: no Allow`);
    assert.ok(root.querySelector('[data-action="deny"]'), name);
  }
  assert.equal(normalizeScheduleChangeApproval(cases.bad_action), null);
  assert.deepEqual(normalizeScheduleChangeApproval(refused('bogus')), { state: 'refused', reason: 'other' });
  // Unparseable fire times are dropped, and at most three show.
  const fires = normalizeScheduleChangeApproval(ready('create', null, side({ next_fires: ['nope', ...FIRES, '2026-11-06T08:00:00-06:00', 7] })));
  assert.deepEqual(fires.after.nextFires, FIRES);
});

test('the receipt names the change and the check, never the model input', () => {
  const receipt = (extra) => render({ cardState: 'resolved', ...extra }).querySelector('.tool-approval-receipt-subject').textContent;
  assert.equal(receipt({ decision: 'allowed' }), 'Schedule a check: What finished overnight');
  assert.equal(receipt({ decision: 'denied', scheduleChangeApproval: CANCEL }), 'Delete a check: Weekly tidy-up summary');
  assert.equal(receipt({ decision: 'allowed', scheduleChangeApproval: refused('not_found') }), 'Schedule Change');
  assert.equal(receipt({ decision: 'allowed', scheduleChangeApproval: undefined }), 'Schedule Change');
});

test('the turn-row gap, the live reducer and the hydrated projector all carry the approval to the card', () => {
  const renderer = createTurnRowToolRenderUtils({
    escapeHtml, normalizeId: (value) => String(value || '').trim(), formatDurationMs: () => '',
    renderArtifactTeaser: () => '', buildToolMarkerBannerMarkup: () => '', renderApprovalBlock,
    getApprovalCardState: () => ({ state: 'live' }),
  });
  const html = renderer.buildApprovalGapMarkup({ kind: 'approval_gap', row_id: 'gap_1', turn_id: 'turn_1', tool_call_id: 'call_1',
    payload: { tool_call_id: 'call_1', tool_name: 'schedule_change', state: 'awaiting_approval', approval_id: 'approval_1',
      policy_scope: 'Scheduled checks', one_off_only: true, input: { action: 'update' }, schedule_change_approval: UPDATE } }, [], { sessionId: 'sess_1' });
  const root = parse(html);
  assert.equal(root.querySelectorAll('li.tool-approval-setting').length, 2);
  assert.ok(root.querySelector('[data-approval-scope="once"]'));
  assert.equal(root.querySelector('[data-approval-scope="always"]'), null);

  const state = createTurnReducerState();
  const context = { turn_id: 'stream-sc', primary_user_message_id: 'u', primary_assistant_message_id: 'a', primary_tool_message_id: 'tool_use_call-sc' };
  let ordinal = 0;
  const apply = (payload) => {
    applyTurnStreamEvent(state, buildTurnEventFromStreamPayload(payload, { ...context, ordinal }));
    ordinal += 1;
    return state.turns_by_id['stream-sc'];
  };
  apply({ type: 'started', streamId: 'stream-sc' });
  apply({ type: 'tool_use', streamId: 'stream-sc', callId: 'call-sc', toolName: 'schedule_change', status: 'pending_approval', input: { action: 'create' } });
  const turn = apply({ type: 'tool_approval_needed', streamId: 'stream-sc', callId: 'call-sc', toolName: 'schedule_change',
    input: { action: 'create' }, schedule_change_approval: CREATE });
  const liveGap = turn.rows.find((item) => item.kind === 'approval_gap' && item.tool_call_id === 'call-sc');
  assert.deepEqual(liveGap.payload.schedule_change_approval, CREATE);

  // The approval arriving first creates the gap row with it.
  const early = createTurnReducerState();
  applyTurnStreamEvent(early, buildTurnEventFromStreamPayload({ type: 'started', streamId: 'stream-sc' }, { ...context, ordinal: 0 }));
  applyTurnStreamEvent(early, buildTurnEventFromStreamPayload({ type: 'tool_approval_needed', streamId: 'stream-sc', callId: 'call-sc',
    toolName: 'schedule_change', input: { action: 'create' }, schedule_change_approval: CREATE }, { ...context, ordinal: 1 }));
  const earlyGap = early.turns_by_id['stream-sc'].rows.find((item) => item.kind === 'approval_gap');
  assert.deepEqual(earlyGap.payload.schedule_change_approval, CREATE);

  const events = [
    { event_id: 'sc:tool_use', turn_id: 'turn_sc', kind: 'tool_use', primary_message_id: 'tool_use_sc', source_message_ids: ['tool_use_sc'], sort_key: [0, 0, 40], tool_call_id: 'call_sc', status: 'pending_approval', payload: { tool_name: 'schedule_change', input: { action: 'create' }, schedule_change_approval: CREATE } },
    { event_id: 'sc:approval_requested', turn_id: 'turn_sc', kind: 'approval_requested', primary_message_id: 'tool_use_sc', source_message_ids: ['tool_use_sc'], sort_key: [0, 1, 45], tool_call_id: 'call_sc', status: 'pending_approval', payload: { approval_state: 'pending' } },
  ];
  assert.deepEqual(projectTurnRows(events).find((item) => item.kind === 'approval_gap').payload.schedule_change_approval, CREATE);

  // The approval can also ride only the canonical approval_requested event.
  const lateEvents = [{ ...events[0], payload: { tool_name: 'schedule_change', input: { action: 'create' } } },
    { ...events[1], payload: { approval_state: 'pending', schedule_change_approval: CREATE } }];
  assert.deepEqual(projectTurnRows(lateEvents).find((item) => item.kind === 'approval_gap').payload.schedule_change_approval, CREATE);
});

test('the live approval entry keeps the approval', async () => {
  const harness = createToolHandlerHarness({ initialToolName: 'schedule_change' });
  await harness.handlers.handleApprovalNeeded({ sessionId: 'session-1', streamId: 'stream-1', type: 'tool_approval_needed',
    callId: 'call-1', approvalId: 'approval-1', toolName: 'schedule_change', input: { action: 'create' }, schedule_change_approval: CREATE });
  assert.deepEqual(harness.state.pendingToolApprovals.get('approval-1').scheduleChangeApproval, CREATE);
});

test('the "Needs you" row names the app reading, never the model input, and has no Allow', () => {
  const rowFor = (entry) => buildAttentionInbox({
    sessions: [{ id: 'sess_primary', title: 'Jenny' }],
    pendingToolApprovals: new Map([['a1', { approvalId: 'a1', callId: 'c1', sessionId: 'sess_primary', toolName: 'schedule_change',
      input: { action: 'create', instruction: 'MODEL TEXT' }, policyScope: 'Scheduled checks', oneOffOnly: true, ...entry }]]),
    facts: toolApprovalFacts,
  }).rows.find((item) => item.kind === 'approval');
  assert.equal(rowFor({ scheduleChangeApproval: CREATE }).preview, 'Schedule a check: What finished overnight');
  assert.equal(rowFor({ scheduleChangeApproval: CANCEL }).preview, 'Delete a check: Weekly tidy-up summary');
  for (const entry of [{}, { scheduleChangeApproval: refused('not_found') }]) {
    const row = rowFor(entry);
    assert.equal(row.preview, 'Change a scheduled check');
    assert.deepEqual(row.facts, []);
  }
  for (const entry of [{ scheduleChangeApproval: CREATE }, { scheduleChangeApproval: refused('not_found') }, {}]) {
    assert.equal(rowFor(entry).canAllow, false, 'approved only on the card');
  }
});
