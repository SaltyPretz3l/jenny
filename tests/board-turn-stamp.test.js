'use strict';

// new-test-file: a new surface (the turn's board stamp, row 150 slice C1, plan section 7.1 and session schema 29).
// A turn typed in the composer docked beside a board carries that board's id; the main process believes it only for
// a live board of the chat's own project; it is stored on the user message, survives an edit and a regenerate,
// and never reaches the sidecar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ids = require('../services/boards/board-ids');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');
const stamp = require('../services/boards/board-turn-stamp');
const { normalizeMessageFields } = require('../services/backend/message-normalization');
const { migrateStorePayload, STORE_SCHEMA_VERSION } = require('../services/backend/session-store-migrations');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { stripUnknownImportedMessageKeys } = require('../services/backend/session-import-message-bounds');
const { prepareLocalEngineChatRequest } = require('../services/backend/local-engine-requests');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { validateChatStartPayload } = require('../services/backend/generated-chat-lifecycle-contract');
const { normalizeSubmission } = require('../services/session-runtime/submission-contract');
const live = require('../renderer/chat/renderer-chat-surface-live-utils');
const { createTranscriptAttachmentsRenderer } = require('../renderer/chat/renderer-transcript-attachments');
const { createControllerHarness } = require('./helpers/send-controller-harness');
const { buildManagedChatRequest, createManagedChatServiceStub } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { createAdapterHarness } = require('./helpers/session-runtime-chat-adapter-harness');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = `board_${uid(1)}`;
const OTHER = `board_${uid(2)}`;
const ALPHA = 'project_alpha';
const BAD_STAMPS = ['board_1', 'board_ABCDEF00-0000-4000-8000-000000000001', ` ${B}`, `${B} `, `${B}0`, { id: B }, [B], 7, true];

/* ------------------------------------------------------------------ the rule and schema 29 */

test('a stamp is a board id on a user row and nothing else', () => {
  assert.equal(stamp.messageBoardStampFor('user', B), B);
  for (const role of ['assistant', 'system', 'tool', 'context']) assert.equal(stamp.messageBoardStampFor(role, B), null, role);
  for (const bad of [...BAD_STAMPS, null, undefined, '']) assert.equal(stamp.messageBoardStampFor('user', bad), null, JSON.stringify(bad));
});

test('normalization keeps the stamp on a user row only and drops every other shape', () => {
  const user = (extra) => normalizeMessageFields({ id: 'u', role: 'user', content: 'hi', ...extra });
  assert.equal(user({ board_id: B }).board_id, B);
  assert.equal(Object.hasOwn(user({}), 'board_id'), false, 'an unstamped message gains no key');
  for (const bad of BAD_STAMPS) assert.equal(Object.hasOwn(user({ board_id: bad }), 'board_id'), false, JSON.stringify(bad));
  assert.equal(Object.hasOwn(normalizeMessageFields({ id: 'a', role: 'assistant', content: 'ok', board_id: B }), 'board_id'), false);
});

test('schema 29: the step removes a stamp that is not valid and leaves every other message as it was', () => {
  assert.equal(STORE_SCHEMA_VERSION, 29);
  const keep = { id: 'u1', role: 'user', content: 'a', board_id: B };
  const plain = { id: 'u2', role: 'user', content: 'b' };
  const session = { id: 's', linked_session_ids: [], messages: [keep, plain,
    { id: 'a1', role: 'assistant', content: 'c', board_id: B }, { id: 'u3', role: 'user', content: 'd', board_id: 'board_x' }] };
  const repaired = stamp.repairSessionForV29(session);
  assert.equal(repaired.messages[0], keep, 'a valid stamp stays, same object');
  assert.equal(repaired.messages[1], plain);
  assert.deepEqual(repaired.messages.slice(2), [{ id: 'a1', role: 'assistant', content: 'c' }, { id: 'u3', role: 'user', content: 'd' }]);
  assert.deepEqual(stamp.repairSessionForV29({ id: 's' }), { id: 's' });
  const payload = { schema_version: 28, sessions: { s: session } };
  const before = JSON.stringify(payload);
  const migrated = migrateStorePayload(payload);
  assert.equal(JSON.stringify(payload), before, 'the input is not mutated');
  assert.equal(migrated.schema_version, 29);
  assert.deepEqual(migrated.sessions.s.messages.map((row) => row.board_id ?? null), [B, null, null, null]);
});

function sessionStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-stamp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const open = () => new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  return { root, sessions: open(), open };
}

test('a stamp survives a save and a reload, an edit and a regenerate; import does not bring one', (t) => {
  const { sessions, open } = sessionStore(t);
  const id = sessions.createSession({ title: 'Board chat' }).id;
  sessions.appendMessage(id, { id: 'u_1', role: 'user', content: 'add a card', board_id: B });
  sessions.appendMessage(id, { id: 'a_1', role: 'assistant', content: 'done', board_id: B });
  sessions.appendMessage(id, { id: 'u_bad', role: 'user', content: 'forged', board_id: 'board_nope' });
  assert.equal(stamp.storedBoardStamp(sessions, id, 'u_1'), B);
  assert.equal(stamp.storedBoardStamp(sessions, id, 'a_1'), null);
  assert.equal(stamp.storedBoardStamp(sessions, id, 'missing'), null);
  sessions.flushSession(id);
  sessions.dispose();
  const reopened = open();
  const rows = Object.fromEntries(reopened.getSession(id).messages.map((row) => [row.id, row]));
  assert.equal(rows.u_1.board_id, B);
  assert.equal(Object.hasOwn(rows.a_1, 'board_id'), false);
  assert.equal(Object.hasOwn(rows.u_bad, 'board_id'), false);
  // Regenerate (same text) and edit (new text) rewrite the row in place: the stamp stays with the message.
  assert.ok(reopened.truncateAfterMessage(id, 'u_1', { replaceMessageContent: 'add a card' }));
  assert.equal(reopened.getSession(id).messages.at(-1).board_id, B);
  assert.ok(reopened.truncateAfterMessage(id, 'u_1', { replaceMessageContent: 'add two cards' }));
  assert.deepEqual([reopened.getSession(id).messages.at(-1).content, reopened.getSession(id).messages.at(-1).board_id], ['add two cards', B]);
  reopened.dispose();
  const imported = stripUnknownImportedMessageKeys({ id: 'u', role: 'user', content: 'x', board_id: B });
  assert.equal(Object.hasOwn(imported.message, 'board_id'), false);
  assert.deepEqual(imported.strippedKeys, ['board_id']);
});

/* ------------------------------------------------------------------ the main-process gate */

async function gate(t, { enabled = true } = {}) {
  const env = sessionStore(t);
  const flag = { on: enabled };
  let seq = 0;
  const boards = createBoardService({
    store: createBoardStore({ userDataPath: env.root }), makeId: () => uid(++seq), isEnabled: () => flag.on, projectExists: () => true,
  });
  const logs = [];
  const service = {
    sessionStore: env.sessions,
    getBoardService: () => (flag.on ? boards : null),
    _emitServiceLog: (level, event, data) => logs.push([event, data.reason]),
  };
  t.after(() => env.sessions.dispose());
  const make = async (projectId, name) => {
    const made = await boards.create({ projectId, name });
    assert.equal(made.ok, true, JSON.stringify(made));
    return made.board.id;
  };
  const general = env.sessions.createSession({ title: 'General chat' }).id;
  const alpha = env.sessions.createSession({ title: 'Alpha chat', projectId: ALPHA }).id;
  return { ...env, boards, flag, logs, service, make, general, alpha,
    resolve: (input) => stamp.resolveBoardStamp(service, input) };
}

test('the gate keeps a stamp only for a live board of the chat\'s own project', async (t) => {
  const g = await gate(t);
  const inGeneral = await g.make('project_general', 'Plan');
  const inAlpha = await g.make(ALPHA, 'Alpha plan');
  assert.equal(await g.resolve({ boardId: inGeneral, sessionId: g.general }), inGeneral);
  assert.equal(await g.resolve({ boardId: inAlpha, sessionId: g.alpha }), inAlpha);
  assert.deepEqual(g.logs, [], 'a kept stamp logs nothing');
  assert.equal(await g.resolve({ sessionId: g.general }), null, 'no stamp, no work');
  assert.equal(await g.resolve({ boardId: null, sessionId: g.general }), null);
  assert.deepEqual(g.logs, []);
  // Another project's board, a board that does not exist, a malformed id, a chat with no record, a deleted board.
  assert.equal(await g.resolve({ boardId: inAlpha, sessionId: g.general }), null);
  assert.equal(await g.resolve({ boardId: inGeneral, sessionId: g.alpha }), null);
  assert.equal(await g.resolve({ boardId: OTHER, sessionId: g.general }), null);
  assert.equal(await g.resolve({ boardId: 'board_nope', sessionId: g.general }), null);
  assert.equal(await g.resolve({ boardId: inGeneral, sessionId: 'session_unknown' }), null);
  assert.equal(await g.resolve({ boardId: inGeneral, sessionId: '' }), null);
  assert.equal((await g.boards.delete({ boardId: inGeneral })).ok, true);
  assert.equal(await g.resolve({ boardId: inGeneral, sessionId: g.general }), null);
  assert.deepEqual(g.logs.map(([event, reason]) => `${event}:${reason}`), ['not_in_project', 'not_in_project', 'not_in_project',
    'invalid', 'no_session', 'no_session', 'not_in_project'].map((reason) => `boards.turn_stamp_dropped:${reason}`));
  // With boards off nothing is stamped, and a host that has no board service at all stamps nothing either.
  g.flag.on = false;
  assert.equal(await g.resolve({ boardId: inAlpha, sessionId: g.alpha }), null);
  assert.equal(await stamp.resolveBoardStamp({ sessionStore: g.sessions }, { boardId: inAlpha, sessionId: g.alpha }), null);
  assert.equal(g.logs.at(-1)[1], 'disabled');
});

test('an edit or a regenerate uses the stored message\'s stamp and ignores the payload\'s', async (t) => {
  const g = await gate(t);
  const first = await g.make('project_general', 'Plan');
  const second = await g.make('project_general', 'Ideas');
  g.sessions.appendMessage(g.general, { id: 'u_stamped', role: 'user', content: 'on the board', board_id: first });
  g.sessions.appendMessage(g.general, { id: 'u_plain', role: 'user', content: 'not on a board' });
  assert.equal(await g.resolve({ boardId: second, sessionId: g.general, editedMessageId: 'u_stamped' }), first);
  assert.equal(await g.resolve({ sessionId: g.general, editedMessageId: 'u_stamped' }), first);
  assert.equal(await g.resolve({ boardId: second, sessionId: g.general, editedMessageId: 'u_plain' }), null, 'an edit never gains a stamp');
  // The stored stamp is checked again: a board deleted since then gives the turn no board, and the row keeps its mark.
  assert.equal((await g.boards.delete({ boardId: first })).ok, true);
  assert.equal(await g.resolve({ sessionId: g.general, editedMessageId: 'u_stamped' }), null);
  assert.equal(stamp.storedBoardStamp(g.sessions, g.general, 'u_stamped'), first);
});

test('the chat request carries a believed stamp and nothing for a refused one', async (t) => {
  const g = await gate(t);
  const board = await g.make(ALPHA, 'Alpha plan');
  const base = { prompt: 'p', visiblePrompt: 'p', preferredModel: 'gemma', attachments: [] };
  assert.equal((await prepareLocalEngineChatRequest(g.service, { ...base, sessionId: g.alpha, boardId: board })).boardId, board);
  for (const [sessionId, boardId] of [[g.general, board], [g.alpha, OTHER], [g.alpha, undefined]]) {
    assert.equal(Object.hasOwn(await prepareLocalEngineChatRequest(g.service, { ...base, sessionId, boardId }), 'boardId'), false);
  }
});

test('a durable turn keeps a believed stamp on its work record, and a resumed turn reads it back', async (t) => {
  const h = createAdapterHarness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-stamp-work-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seq = 0;
  const boards = createBoardService({ store: createBoardStore({ userDataPath: root }), makeId: () => uid(++seq), projectExists: () => true });
  h.service.getBoardService = () => boards;
  const board = (await boards.create({ projectId: 'project_general', name: 'Plan' })).board.id;
  const send = (boardId) => ({ sessionId: h.sessionId, prompt: 'hello', visiblePrompt: 'hello', preferredModel: 'fixture-model', attachments: [], boardId });
  const refused = await h.adapter.prepareSubmission(send(OTHER), {}, { workId: 'work_x', turnId: 'turn_x' });
  assert.equal(Object.hasOwn(refused.input.request, 'boardId'), false, 'a board that is not this project\'s is not recorded');
  h.adapter.discard(refused);
  const prepared = await h.adapter.prepareSubmission(send(board), {}, { workId: 'work_b', turnId: 'turn_b' });
  assert.equal(prepared.input.request.boardId, board);
  h.adapter.discard(prepared);
  const paused = { work_id: 'work_b', turn_id: 'turn_b', session_id: h.sessionId, project_id: prepared.authority.project_id,
    status: 'paused', attempt: null, authority: prepared.authority, input: prepared.input };
  const resumed = h.adapter.prepareResume(paused, { getCurrentWork: () => paused });
  assert.equal(resumed.request.boardId, board);
  h.adapter.discard(resumed);
});

test('the managed turn writes the stamp on the user row only and never sends it to the sidecar', async () => {
  const service = createManagedChatServiceStub();
  let sent = null;
  service.sidecarClient = { connected: true, async chatSend(params, options = {}) {
    sent = params;
    options.onNotification({ method: 'chat.token', params: { delta: 'Added.' } });
    options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
    return { status: 'completed' };
  } };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({ sessionId: 'session_board', prompt: 'Add a card', boardId: B }));
  await service.activeStreams.get(stream.streamId)?._pendingPromise;
  const users = service.sessionMessages.filter((row) => row.role === 'user');
  assert.deepEqual(users.map((row) => row.board_id), [B]);
  for (const row of service.sessionMessages.filter((entry) => entry.role !== 'user')) assert.equal(Object.hasOwn(row, 'board_id'), false, row.role);
  assert.ok(Array.isArray(sent?.messages) && sent.messages.length > 0);
  assert.equal(JSON.stringify(sent).includes('board_'), false, 'no board id or key reaches the sidecar');

  const plain = createManagedChatServiceStub();
  plain.sidecarClient = { connected: true, async chatSend(_params, options = {}) {
    options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
    return { status: 'completed' };
  } };
  const second = await startManagedSidecarChatStream(plain, buildManagedChatRequest({ sessionId: 'session_plain', prompt: 'Hello' }));
  await plain.activeStreams.get(second.streamId)?._pendingPromise;
  assert.equal(plain.sessionMessages.some((row) => Object.hasOwn(row, 'board_id')), false, 'an unstamped turn writes no key');
});

test('both wire contracts take the stamp as an identifier and refuse another shape', () => {
  const start = (extra) => validateChatStartPayload({ sessionId: 's', prompt: 'p', ...extra });
  assert.equal(start({ boardId: B }).value.boardId, B);
  assert.equal(start({}).ok, true);
  for (const bad of ['', null, 7, { id: B }, 'board id', 'b'.repeat(200)]) assert.equal(start({ boardId: bad }).ok, false, JSON.stringify(bad));
  const submit = (extra) => normalizeSubmission({ session_id: 's', prompt: 'p', idempotency_key: 'idem_1', ...extra });
  assert.equal(submit({ board_id: B }).request.boardId, B);
  assert.equal(Object.hasOwn(submit({}).request, 'boardId'), false);
  for (const bad of [null, 7, { id: B }]) assert.equal(submit({ board_id: bad }), null, JSON.stringify(bad));
  assert.equal(submit({ boardId: B }), null, 'the submission is closed: only the wire name is taken');
});

/* ------------------------------------------------------------------ the renderer: which turn is stamped */

function boardState(overrides = {}) {
  return {
    currentSessionId: 's1',
    ui: { activeView: 'board', boardChatDockOpen: true, boardChat: { boardId: B, projectId: 'project_general' }, ...(overrides.ui || {}) },
    features: { featureFlags: { project_boards: true, ...(overrides.flags || {}) } },
  };
}
const TYPED = { attachImageEditDraft: true };

test('only a turn typed in the composer docked beside a board of the chat\'s project is stamped', () => {
  assert.equal(live.boardStampForSend(boardState(), TYPED, 's1'), B);
  assert.equal(live.boardStampForSend(boardState(), {}, 's1'), '', 'a send that was not typed in the composer');
  assert.equal(live.boardStampForSend(boardState(), null, 's1'), '');
  assert.equal(live.boardStampForSend(boardState({ ui: { activeView: 'chat' } }), TYPED, 's1'), '', 'the same chat on the Chat page');
  assert.equal(live.boardStampForSend(boardState({ ui: { activeView: 'ide', ideChatDockOpen: true } }), TYPED, 's1'), '', 'the Workspace dock');
  assert.equal(live.boardStampForSend(boardState({ ui: { boardChatDockOpen: false } }), TYPED, 's1'), '', 'the chat column is closed');
  assert.equal(live.boardStampForSend(boardState({ ui: { boardChat: null } }), TYPED, 's1'), '', 'the chat is in another project, or no board is open');
  assert.equal(live.boardStampForSend(boardState({ ui: { boardChat: { boardId: 'board_x' } } }), TYPED, 's1'), '');
  assert.equal(live.boardStampForSend(boardState({ flags: { project_boards: false } }), TYPED, 's1'), '', 'boards are off');
  assert.equal(live.boardStampForSend(boardState(), TYPED, 's2'), '', 'a send for another chat');
  // A new chat has no id yet on either side; it is made in the board's project.
  assert.equal(live.boardStampForSend({ ...boardState(), currentSessionId: null }, TYPED, ''), B);
});

test('a queued send, a retry and a replay carry their own stamp and never gain one; an edit sends none', () => {
  const chatPage = boardState({ ui: { activeView: 'chat', boardChat: null } });
  assert.equal(live.boardStampForSend(chatPage, { boardId: B, outboxDispatch: true }, 's1'), B, 'typed beside the board, sent after leaving it');
  assert.equal(live.boardStampForSend(chatPage, { boardId: 'board_x' }, 's1'), '');
  for (const carried of [{ outboxDispatch: true, boardId: null }, { failedPayloadId: 'p1', boardId: null }, { failureRetry: true }]) {
    assert.equal(live.boardStampForSend(boardState(), { ...TYPED, ...carried }, 's1'), '', JSON.stringify(carried));
  }
  for (const edit of [{ editedMessageId: 'u_1' }, { editAndRegenerate: true }]) {
    assert.equal(live.boardStampForSend(boardState(), { ...TYPED, ...edit, boardId: B }, 's1'), '', JSON.stringify(edit));
  }
});

test('the renderer\'s board id pattern is the board store\'s', () => {
  const literal = (file) => /\/\^board_[^\n]*?\$\//.exec(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))?.[0];
  assert.ok(literal('services/boards/board-ids.js'));
  assert.equal(literal('renderer/chat/renderer-chat-surface-live-utils.js'), literal('services/boards/board-ids.js'));
  for (const sample of [B, OTHER, ...BAD_STAMPS.filter((value) => typeof value === 'string')]) {
    assert.equal(live.boardStampForSend(boardState(), { boardId: sample }, 's1') === sample, ids.isBoardId(sample), sample);
  }
});

function sendHarness(t, options = {}) {
  const had = Object.hasOwn(globalThis, 'rendererChatSurfaceLiveUtils');
  const previous = globalThis.rendererChatSurfaceLiveUtils;
  globalThis.rendererChatSurfaceLiveUtils = live;
  const h = createControllerHarness([], options);
  t.after(() => {
    h.restore();
    if (had) globalThis.rendererChatSurfaceLiveUtils = previous; else delete globalThis.rendererChatSurfaceLiveUtils;
  });
  Object.assign(h.state.ui, { activeView: 'board', boardChatDockOpen: true, boardChat: { boardId: B, projectId: 'project_general' } });
  h.state.features.featureFlags.project_boards = true;
  return h;
}

test('a send from the docked composer puts the stamp on the start payload and on the row it shows', async (t) => {
  const h = sendHarness(t);
  await h.controller.startPromptSend('Add a card for the launch', TYPED);
  assert.equal(h.calls.startStream.length, 1);
  assert.equal(h.calls.startStream[0].boardId, B);
  assert.equal(validateChatStartPayload(h.calls.startStream[0]).ok, true, 'the payload passes the start contract');
  assert.equal(h.calls.optimisticAppend[0].extra.board_id, B, 'the row shown at once carries the mark');
  assert.equal(h.state.ui.activeView, 'board', 'the send stays on the Board');
});

test('the same chat on the Chat page, and a send that was not typed, send no stamp', async (t) => {
  const onChat = sendHarness(t);
  onChat.state.ui.activeView = 'chat';
  await onChat.controller.startPromptSend('Hello', TYPED);
  assert.equal(Object.hasOwn(onChat.calls.startStream[0], 'boardId'), false);
  assert.equal(Object.hasOwn(onChat.calls.optimisticAppend[0].extra, 'board_id'), false);
  const untyped = sendHarness(t);
  await untyped.controller.startPromptSend('resume');
  assert.equal(Object.hasOwn(untyped.calls.startStream[0], 'boardId'), false);
});

test('the durable send path carries the stamp under its wire name', async (t) => {
  let submitted = null;
  const h = sendHarness(t, { durableRuntime: true, shell: { sessionRuntime: { submit: async (payload) => {
    submitted = payload;
    return { ok: true, work_id: 'work_1', turn_id: 'turn_1', session_id: payload.session_id, revision: 1, status: 'pending' };
  } } } });
  t.after(() => h.controller.dispose());
  await h.controller.startPromptSend('Add a card', TYPED);
  assert.equal(submitted.board_id, B);
  assert.equal(normalizeSubmission(submitted).request.boardId, B, 'and the main process takes it');
  assert.equal(h.calls.optimisticAppend[0].extra.board_id, B);
});

/* ------------------------------------------------------------------ the mark on the message */

test('a stamped message says it was sent from a board, by name once the board has been seen', (t) => {
  const had = Object.hasOwn(globalThis, 'rendererChatSurfaceLiveUtils');
  const previous = globalThis.rendererChatSurfaceLiveUtils;
  globalThis.rendererChatSurfaceLiveUtils = live;
  t.after(() => { if (had) globalThis.rendererChatSurfaceLiveUtils = previous; else delete globalThis.rendererChatSurfaceLiveUtils; });
  const escapeHtml = (value) => String(value == null ? '' : value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const renderer = createTranscriptAttachmentsRenderer({ escapeHtml });
  const html = (message) => renderer.renderMessageAttachments(message);
  const unnamed = html({ id: 'u', role: 'user', board_id: OTHER });
  assert.match(unnamed, /<span class="message-mark" data-message-mark="board" title="Sent with the board beside it">/);
  assert.match(unnamed, /<span class="message-mark-label">From a board<\/span>/);
  assert.doesNotMatch(unnamed, /<button|data-board-id/, 'an unnamed board is not a control');
  live.rememberBoardName(B, '  Launch <plan>  ');
  live.rememberBoardName('board_x', 'ignored');
  assert.equal(live.boardNameOf(B), 'Launch <plan>');
  assert.equal(live.boardNameOf('board_x'), '');
  const named = html({ id: 'u', role: 'user', board_id: B });
  assert.match(named, /<button type="button" class="message-mark message-mark--link" title="Open this board" data-message-mark="board" data-board-id="board_[^"]+">/);
  assert.match(named, /<span class="message-mark-label">Launch &lt;plan&gt; board<\/span>/);
  assert.equal(html({ id: 'u', role: 'user' }), '', 'an unstamped message has no mark');
  assert.equal(html({ id: 'a', role: 'assistant', board_id: B }), '', 'only a user message is marked');
  // The names are bounded: the oldest goes first.
  for (let n = 100; n < 164; n += 1) live.rememberBoardName(`board_${uid(n)}`, `Board ${n}`);
  assert.equal(live.boardNameOf(B), '');
  assert.equal(live.boardNameOf(`board_${uid(163)}`), 'Board 163');
});

test('a board whose name already ends in the word board is not called "board board"', (t) => {
  const had = Object.hasOwn(globalThis, 'rendererChatSurfaceLiveUtils');
  const previous = globalThis.rendererChatSurfaceLiveUtils;
  globalThis.rendererChatSurfaceLiveUtils = live;
  t.after(() => { if (had) globalThis.rendererChatSurfaceLiveUtils = previous; else delete globalThis.rendererChatSurfaceLiveUtils; });
  const escapeHtml = (value) => String(value == null ? '' : value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const renderer = createTranscriptAttachmentsRenderer({ escapeHtml });
  const label = (name) => {
    live.rememberBoardName(B, name);
    const match = /<span class="message-mark-label">([^<]*)<\/span>/.exec(renderer.renderMessageAttachments({ id: 'u', role: 'user', board_id: B }));
    return match && match[1];
  };
  assert.equal(label('New board'), 'New board');
  assert.equal(label('  Project Board  '), 'Project Board');
  assert.equal(label('BOARD'), 'BOARD');
  assert.equal(label('Launch plan'), 'Launch plan board');
  assert.equal(label('Whiteboards'), 'Whiteboards board', 'only the whole word counts');
  assert.equal(label('Board games'), 'Board games board', 'the word must end the name');
});
