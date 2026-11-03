'use strict';

// Row 88 (owner design "A1 lines"): the settings_change approval card shows the app's own reading of
// the change (setting name, before -> after) from `settings_change_approval`, never the model's input.
// A change the app could not read, refused, or that arrived malformed has no Allow and no batch
// approval; Always allow never renders for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock, normalizeSettingsChangeApproval } = require('../renderer/chat/renderer-approval-block');
const toolApprovalFacts = require('../renderer/chat/tool-call-utils');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { buildTurnEventFromStreamPayload, createTurnReducerState, applyTurnStreamEvent } = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('./helpers/renderer-turn-row-projector-helpers');
const { buildAttentionInbox } = require('../renderer/shell/renderer-attention-inbox-model');
const { createToolHandlerHarness } = require('./helpers/stream-tool-handler-harness');

function row(key, before, after, extra = {}) {
  return { key, label: key, label_key: `primarySettings.key.${key}`, kind: 'enum', before, after,
    before_label: String(before), after_label: String(after), ...extra };
}

const RUN_MODE = row('default_run_mode', 'ask', 'plan', { before_label: 'IGNORED-A', after_label: 'IGNORED-B' });
const ZOOM = row('app_zoom_percent', 100, 125, { kind: 'number', before_label: '100', after_label: '125' });
const TIME = row('time_format_24h', false, true, { kind: 'boolean' });
const SIZE = row('editor_font_size', 13, 15, { kind: 'number' });
const TAB = row('editor_tab_size', 2, 4, { kind: 'number' });

function ready(rows = [RUN_MODE]) {
  return { schema_version: 1, state: 'ready', rows };
}
function refused(reason, extra = {}) {
  return { schema_version: 1, state: 'refused', reason, rows: [], ...extra };
}

function parse(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
  return dom.window.document.getElementById('root');
}

function render(extra = {}) {
  return parse(renderApprovalBlock({
    toolCallId: 'call_1', approvalId: 'approval_1', toolName: 'settings_change', displayToolName: 'Settings Change',
    mode: 'inline', policyScope: 'App settings', oneOffOnly: true, purpose: 'The user asked for plan mode and a bigger zoom.',
    commandText: 'changes: [{"key":"default_run_mode","value":"plan"}]', settingsChangeApproval: ready(), ...extra,
  }, { escapeHtml }));
}

test('a ready card lists each setting as name, before, arrow, after, with the app\'s own words', () => {
  const root = render({ settingsChangeApproval: ready([RUN_MODE, ZOOM, TIME]) });
  const block = root.querySelector('[data-approval-settings]');
  assert.equal(block.getAttribute('data-approval-settings'), 'ready');
  const items = [...block.querySelectorAll('li.tool-approval-setting')];
  assert.equal(items.length, 3);
  const read = (item) => ({
    name: item.querySelector('.tool-approval-setting-name').textContent,
    before: item.querySelector('.tool-approval-setting-before').textContent,
    after: item.querySelector('.tool-approval-setting-after').textContent,
  });
  assert.deepEqual(read(items[0]), { name: 'Default run mode', before: 'Ask', after: 'Plan' });
  assert.deepEqual(read(items[1]), { name: 'App zoom', before: '100%', after: '125%' });
  assert.deepEqual(read(items[2]), { name: '24-hour time', before: 'Off', after: 'On' });
  const change = items[1].querySelector('.tool-approval-setting-change');
  assert.equal(change.querySelector('.tool-approval-setting-arrow').getAttribute('aria-hidden'), 'true');
  assert.equal(change.querySelector('.sr-only').textContent, ' to ');
  assert.equal(root.querySelector('.tool-approval-command'), null);
  assert.ok(!root.textContent.includes('"key"'), 'the model\'s input text is not shown');
  assert.equal(root.querySelector('[data-approval-fact="scope"]').textContent, 'App settings');
  assert.equal(root.querySelector('[data-approval-fact="settings"]').textContent, '3 settings');
  assert.match(root.querySelector('.tool-approval-prompt').textContent, /^Jenny says/);
});

test('the note and the count chip follow the number of rows', () => {
  const note = (rows) => render({ settingsChangeApproval: ready(rows) }).querySelector('.tool-approval-message-note').textContent;
  assert.equal(note([RUN_MODE]), 'You can undo this from Activity.');
  assert.equal(note([RUN_MODE, ZOOM]), 'Both change together, or neither does. You can undo this from Activity.');
  assert.equal(note([RUN_MODE, ZOOM, TIME, SIZE, TAB]), 'All 5 change together, or none does. You can undo this from Activity.');
  assert.equal(render().querySelector('[data-approval-fact="settings"]').textContent, '1 setting');
  assert.equal(render({ settingsChangeApproval: ready([RUN_MODE, ZOOM]) })
    .querySelector('[data-approval-fact="settings"]').textContent, '2 settings');
});

test('a ready card has Allow once and Deny, never Always allow, and is decided only on its own card', () => {
  const root = render();
  assert.ok(root.querySelector('[data-approval-scope="once"]'));
  assert.ok(root.querySelector('[data-action="deny"]'));
  assert.equal(root.querySelector('[data-approval-scope="always"]'), null);
  assert.equal(root.querySelector('.approval-gap-row').getAttribute('data-approval-exact'), 'true');
  // Independent of oneOffOnly.
  assert.equal(render({ oneOffOnly: false }).querySelector('[data-approval-scope="always"]'), null);
});

test('hostile labels stay text', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const root = render({ settingsChangeApproval: ready([row('palette', 'a', 'b', { before_label: hostile, after_label: hostile })]) });
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('.tool-approval-setting-before').textContent, hostile);
  assert.equal(root.querySelector('.tool-approval-setting-after').textContent, hostile);
});

test('a refused change names why and offers only Deny', () => {
  const texts = new Set();
  for (const [reason, expected] of [
    ['not_allowed', /can.t change that setting/], ['invalid_value', /isn.t one this setting takes/],
    ['unchanged', /Nothing would change/], ['unavailable', /couldn.t read these settings/],
  ]) {
    const root = render({ settingsChangeApproval: refused(reason, { key: 'palette' }) });
    const note = root.querySelector('[data-approval-settings-unavailable]');
    assert.equal(note.getAttribute('data-approval-settings-unavailable'), reason);
    assert.match(note.textContent, expected);
    texts.add(note.textContent);
    assert.equal(root.querySelector('[data-approval-scope]'), null, `${reason}: no Allow of any scope`);
    assert.ok(root.querySelector('[data-action="deny"]'));
    assert.equal(root.querySelector('.approval-gap-row').getAttribute('data-approval-exact'), 'true');
    assert.equal(root.querySelector('li.tool-approval-setting'), null);
    assert.equal(root.querySelector('[data-approval-fact="settings"]'), null);
    assert.equal(root.querySelector('.tool-approval-command'), null);
  }
  assert.equal(texts.size, 4);
  const other = render({ settingsChangeApproval: refused('stale') }).querySelector('[data-approval-settings-unavailable]');
  assert.equal(other.getAttribute('data-approval-settings-unavailable'), 'other');
  assert.match(other.textContent, /This change can.t be shown/);
});

test('a missing or malformed approval fails closed: no Allow, no partial card', () => {
  const sixRows = Array.from({ length: 6 }, (_unused, index) => row('editor_font_size', 10 + index, 20 + index));
  const cases = {
    missing: undefined,
    unknown_key: ready([RUN_MODE, row('shell_path', 'a', 'b')]),
    six_rows: ready(sixRows),
    zero_rows: ready([]),
    schema_2: { ...ready(), schema_version: 2 },
    object_value: ready([RUN_MODE, row('palette', 'a', { x: 1 }, { after_label: '' })]),
    bad_state: { schema_version: 1, state: 'bogus', rows: [RUN_MODE] },
    not_an_object: 'ready',
  };
  for (const [name, value] of Object.entries(cases)) {
    const root = render({ settingsChangeApproval: value });
    const note = root.querySelector('[data-approval-settings-unavailable]');
    assert.ok(note, name);
    assert.equal(note.getAttribute('data-approval-settings-unavailable'), 'missing', name);
    assert.equal(root.querySelector('li.tool-approval-setting'), null, name);
    assert.equal(root.querySelector('[data-approval-scope]'), null, `${name}: no Allow`);
    assert.ok(root.querySelector('[data-action="deny"]'), name);
    assert.equal(root.querySelector('.approval-gap-row').getAttribute('data-approval-exact'), 'true', name);
  }
  assert.equal(normalizeSettingsChangeApproval(ready()).rows[0].name, 'Default run mode');
  assert.equal(normalizeSettingsChangeApproval(cases.unknown_key), null);
  assert.deepEqual(normalizeSettingsChangeApproval(refused('bogus')), { state: 'refused', reason: 'other' });
  assert.deepEqual(normalizeSettingsChangeApproval(refused('unchanged')), { state: 'refused', reason: 'unchanged' });
});

test('the receipt says how many settings changed or would have', () => {
  const receipt = (extra) => render({ cardState: 'resolved', ...extra }).querySelector('.tool-approval-receipt-subject').textContent;
  assert.equal(receipt({ decision: 'allowed' }), 'Changed 1 setting');
  assert.equal(receipt({ decision: 'allowed', settingsChangeApproval: ready([RUN_MODE, ZOOM]) }), 'Changed 2 settings');
  assert.equal(receipt({ decision: 'denied' }), 'Change 1 setting');
  assert.equal(receipt({ decision: 'denied', settingsChangeApproval: ready([RUN_MODE, ZOOM, TIME]) }), 'Change 3 settings');
  assert.equal(receipt({ decision: 'allowed', settingsChangeApproval: undefined, commandText: '' }), 'Settings Change');
  assert.equal(receipt({ decision: 'allowed', settingsChangeApproval: refused('unchanged'), commandText: '' }), 'Settings Change');
});

test('the turn-row gap, the live reducer and the hydrated projector all carry the approval to the card', () => {
  const renderer = createTurnRowToolRenderUtils({
    escapeHtml, normalizeId: (value) => String(value || '').trim(), formatDurationMs: () => '',
    renderArtifactTeaser: () => '', buildToolMarkerBannerMarkup: () => '', renderApprovalBlock,
    getApprovalCardState: () => ({ state: 'live' }),
  });
  const approval = ready([RUN_MODE, ZOOM]);
  const html = renderer.buildApprovalGapMarkup({ kind: 'approval_gap', row_id: 'gap_1', turn_id: 'turn_1', tool_call_id: 'call_1',
    payload: { tool_call_id: 'call_1', tool_name: 'settings_change', state: 'awaiting_approval', approval_id: 'approval_1',
      policy_scope: 'App settings', one_off_only: true, input: { changes: [] }, settings_change_approval: approval } }, [], { sessionId: 'sess_1' });
  const root = parse(html);
  assert.equal(root.querySelectorAll('li.tool-approval-setting').length, 2);
  assert.equal(root.querySelector('[data-approval-scope="always"]'), null);

  const state = createTurnReducerState();
  const context = { turn_id: 'stream-ss', primary_user_message_id: 'u', primary_assistant_message_id: 'a', primary_tool_message_id: 'tool_use_call-ss' };
  let ordinal = 0;
  const apply = (payload) => {
    applyTurnStreamEvent(state, buildTurnEventFromStreamPayload(payload, { ...context, ordinal }));
    ordinal += 1;
    return state.turns_by_id['stream-ss'];
  };
  apply({ type: 'started', streamId: 'stream-ss' });
  apply({ type: 'tool_use', streamId: 'stream-ss', callId: 'call-ss', toolName: 'settings_change', status: 'pending_approval', input: { changes: [] } });
  const turn = apply({ type: 'tool_approval_needed', streamId: 'stream-ss', callId: 'call-ss', toolName: 'settings_change',
    input: { changes: [] }, settings_change_approval: approval });
  const liveGap = turn.rows.find((item) => item.kind === 'approval_gap' && item.tool_call_id === 'call-ss');
  assert.deepEqual(liveGap.payload.settings_change_approval, approval);

  const events = [
    { event_id: 'ss:tool_use', turn_id: 'turn_ss', kind: 'tool_use', primary_message_id: 'tool_use_ss', source_message_ids: ['tool_use_ss'], sort_key: [0, 0, 40], tool_call_id: 'call_ss', status: 'pending_approval', payload: { tool_name: 'settings_change', input: { changes: [] }, settings_change_approval: approval } },
    { event_id: 'ss:approval_requested', turn_id: 'turn_ss', kind: 'approval_requested', primary_message_id: 'tool_use_ss', source_message_ids: ['tool_use_ss'], sort_key: [0, 1, 45], tool_call_id: 'call_ss', status: 'pending_approval', payload: { approval_state: 'pending' } },
  ];
  const hydrated = projectTurnRows(events).find((item) => item.kind === 'approval_gap');
  assert.deepEqual(hydrated.payload.settings_change_approval, approval);

  // The approval can also ride only the canonical approval_requested event.
  const lateEvents = [events[0], { ...events[1], payload: { approval_state: 'pending', settings_change_approval: approval } }];
  lateEvents[0] = { ...events[0], payload: { tool_name: 'settings_change', input: { changes: [] } } };
  const lateHydrated = projectTurnRows(lateEvents).find((item) => item.kind === 'approval_gap');
  assert.deepEqual(lateHydrated.payload.settings_change_approval, approval);
});

test('the live approval entry keeps the approval for the "Needs you" row, only for settings_change', async () => {
  const harness = createToolHandlerHarness({ initialToolName: 'settings_change' });
  const base = { sessionId: 'session-1', streamId: 'stream-1', type: 'tool_approval_needed' };
  const approval = ready([RUN_MODE]);
  await harness.handlers.handleApprovalNeeded({ ...base, callId: 'call-1', approvalId: 'approval-1', toolName: 'settings_change',
    input: { changes: [] }, settings_change_approval: approval });
  assert.deepEqual(harness.state.pendingToolApprovals.get('approval-1').settingsChangeApproval, approval);
});

test('the "Needs you" row reads "Change N settings" for a ready change, else the default preview', () => {
  const model = (entry) => buildAttentionInbox({
    sessions: [{ id: 'sess_primary', title: 'Jenny' }],
    pendingToolApprovals: new Map([['a1', { approvalId: 'a1', callId: 'c1', sessionId: 'sess_primary', toolName: 'settings_change',
      input: { changes: [{ key: 'default_run_mode', value: 'plan' }] }, policyScope: 'App settings', oneOffOnly: true, ...entry }]]),
    facts: toolApprovalFacts,
  });
  const preview = (entry) => model(entry).rows.find((item) => item.kind === 'approval').preview;
  assert.equal(preview({ settingsChangeApproval: ready([RUN_MODE]) }), 'Change 1 setting');
  assert.equal(preview({ settingsChangeApproval: ready([RUN_MODE, ZOOM]) }), 'Change 2 settings');
  const fallback = preview({});
  assert.ok(!/^Change \d/.test(fallback));
  assert.equal(preview({ settingsChangeApproval: refused('unchanged') }), fallback);
  assert.equal(preview({ settingsChangeApproval: ready([RUN_MODE, row('shell_path', 'a', 'b')]) }), fallback);
  const canAllow = (entry) => model(entry).rows.find((item) => item.kind === 'approval').canAllow;
  assert.equal(canAllow({ settingsChangeApproval: ready([RUN_MODE]) }), false, 'approved only on the card, where the rows are');
  assert.equal(canAllow({ settingsChangeApproval: refused('unchanged') }), false, 'no Allow in the inbox for a card with none');
  assert.equal(canAllow({}), false, 'a missing reading has no Allow either');
});
