'use strict';

// "Jenny took a note" (agentic memory v2, row 58 W2): a reflection run appends
// one standalone `memory_note` message holding its saved notes after the chat
// went idle. It must render as the memory chip with a working Undo in a reopened
// chat, whether the chat's turns come from the persisted event log or from its
// messages alone, and even when the artifact surface was never built. Gate
// finding G1 (2026-10-15): the old tool_result receipt was stored but never
// rendered. A run with several notes folds them under one row.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const SESSION_ID = 'session-notes';
const STREAM_ID = 'stream_notes_1';
const operationId = index => `reflect:${SESSION_ID}:0123456789abcdef:${index}`;
const PREVIEWS = ['Staging host is atlas-2.', 'Deploys go out on Thursdays.', 'Prefers tabs over spaces.', 'Uses pnpm.'];
const KINDS = ['fact', 'routine', 'preference', 'convention'];

function chatSession() {
  return {
    id: SESSION_ID, title: 'Orbit', session_type: 'chat', conversation_mode: 'chat', preferred_model: 'gpt-test',
    reasoning_effort: 'default', plan_mode: false, pinned: false, archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [], interactive_round_count: 0, interactive_sequence_state: 'idle',
    pending_question_batch: null, message_count: 3, updated_at: new Date().toISOString(),
  };
}

function note(index) {
  return { result_kind: 'memory', action: 'remember', status: 'saved', memory_id: index + 1,
    operation_id: operationId(index), scope: 'project', kind: KINDS[index], undoable: true,
    text_preview: PREVIEWS[index], origin: 'reflection' };
}

function messages(noteCount) {
  const at = new Date(Date.now() - 60_000).toISOString();
  return [
    { id: `user_${STREAM_ID}`, role: 'user', content: 'My staging host is atlas-2.', status: 'complete', timestamp: at },
    { id: `assistant_${STREAM_ID}`, role: 'assistant', content: 'Noted, atlas-2 for staging.', status: 'complete',
      timestamp: at, finalizedAt: at, streamId: STREAM_ID },
    { id: 'memory_note_reflect_note_0', role: 'assistant', kind: 'memory_note', content: '', status: 'complete',
      timestamp: new Date().toISOString(), finalizedAt: new Date().toISOString(),
      memory_notes: Array.from({ length: noteCount }, (_, index) => note(index)) },
  ];
}

function turnEvents() {
  return [
    { event_id: `${STREAM_ID}:user_prompt:0`, event_seq: 0, turn_id: STREAM_ID, kind: 'user_prompt',
      primary_message_id: `user_${STREAM_ID}`, primary_user_message_id: `user_${STREAM_ID}`,
      source_message_ids: [`user_${STREAM_ID}`], payload: { content: 'My staging host is atlas-2.' } },
    { event_id: `${STREAM_ID}:assistant_text_segment:0`, event_seq: 1, turn_id: STREAM_ID, kind: 'assistant_text_segment',
      status: 'completed', primary_message_id: `assistant_${STREAM_ID}`, primary_assistant_message_id: `assistant_${STREAM_ID}`,
      source_message_ids: [`assistant_${STREAM_ID}`], segment_group_index: 0, phase_id: 'phase-notes-0',
      payload: { segment_id: 'segment-notes-0', phase_id: 'phase-notes-0', text: 'Noted, atlas-2 for staging.', segment_index: 0 } },
  ];
}

async function openChat(t, payload) {
  const app = await loadRendererApp({ shell: {
    sessions: [chatSession()],
    workspaceState: { activeSessionId: SESSION_ID, openSessionIds: [SESSION_ID] },
    sessionMessagePayloads: { [SESSION_ID]: payload },
  } });
  t.after(() => app.dispose());
  await waitForUi(app.window, 150);
  return app;
}

const text = node => node.textContent.replace(/\s+/g, ' ');

async function assertUndo(app, row, index) {
  const { window } = app;
  const calls = [];
  window.jennyShell.memory = { ...(window.jennyShell.memory || {}),
    undo: async (request) => { calls.push(request); return { status: 'saved', operation_id: 'ui:1', undoable: false }; } };
  const undo = row.querySelector('[data-memory-undo]');
  assert.ok(undo, 'the note offers Undo');
  undo.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(JSON.stringify(calls), JSON.stringify([{ sessionId: SESSION_ID, operationId: operationId(index) }]));
  assert.ok(row.ownerDocument.querySelector(`[data-memory-operation="${operationId(index)}"] .notes-chat__undone`),
    'Undo settles in place');
}

async function assertNoteWithUndo(app) {
  const timeline = app.window.document.getElementById('chatTimeline');
  const row = timeline.querySelector(`[data-memory-operation="${operationId(0)}"]`);
  assert.ok(row, 'the memory note renders in its chat');
  assert.match(text(row), /Jenny took a note/);
  assert.match(text(row), /Fact · This project · Staging host is atlas-2\./);
  assert.equal(timeline.querySelectorAll('[data-memory-operation]').length, 1, 'one note, rendered once');
  assert.equal(timeline.querySelector('[data-memory-notes-group]'), null, 'a single note is not folded');
  assert.equal(row.closest('article').querySelector('.chat-hover-row'), null, 'a note has no reply actions');
  assert.match(timeline.textContent, /Noted, atlas-2 for staging\./, 'the reply still renders');
  await assertUndo(app, row, 0);
}

test('a reflection note renders with Undo in a chat built from its messages', async (t) => {
  const app = await openChat(t, { data: messages(1) });
  await assertNoteWithUndo(app);
});

test('a reflection note renders with Undo in a chat with a persisted event log', async (t) => {
  const app = await openChat(t, { data: messages(1), turn_event_log_version: 4, turn_events: turnEvents(), active_turn: null });
  await assertNoteWithUndo(app);
});

test('a run that took several notes folds them under one row that opens to each note with Undo', async (t) => {
  const app = await openChat(t, { data: messages(4), turn_event_log_version: 4, turn_events: turnEvents(), active_turn: null });
  const { window } = app;
  const timeline = window.document.getElementById('chatTimeline');
  const groups = timeline.querySelectorAll('[data-memory-notes-group]');
  assert.equal(groups.length, 1, 'one row for the run');
  const header = groups[0].querySelector('[data-inv-collapsible]');
  assert.equal(header.getAttribute('aria-expanded'), 'false', 'folded by default');
  assert.equal(header.getAttribute('role'), 'button');
  assert.match(text(header), /Jenny took 4 notes/);
  assert.match(text(header), /Staging host is atlas-2\. · Deploys go out on Thursdays\./);
  assert.equal(header.querySelector('[data-memory-undo]'), null, 'the summary row has no Undo of its own');
  const panel = window.document.getElementById(header.getAttribute('aria-controls'));
  assert.ok(panel.hidden, 'the notes stay out of the timeline until opened');
  assert.equal(panel.querySelectorAll('[data-memory-operation]').length, 4);
  assert.equal(groups[0].closest('article').querySelector('.chat-hover-row'), null);

  header.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.hidden, false);
  const second = panel.querySelector(`[data-memory-operation="${operationId(1)}"]`);
  assert.match(text(second), /^Routine ?This project · Deploys go out on Thursdays\./, 'each note leads with its kind');
  assert.doesNotMatch(text(panel), /Jenny took a note/, 'the header already says who took them');
  const rebuilt = window.rendererMemoryChatEntry.buildMemoryNotesMarkup(messages(4)[2].memory_notes,
    { groupId: 'memory_note_reflect_note_0', sessionId: SESSION_ID });
  assert.match(rebuilt, /aria-expanded="true"/, 'an opened group stays open when the timeline re-renders it');

  await assertUndo(app, second, 1);
  assert.equal(header.getAttribute('aria-expanded'), 'true', 'Undo inside the group leaves it open');
  assert.ok(panel.querySelector(`[data-memory-operation="${operationId(0)}"] [data-memory-undo]`), 'the other notes keep Undo');
});
