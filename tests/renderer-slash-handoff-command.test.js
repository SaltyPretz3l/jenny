'use strict';

// /handoff (row 60 W4): Jenny drafts a note off-transcript, the user edits it in a step-modal
// dialog, and Start creates a linked chat and sends the note as its first message. Cancel and a
// failed draft are calm (handled) outcomes; a send that does not start keeps the note in the
// new chat's composer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createHandoffCommandHandler, deriveChildTitle, findMentions, mentionMatchers, MODAL_ID, PROJECT_FIELD_ID } = require('../renderer/chat/renderer-slash-handoff-command');
const { registerBuiltInSlashCommands, createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const stepModal = require('../renderer/inventory/step-modal');
const textField = require('../renderer/inventory/text-field');
const selectField = require('../renderer/inventory/select-field');

const SOURCE_ID = 'sess_source';
const CHILD_ID = 'sess_child';
const NOTE = 'Goal: make the parser tests pass.\n\nDone so far:\n- ran pytest\n\nFiles touched: src/parser.py\n\nOpen issue: render_list()\n\nNext step: fix render_list().';
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(times = 4) { for (let i = 0; i < times; i += 1) await tick(); }

function harness(t, overrides = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><textarea id="chatInput">/handoff</textarea></main></body></html>');
  const documentRef = dom.window.document;
  const calls = { generate: [], creates: [], sends: [], notices: [], logs: [], drafts: [], clears: 0 };
  const state = { sessions: [{ id: SOURCE_ID, title: 'Parser work', project_id: 'project_1' }], currentSessionId: SOURCE_ID, ...overrides.state };
  const generateNote = overrides.generateNote || (async (sessionId) => { calls.generate.push(sessionId); return { ok: true, note: NOTE, transcriptTruncated: false }; });
  const startPromptSend = overrides.startPromptSend || (async (prompt, options) => { calls.sends.push({ prompt, options }); return { durable: true, sessionId: CHILD_ID }; });
  const handler = createHandoffCommandHandler({
    state,
    documentRef,
    stepModal,
    textField,
    selectField,
    getStartPromptSend: () => startPromptSend,
    createSession: overrides.createSession || (async (options) => { calls.creates.push(options); return CHILD_ID; }),
    getHandoffApi: () => ('api' in overrides ? overrides.api : { generateNote }),
    setNotice: (text, tone) => calls.notices.push({ text, tone }),
    clearComposer: () => { calls.clears += 1; },
    setComposerDraft: overrides.setComposerDraft || ((text, sessionId) => { calls.drafts.push({ text, sessionId }); return true; }),
    isSessionCurrent: overrides.isSessionCurrent,
    getComposerController: overrides.getComposerController,
    appendClientLog: (...args) => calls.logs.push(args),
  });
  t.after(() => { handler.dispose(); dom.window.close(); });
  const modal = () => documentRef.querySelector(`[data-step-modal="${MODAL_ID}"]`);
  const click = (selector) => {
    const el = modal().querySelector(selector);
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  return { dom, documentRef, calls, handler, modal, click, field: () => modal().querySelector('textarea') };
}

test('drafts the note, lets the user edit it, then creates a linked chat and sends it', async (t) => {
  const h = harness(t);
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle();
  assert.ok(h.modal(), 'the dialog is open');
  assert.deepEqual(h.calls.generate, [SOURCE_ID]);
  assert.equal(h.field().disabled, false);
  assert.equal(h.field().value, NOTE);
  assert.equal(h.modal().querySelector('[data-step-modal-action="start"]').disabled, false);
  assert.equal(h.modal().querySelector('[data-step-modal-action="retry"]').hidden, true);
  assert.match(h.modal().querySelector('.inv-step-modal-summary').textContent, /first message of a new chat/);
  h.field().value = NOTE + '\nAlso: check the fixtures.';
  h.click('[data-step-modal-action="start"]');
  const result = await pending;
  assert.deepEqual(result, { ok: true, code: 'handoff_started' });
  assert.equal(h.modal(), null, 'the dialog closes on Start');
  assert.equal(h.calls.clears, 1, 'the source composer is cleared before the new chat opens');
  assert.deepEqual(h.calls.creates, [{ title: 'make the parser tests pass.', handoffFromSessionId: SOURCE_ID, projectId: 'project_1' }]);
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].prompt, NOTE + '\nAlso: check the fixtures.');
  assert.deepEqual(h.calls.sends[0].options, { sessionIdOverride: CHILD_ID, preserveComposerDraft: true });
  assert.deepEqual(h.calls.drafts, []);
  assert.deepEqual(h.calls.notices, []);
  assert.ok(!h.calls.logs.some((entry) => JSON.stringify(entry).includes('render_list')), 'the note text is never logged');
});

test('Cancel, Escape and the backdrop resolve as handled without creating anything', async (t) => {
  for (const way of ['cancel', 'escape', 'backdrop']) {
    const h = harness(t);
    const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
    await settle();
    if (way === 'cancel') h.click('[data-step-modal-action="cancel"]');
    else if (way === 'backdrop') h.modal().dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    else h.documentRef.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.deepEqual(await pending, { ok: false, handled: true, code: 'cancelled' }, way);
    assert.equal(h.modal(), null, way);
    assert.deepEqual(h.calls.creates, [], way);
    assert.deepEqual(h.calls.sends, [], way);
  }
});

test('a failed draft keeps Start disabled until the user writes a note; Try again re-drafts', async (t) => {
  let attempt = 0;
  const h = harness(t, {
    generateNote: async () => { attempt += 1; return attempt === 1 ? { ok: false, reason: 'generation_failed' } : { ok: true, note: NOTE }; },
  });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle();
  const start = () => h.modal().querySelector('[data-step-modal-action="start"]');
  assert.equal(h.modal().querySelector('.inv-step-modal-status').textContent, 'Couldn’t draft');
  assert.match(h.modal().querySelector('.inv-step-modal-summary').textContent, /write it yourself/);
  assert.equal(h.modal().querySelector('[data-step-modal-action="retry"]').hidden, false);
  assert.equal(start().disabled, true);
  assert.equal(h.field().disabled, false);
  assert.match(h.field().placeholder, /keep going/);
  h.field().value = 'Goal: finish it myself.';
  h.field().dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  assert.equal(start().disabled, false);
  h.click('[data-step-modal-action="retry"]');
  await settle();
  assert.equal(attempt, 2);
  assert.equal(h.field().value, NOTE, 'the retry replaces the field with the fresh draft');
  assert.equal(h.modal().querySelector('[data-step-modal-action="retry"]').hidden, true);
  h.click('[data-step-modal-action="start"]');
  assert.equal((await pending).ok, true);
});

test('draft failure reasons pick their own copy', async (t) => {
  for (const [reason, pattern] of [['no_history', /nothing to hand off/], ['session_busy', /still replying/], ['model_unavailable', /No local model/]]) {
    const h = harness(t, { generateNote: async () => ({ ok: false, reason }) });
    const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
    await settle();
    assert.match(h.modal().querySelector('.inv-step-modal-summary').textContent, pattern, reason);
    h.click('[data-step-modal-action="cancel"]');
    await pending;
  }
});

test('a truncated transcript is said on the ready summary', async (t) => {
  const h = harness(t, { generateNote: async () => ({ ok: true, note: NOTE, transcriptTruncated: true }) });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle();
  assert.match(h.modal().querySelector('.inv-step-modal-summary').textContent, /most recent part of this chat/);
  h.click('[data-step-modal-action="cancel"]');
  await pending;
});

test('a send that does not start leaves the note in the new chat composer and says so', async (t) => {
  for (const outcome of [null, { rejected: true, reason: 'session_compacting' }]) {
    const h = harness(t, { startPromptSend: async () => outcome });
    const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
    await settle();
    h.click('[data-step-modal-action="start"]');
    assert.deepEqual(await pending, { ok: false, handled: true, code: 'send_not_started' });
    assert.deepEqual(h.calls.drafts, [{ text: NOTE, sessionId: CHILD_ID }]);
    assert.match(h.calls.notices[0].text, /in the composer of the new chat/);
  }
});

test('a chat that cannot be created reopens the editor with the edited note', async (t) => {
  let attempts = 0;
  const h = harness(t, { createSession: async (options) => { attempts += 1; h.calls.creates.push(options); if (attempts === 1) throw new Error('store offline'); return CHILD_ID; } });
  const run = h.handler({ sessionId: SOURCE_ID });
  await settle();
  h.field().value = NOTE + '\n\nEdited by hand.';
  h.click('[data-step-modal-action="start"]');
  await settle(8);
  assert.equal(h.calls.notices.length, 1);
  assert.match(h.calls.notices[0].text, /could not be created/);
  assert.ok(h.modal(), 'the editor is back');
  assert.equal(h.field().value, NOTE + '\n\nEdited by hand.', 'with the edited note');
  assert.equal(h.field().disabled, false);
  assert.equal(h.modal().querySelector('[data-step-modal-action="start"]').disabled, false);
  assert.equal(h.calls.generate.length, 1, 'no second draft is requested');
  h.click('[data-step-modal-action="start"]');
  const result = await run;
  assert.deepEqual(result, { ok: true, code: 'handoff_started' });
  assert.equal(attempts, 2);
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].prompt, NOTE + '\n\nEdited by hand.');
});

test('dispose during a pending creation sends nothing and keeps the note for the new chat', async (t) => {
  let resolveCreate;
  const h = harness(t, { createSession: () => new Promise((resolve) => { resolveCreate = resolve; }) });
  const run = h.handler({ sessionId: SOURCE_ID });
  await settle();
  h.click('[data-step-modal-action="start"]');
  await settle();
  h.handler.dispose();
  resolveCreate(CHILD_ID);
  const result = await run;
  assert.deepEqual(result, { ok: false, handled: true, code: 'disposed' });
  assert.equal(h.calls.sends.length, 0);
  assert.deepEqual(h.calls.drafts, [{ text: NOTE, sessionId: CHILD_ID }]);
  assert.equal(h.calls.notices.length, 0, 'no notice reaches a pane that is gone');
  assert.deepEqual(await h.handler({ sessionId: SOURCE_ID }), { ok: false, handled: true, code: 'disposed' });
});

test('dispose during a pending send leaves the pane alone', async (t) => {
  let resolveSend;
  const h = harness(t, { startPromptSend: () => new Promise((resolve) => { resolveSend = resolve; }) });
  const run = h.handler({ sessionId: SOURCE_ID });
  await settle();
  h.click('[data-step-modal-action="start"]');
  await settle();
  h.handler.dispose();
  resolveSend({ rejected: true, reason: 'engine_unavailable' });
  const result = await run;
  assert.deepEqual(result, { ok: false, handled: true, code: 'disposed' });
  assert.deepEqual(h.calls.drafts, [{ text: NOTE, sessionId: CHILD_ID }], 'the unsent note stays with the new chat');
  assert.equal(h.calls.notices.length, 0);
});

// Row 73: the primary Jenny chat hands off one project at a time, into a chat of its own.
const PRIMARY_SESSIONS = [{ id: SOURCE_ID, title: 'Jenny', project_id: 'project_general', session_role: 'primary' }];
const PROJECTS = [{ id: 'project_atlas', name: 'Atlas' }, { id: 'project_zeta', name: 'Zeta site' }, { id: 'project_general', name: 'General' }];

function primaryApi(calls, { suggestedProjectId = 'project_atlas', note = NOTE, otherNames = ['Zeta site'], invalid = [] } = {}) {
  return async (sessionId, options) => {
    calls.generate.push({ sessionId, options });
    const projectId = options && options.projectId;
    if (!projectId) return { ok: false, reason: 'project_required', projects: PROJECTS, suggestedProjectId };
    if (invalid.includes(projectId)) return { ok: false, reason: 'project_invalid', projects: PROJECTS, suggestedProjectId };
    return { ok: true, note, transcriptTruncated: false, projectId, otherNames };
  };
}

function primaryHarness(t, apiOptions) {
  const calls = { generate: [] };
  const h = harness(t, { state: { sessions: PRIMARY_SESSIONS }, generateNote: primaryApi(calls, apiOptions) });
  h.calls.generate = calls.generate;
  h.select = () => h.modal().querySelector(`#${PROJECT_FIELD_ID}`);
  h.mentions = () => h.modal().querySelector('[data-handoff-mentions]');
  h.summary = () => h.modal().querySelector('.inv-step-modal-summary').textContent;
  h.start = () => h.modal().querySelector('[data-step-modal-action="start"]');
  h.choose = (value) => {
    h.select().value = value;
    h.select().dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  };
  return h;
}

test('row 73: on the primary chat the suggested project is preselected and the note is drafted about it', async (t) => {
  const h = primaryHarness(t);
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle(8);
  assert.deepEqual(h.calls.generate, [
    { sessionId: SOURCE_ID, options: { projectId: '' } },
    { sessionId: SOURCE_ID, options: { projectId: 'project_atlas' } },
  ]);
  assert.equal(h.select().value, 'project_atlas');
  assert.equal(h.select().disabled, false);
  assert.deepEqual([...h.select().options].map((option) => option.value), ['project_atlas', 'project_zeta', 'project_general']);
  assert.equal(h.field().value, NOTE);
  assert.match(h.summary(), /new chat in Atlas\./);
  assert.equal(h.mentions().hidden, true, 'nothing from other work is mentioned');
  h.click('[data-step-modal-action="start"]');
  assert.deepEqual(await pending, { ok: true, code: 'handoff_started' });
  assert.deepEqual(h.calls.creates, [{ title: 'make the parser tests pass.', projectId: 'project_atlas' }],
    'the chat opens in the chosen project with no link to the primary');
  assert.equal(h.calls.sends[0].prompt, NOTE);
});

test('row 73: without a suggestion the person chooses the project before anything is drafted', async (t) => {
  const h = primaryHarness(t, { suggestedProjectId: null });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle(8);
  assert.equal(h.calls.generate.length, 1);
  assert.equal(h.select().value, '');
  assert.equal(h.select().options[0].disabled, true, 'the placeholder cannot be picked back');
  assert.equal(h.field().disabled, true);
  assert.equal(h.start().disabled, true);
  assert.match(h.summary(), /Choose the project/);
  h.choose('project_zeta');
  await settle(8);
  assert.deepEqual(h.calls.generate.at(-1), { sessionId: SOURCE_ID, options: { projectId: 'project_zeta' } });
  assert.equal(h.select().options[0].value, 'project_atlas', 'the placeholder is gone once a project is set');
  assert.equal(h.start().disabled, false);
  h.click('[data-step-modal-action="cancel"]');
  assert.deepEqual(await pending, { ok: false, handled: true, code: 'cancelled' });
  assert.deepEqual(h.calls.creates, []);
});

test('row 73: switching project redrafts; a project that is gone asks again', async (t) => {
  const h = primaryHarness(t, { invalid: ['project_zeta'] });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle(8);
  h.choose('project_zeta');
  await settle(8);
  assert.equal(h.select().value, '');
  assert.match(h.summary(), /no longer there/);
  assert.equal(h.start().disabled, true);
  h.choose('project_general');
  await settle(8);
  assert.equal(h.field().value, NOTE);
  h.click('[data-step-modal-action="cancel"]');
  await pending;
});

test('row 73: a note that names other work says so, live as the person edits', async (t) => {
  const h = primaryHarness(t, { note: NOTE + '\nAlso see the Zeta site deploy.' });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle(8);
  assert.equal(h.mentions().hidden, false);
  assert.match(h.mentions().textContent, /mentions other work: Zeta site\./);
  h.field().value = NOTE;
  h.field().dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  assert.equal(h.mentions().hidden, true);
  h.click('[data-step-modal-action="cancel"]');
  await pending;
});

test('row 73: a primary note without a Goal line is titled after the project', async (t) => {
  const h = primaryHarness(t, { note: 'Done so far:\n- ran pytest\n\nNext step: fix it.' });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle(8);
  h.click('[data-step-modal-action="start"]');
  await pending;
  assert.equal(h.calls.creates[0].title, 'Atlas handoff');
});

test('row 73: an edited note keeps its project; a switch on an untouched draft clears the old flags', async (t) => {
  const h = primaryHarness(t, { note: NOTE + '\nAlso see the Zeta site deploy.' });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle(8);
  assert.equal(h.mentions().hidden, false);
  h.field().value = NOTE + '\nMy own line.';
  h.field().dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  const draftsBefore = h.calls.generate.length;
  h.choose('project_zeta');
  await settle(8);
  assert.equal(h.calls.generate.length, draftsBefore, 'no redraft over the edits');
  assert.equal(h.select().value, 'project_atlas');
  assert.equal(h.field().value, NOTE + '\nMy own line.');
  assert.match(h.summary(), /stays with Atlas/);
  h.field().value = NOTE + '\nAlso see the Zeta site deploy.';
  h.field().dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  h.choose('project_zeta');
  await settle(8);
  assert.deepEqual(h.calls.generate.at(-1), { sessionId: SOURCE_ID, options: { projectId: 'project_zeta' } });
  h.click('[data-step-modal-action="cancel"]');
  await pending;
});

test('row 73: mentions match whole words only, case-insensitively', () => {
  const names = mentionMatchers(['Zeta site', 'Atlas', 'Fix login flow', 'C++ (beta)', '  ']);
  assert.deepEqual(findMentions('Work on ZETA SITE and atlas.', names), ['Zeta site', 'Atlas']);
  assert.deepEqual(findMentions('Zeta sites and Atlases, fix login flows', names), []);
  assert.deepEqual(findMentions('the c++ (beta) build', names), ['C++ (beta)'], 'regex characters in a name are literal');
  assert.deepEqual(findMentions('', names), []);
  assert.equal(names.length, 4, 'blank names are dropped');
  assert.equal(deriveChildTitle('no goal here', 'Jenny', { projectName: 'Atlas' }), 'Atlas handoff');
  assert.equal(deriveChildTitle('no goal here', 'Parser work'), 'Parser work (continued)');
});

test('a backend primary_protected draft refusal picks its own copy', async (t) => {
  const h = harness(t, { generateNote: async () => ({ ok: false, reason: 'primary_protected' }) });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle();
  assert.match(h.modal().querySelector('.inv-step-modal-summary').textContent, /cannot hand off/);
  h.click('[data-step-modal-action="cancel"]');
  await pending;
});

test('a second /handoff while a start is in flight is busy', async (t) => {
  let resolveCreate;
  const h = harness(t, { createSession: () => new Promise((resolve) => { resolveCreate = resolve; }) });
  const run = h.handler({ sessionId: SOURCE_ID });
  await settle();
  h.click('[data-step-modal-action="start"]');
  await settle();
  assert.deepEqual(await h.handler({ sessionId: SOURCE_ID }), { ok: false, handled: true, code: 'busy' });
  resolveCreate(CHILD_ID);
  assert.deepEqual(await run, { ok: true, code: 'handoff_started' });
});

test('a note for a chat that no longer holds the pane goes to its composer record, not the visible input', async (t) => {
  const captured = [];
  const h = harness(t, {
    startPromptSend: async () => ({ rejected: true, reason: 'engine_unavailable' }),
    isSessionCurrent: (sessionId) => sessionId !== CHILD_ID,
    getComposerController: () => ({ capturePaneDraft: (sessionId, input) => captured.push([sessionId, input.value]) }),
  });
  const run = h.handler({ sessionId: SOURCE_ID });
  await settle();
  h.click('[data-step-modal-action="start"]');
  assert.deepEqual(await run, { ok: false, handled: true, code: 'send_not_started' });
  assert.deepEqual(h.calls.drafts, [], 'the visible input is untouched');
  assert.deepEqual(captured, [[CHILD_ID, NOTE]]);
  assert.match(h.calls.notices[0].text, /in the composer of the new chat/);
});

test('a note that no composer can hold is said plainly', async (t) => {
  const h = harness(t, {
    startPromptSend: async () => ({ rejected: true, reason: 'engine_unavailable' }),
    isSessionCurrent: () => false,
    getComposerController: () => null,
  });
  const run = h.handler({ sessionId: SOURCE_ID });
  await settle();
  h.click('[data-step-modal-action="start"]');
  const result = await run;
  assert.deepEqual(result, { ok: false, handled: true, code: 'send_not_started' });
  assert.equal(h.calls.notices[0].text, 'The note could not be sent.');
});

test('a chat that cannot be created twice still leaves the editor usable', async (t) => {
  const h = harness(t, { createSession: async () => '' });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle();
  h.click('[data-step-modal-action="start"]');
  await settle(8);
  assert.match(h.calls.notices[0].text, /could not be created/);
  assert.ok(h.modal(), 'the editor is back');
  h.click('[data-step-modal-action="start"]');
  await settle(8);
  assert.equal(h.calls.notices.length, 2);
  assert.ok(h.modal(), 'and back again');
  h.click('[data-step-modal-action="cancel"]');
  assert.deepEqual(await pending, { ok: false, handled: true, code: 'cancelled' });
  assert.deepEqual(h.calls.sends, []);
  assert.deepEqual(h.calls.drafts, []);
});

test('without a session or the IPC the command is unavailable, and a second invocation while open is busy', async (t) => {
  const none = harness(t, { api: null });
  assert.deepEqual(await none.handler({ sessionId: SOURCE_ID, args: '' }), { ok: false, handled: true, code: 'handoff_unavailable' });
  assert.match(none.calls.notices[0].text, /not available/);
  const h = harness(t);
  assert.deepEqual(await h.handler({ sessionId: '', args: '' }), { ok: false, handled: true, code: 'handoff_unavailable' });
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle();
  assert.deepEqual(await h.handler({ sessionId: SOURCE_ID, args: '' }), { ok: false, handled: true, code: 'busy' });
  h.click('[data-step-modal-action="cancel"]');
  await pending;
});

test('dispose closes an open dialog as a cancel', async (t) => {
  const h = harness(t);
  const pending = h.handler({ sessionId: SOURCE_ID, args: '' });
  await settle();
  h.handler.dispose();
  assert.deepEqual(await pending, { ok: false, handled: true, code: 'cancelled' });
  assert.equal(h.modal(), null);
});

test('deriveChildTitle uses the Goal line, clipped, else "{source} (continued)"', () => {
  assert.equal(deriveChildTitle('Goal: ship the parser fix\nNext step: run tests', 'Parser work'), 'ship the parser fix');
  assert.equal(deriveChildTitle('**Goal:** ship the parser fix', 'Parser work'), 'ship the parser fix');
  assert.equal(deriveChildTitle('## Goal\nship it', 'Parser work'), 'Parser work (continued)');
  assert.equal(deriveChildTitle('Goal: (none)\nNext step: start', 'Parser work'), 'Parser work (continued)');
  assert.equal(deriveChildTitle('no headings here', ''), 'Untitled chat (continued)');
  const long = deriveChildTitle('Goal: ' + 'x'.repeat(80), 'Parser work');
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
});

test('/handoff is a built-in run command that needs a session', async () => {
  const calls = { toasts: [], logs: [] };
  const registry = createSlashCommandRegistry({
    state: { currentSessionId: '' },
    optimisticAppend: () => ({}), renderAll: () => {}, escapeHtml: (value) => String(value),
    appendClientLog: (...args) => calls.logs.push(args), showToastMessage: (...args) => calls.toasts.push(args),
  });
  registerBuiltInSlashCommands({ registry, contextHandler: () => ({ ok: true }), noteHandler: () => ({ ok: true }), handoffHandler: async () => ({ ok: true, code: 'handoff_started' }) });
  const entry = registry.listCommands().find((row) => row.name === '/handoff');
  assert.equal(entry.description, 'Continue in a new chat with a handoff note');
  assert.equal(entry.action, 'run');
  assert.equal(entry.requiresSession, true);
  assert.equal(entry.available, false);
});
