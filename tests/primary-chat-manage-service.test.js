'use strict';

// Row 94 P1: the port behind chat_organize / chat_configure and Activity's Undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrimaryChatManageService } = require('../services/primary-chat-manage-service');

const PRIMARY = 'p1';
const TARGET = 's1';
const CHANGE_ID = /^sc_[0-9a-f]{32}$/;

function harness({ sessions, flags = {}, busy = false, controls, projects } = {}) {
  const store = new Map(Object.entries(sessions || {
    [PRIMARY]: { id: PRIMARY, title: 'Jenny', session_role: 'primary', run_mode: 'ask', pinned: false, archived_at: null, project_id: 'general' },
    [TARGET]: { id: TARGET, title: 'Old title', run_mode: 'ask', plan_mode: false, pinned: false, archived_at: null,
      project_id: 'general', preferred_model: 'qwen3.8', reasoning_effort: 'default' },
  }));
  const calls = [];
  const emitted = [];
  const recorded = [];
  const undone = [];
  const history = new Map();
  const backend = {
    async renameSession(id, title) { calls.push(['rename', id, title]); store.get(id).title = title.trim(); return { data: store.get(id) }; },
    async setSessionMeta(id, meta) {
      calls.push(['meta', id, meta]);
      if (meta.archived_at && store.get(id).session_role === 'primary') return { ok: false, session_id: id, reason: 'primary_protected' };
      Object.assign(store.get(id), meta);
      return store.get(id);
    },
    async setSessionPreferences(id, prefs) {
      calls.push(['prefs', id, prefs]);
      const record = store.get(id);
      Object.assign(record, prefs);
      if (prefs.run_mode) record.plan_mode = prefs.run_mode === 'plan';
      return record;
    },
    emitSessionsChanged(payload) { emitted.push(payload); },
  };
  const projectApp = projects || {
    assignSessionProject(payload) {
      calls.push(['assign', payload]);
      if (payload.project_id === 'missing') return { ok: false, error: { reason: 'project_not_found' } };
      if (payload.project_id === 'bad id') return { ok: false, error: { reason: 'invalid_project_id' } };
      if (busy === 'project') return { ok: false, error: { reason: 'session_busy' } };
      store.get(payload.session_id).project_id = payload.project_id;
      return { ok: true, unchanged: false };
    },
  };
  const ctl = controls || {
    recordChatChange(entry) { recorded.push(entry); history.set(entry.change_id, { entry, undone: false }); return true; },
    recordChatChangeUndone(id) { undone.push(id); if (history.has(id)) history.get(id).undone = true; return true; },
    findChatChange(id) { return history.get(id) || null; },
  };
  const service = createPrimaryChatManageService({
    backendService: () => backend,
    sessionStore: () => ({ getSessionSummary: (id) => (store.has(id) ? { ...store.get(id) } : null) }),
    projectApplicationService: () => projectApp,
    controls: () => ctl,
    featureFlags: () => flags,
    primarySessionId: () => PRIMARY,
    isSessionBusy: () => busy === true,
    resolveEffort: (effort) => (effort === 'xhigh' ? 'default' : effort),
  });
  return { service, store, calls, emitted, recorded, undone, history };
}

const ask = (extra = {}) => ({ target_session_id: TARGET, caller_session_id: PRIMARY, ...extra });

test('rename applies through renameSession, records the stored title and emits', async () => {
  const h = harness();
  const answer = await h.service.organize(ask({ action: 'rename', value: '  New title ' }));
  assert.equal(answer.ok, true);
  assert.match(answer.change_id, CHANGE_ID);
  assert.deepEqual([answer.session_id, answer.action, answer.before, answer.after], [TARGET, 'rename', 'Old title', 'New title']);
  assert.deepEqual(h.calls, [['rename', TARGET, 'New title']]);
  assert.deepEqual(h.recorded, [{ change_id: answer.change_id, session_id: TARGET, action: 'rename', field: 'title', before: 'Old title', after: 'New title' }]);
  assert.deepEqual(h.emitted, [{ session_ids: [TARGET] }]);
});

test('pin, unpin, archive and unarchive go through setSessionMeta and record their field', async () => {
  const h = harness();
  const pin = await h.service.organize(ask({ action: 'pin' }));
  assert.deepEqual([pin.ok, pin.before, pin.after], [true, false, true]);
  assert.equal(h.store.get(TARGET).pinned, true);
  const unpin = await h.service.organize(ask({ action: 'unpin' }));
  assert.deepEqual([unpin.ok, unpin.before, unpin.after], [true, true, false]);
  const archive = await h.service.organize(ask({ action: 'archive' }));
  assert.equal(archive.ok, true);
  assert.equal(archive.before, null);
  assert.match(archive.after, /^\d{4}-\d{2}-\d{2}T/);
  const unarchive = await h.service.organize(ask({ action: 'unarchive' }));
  assert.deepEqual([unarchive.ok, unarchive.before === archive.after, unarchive.after], [true, true, null]);
  assert.deepEqual(h.recorded.map((entry) => entry.field), ['pinned', 'pinned', 'archived_at', 'archived_at']);
  assert.equal(h.emitted.length, 4);
});

test('archiving the primary chat is primary_protected and records nothing', async () => {
  const h = harness();
  const answer = await h.service.organize({ ...ask({ action: 'archive' }), target_session_id: PRIMARY });
  assert.deepEqual(answer, { ok: false, reason: 'primary_protected' });
  assert.deepEqual([h.recorded, h.emitted], [[], []]);
});

test('move_to_project maps the project service refusals and records project_id', async () => {
  const h = harness();
  const moved = await h.service.configure(ask({ action: 'move_to_project', value: 'proj_a' }));
  assert.deepEqual([moved.ok, moved.before, moved.after], [true, 'general', 'proj_a']);
  assert.deepEqual(h.calls[0], ['assign', { project_id: 'proj_a', session_id: TARGET }]);
  assert.equal(h.recorded[0].field, 'project_id');
  assert.deepEqual(await h.service.configure(ask({ action: 'move_to_project', value: 'missing' })), { ok: false, reason: 'not_found' });
  assert.deepEqual(await h.service.configure(ask({ action: 'move_to_project', value: 'bad id' })), { ok: false, reason: 'invalid_input' });
  const busy = harness({ busy: 'project' });
  assert.deepEqual(await busy.service.configure(ask({ action: 'move_to_project', value: 'proj_a' })), { ok: false, reason: 'busy' });
  const protectedPrimary = harness({ projects: { assignSessionProject: () => ({ ok: false, error: { reason: 'primary_protected' } }) } });
  assert.deepEqual(await protectedPrimary.service.configure(ask({ action: 'move_to_project', value: 'proj_a' })), { ok: false, reason: 'primary_protected' });
  assert.deepEqual(await h.service.configure(ask({ action: 'move_to_project' })), { ok: false, reason: 'invalid_input' });
});

test('an unknown target is not_found and a missing project service is unavailable', async () => {
  const h = harness();
  assert.deepEqual(await h.service.organize(ask({ target_session_id: 'nope', action: 'pin' })), { ok: false, reason: 'not_found' });
  assert.deepEqual(await h.service.configure(ask({ target_session_id: 'nope', action: 'set_model', value: 'm' })), { ok: false, reason: 'not_found' });
  const none = harness({ projects: null });
  const lacking = createPrimaryChatManageService({
    backendService: () => ({}), sessionStore: () => ({ getSessionSummary: () => ({ id: TARGET, project_id: 'general' }) }),
    primarySessionId: () => PRIMARY, featureFlags: () => ({}),
  });
  assert.deepEqual(await lacking.configure(ask({ action: 'move_to_project', value: 'proj_a' })), { ok: false, reason: 'unavailable' });
  assert.ok(none.service);
});

test('rename input is bounded and an equal title is an unchanged no-op', async () => {
  const h = harness();
  for (const value of [undefined, '', '   ', 'x'.repeat(121), 7, 'tab\u0007bell']) {
    assert.deepEqual(await h.service.organize(ask({ action: 'rename', value })), { ok: false, reason: 'invalid_input' }, String(value));
  }
  const same = await h.service.organize(ask({ action: 'rename', value: ' Old   title ' }));
  assert.deepEqual([same.ok, same.unchanged, same.change_id], [true, true, undefined]);
  assert.deepEqual([h.calls, h.recorded, h.emitted], [[], [], []]);
});

test('an unknown action is invalid_input', async () => {
  const h = harness();
  assert.deepEqual(await h.service.organize(ask({ action: 'delete' })), { ok: false, reason: 'invalid_input' });
  assert.deepEqual(await h.service.configure(ask({ action: 'pin' })), { ok: false, reason: 'invalid_input' });
  assert.deepEqual(await h.service.organize(ask({ action: 'set_model', value: 'm' })), { ok: false, reason: 'invalid_input' });
});

test('set_model validates the name, applies through setSessionPreferences and no-ops on equal', async () => {
  const h = harness();
  const set = await h.service.configure(ask({ action: 'set_model', value: 'gpt-6-astra' }));
  assert.deepEqual([set.ok, set.before, set.after], [true, 'qwen3.8', 'gpt-6-astra']);
  assert.deepEqual(h.calls[0], ['prefs', TARGET, { preferred_model: 'gpt-6-astra' }]);
  assert.equal(h.recorded[0].field, 'preferred_model');
  for (const value of [undefined, '', 'a\nb', 'x'.repeat(300), 4]) {
    assert.deepEqual(await h.service.configure(ask({ action: 'set_model', value })), { ok: false, reason: 'invalid_input' }, String(value));
  }
  const again = await h.service.configure(ask({ action: 'set_model', value: 'gpt-6-astra' }));
  assert.deepEqual([again.ok, again.unchanged], [true, true]);
  assert.equal(h.recorded.length, 1);
});

test('set_effort normalizes the token and refuses one the model cannot take', async () => {
  const h = harness();
  const set = await h.service.configure(ask({ action: 'set_effort', value: ' High ' }));
  assert.deepEqual([set.ok, set.before, set.after], [true, 'default', 'high']);
  assert.deepEqual(h.calls[0], ['prefs', TARGET, { reasoning_effort: 'high' }]);
  assert.equal(h.recorded[0].field, 'reasoning_effort');
  assert.deepEqual(await h.service.configure(ask({ action: 'set_effort', value: 'xhigh' })), { ok: false, reason: 'invalid_input' }); // clamped away for this model
  assert.deepEqual(await h.service.configure(ask({ action: 'set_effort', value: 'banana' })), { ok: false, reason: 'invalid_input' });
  assert.deepEqual(await h.service.configure(ask({ action: 'set_effort' })), { ok: false, reason: 'invalid_input' });
  const same = await h.service.configure(ask({ action: 'set_effort', value: 'high' }));
  assert.equal(same.unchanged, true);
  const auto = await h.service.configure(ask({ action: 'set_effort', value: 'default' }));
  assert.deepEqual([auto.ok, auto.after], [true, 'default']);
});

test('set_run_mode accepts ask|plan|propose, refuses auto, and records the old mode', async () => {
  const h = harness();
  const plan = await h.service.configure(ask({ action: 'set_run_mode', value: 'plan' }));
  assert.deepEqual([plan.ok, plan.before, plan.after], [true, 'ask', 'plan']);
  assert.deepEqual(h.calls[0], ['prefs', TARGET, { run_mode: 'plan' }]);
  assert.equal(h.recorded[0].field, 'run_mode');
  assert.deepEqual(await h.service.configure(ask({ action: 'set_run_mode', value: 'auto' })), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await h.service.configure(ask({ action: 'set_run_mode', value: 'AUTO' })), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await h.service.configure(ask({ action: 'set_run_mode', value: 'turbo' })), { ok: false, reason: 'invalid_input' });
  const same = await h.service.configure(ask({ action: 'set_run_mode', value: 'plan' }));
  assert.equal(same.unchanged, true);
  assert.equal(h.recorded.length, 1);
});

test('set_run_mode is busy while the target has a turn, a question or a plan, and self_refused on the caller', async () => {
  const turn = harness({ busy: true });
  assert.deepEqual(await turn.service.configure(ask({ action: 'set_run_mode', value: 'plan' })), { ok: false, reason: 'busy' });
  assert.deepEqual(turn.calls, []);
  const question = harness();
  question.store.get(TARGET).pending_question_batch = { id: 'q' };
  assert.deepEqual(await question.service.configure(ask({ action: 'set_run_mode', value: 'plan' })), { ok: false, reason: 'busy' });
  const plan = harness();
  plan.store.get(TARGET).pending_plan_proposal = { id: 'pl' };
  assert.deepEqual(await plan.service.configure(ask({ action: 'set_run_mode', value: 'ask' })), { ok: false, reason: 'busy' });
  const unknownBusy = createPrimaryChatManageService({
    backendService: () => ({}), sessionStore: () => ({ getSessionSummary: () => ({ id: TARGET, run_mode: 'ask' }) }),
    primarySessionId: () => PRIMARY, featureFlags: () => ({}),
  });
  assert.deepEqual(await unknownBusy.configure(ask({ action: 'set_run_mode', value: 'plan' })), { ok: false, reason: 'busy' });
  const h = harness();
  assert.deepEqual(await h.service.configure({ ...ask({ action: 'set_run_mode', value: 'plan' }), target_session_id: PRIMARY }), { ok: false, reason: 'self_refused' });
  // Model and effort on a busy chat are allowed: only a mode change kills the reply.
  const model = await turn.service.configure(ask({ action: 'set_model', value: 'other' }));
  assert.equal(model.ok, true);
});

test('the kill switch, a non-primary caller and an unreadable flag state are refused', async () => {
  for (const flags of [{ primary_chat_manage: false }, { primary_chat: false }]) {
    const h = harness({ flags });
    assert.deepEqual(await h.service.organize(ask({ action: 'pin' })), { ok: false, reason: 'disabled' });
    assert.deepEqual(await h.service.undo({ change_id: `sc_${'a'.repeat(32)}` }), { ok: false, reason: 'disabled' });
    assert.equal(h.service.enabled(), false);
  }
  const h = harness();
  assert.equal(h.service.enabled(), true);
  assert.deepEqual(await h.service.organize({ ...ask({ action: 'pin' }), caller_session_id: TARGET }), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(h.calls, []);
});

test('a write that does not land is unavailable and records nothing', async () => {
  const h = harness();
  const dead = createPrimaryChatManageService({
    backendService: () => ({ setSessionMeta: async () => ({ ok: false }) }),
    sessionStore: () => ({ getSessionSummary: () => ({ id: TARGET, pinned: false }) }),
    primarySessionId: () => PRIMARY, featureFlags: () => ({}), controls: () => h.history,
  });
  assert.deepEqual(await dead.organize(ask({ action: 'pin' })), { ok: false, reason: 'unavailable' });
  const throwing = createPrimaryChatManageService({
    backendService: () => ({ setSessionMeta: async () => { throw new Error('secret path'); } }),
    sessionStore: () => ({ getSessionSummary: () => ({ id: TARGET, pinned: false }) }),
    primarySessionId: () => PRIMARY, featureFlags: () => ({}),
  });
  assert.deepEqual(await throwing.organize(ask({ action: 'pin' })), { ok: false, reason: 'unavailable' });
});

test('a change stands without a change_id when history cannot record it, and a missing emitter is fine', async () => {
  const h = harness({ controls: { recordChatChange: () => false } });
  const answer = await h.service.organize(ask({ action: 'pin' }));
  assert.equal(answer.ok, true);
  assert.equal(answer.change_id, undefined);
  assert.equal(h.store.get(TARGET).pinned, true);
  const bare = createPrimaryChatManageService({
    backendService: () => ({ setSessionMeta: async (_id, meta) => ({ id: TARGET, ...meta }) }),
    sessionStore: (() => { let pinned = false; return () => ({ getSessionSummary: () => { const row = { id: TARGET, pinned }; pinned = true; return row; } }); })(),
    primarySessionId: () => PRIMARY, featureFlags: () => ({}),
  });
  assert.equal((await bare.organize(ask({ action: 'pin' }))).ok, true);
});

test('undo restores the old value, once, and only while the field still holds what Jenny set', async () => {
  const h = harness();
  const renamed = await h.service.organize(ask({ action: 'rename', value: 'Fresh' }));
  assert.deepEqual(await h.service.undo({ change_id: renamed.change_id }), { ok: true, change_id: renamed.change_id });
  assert.equal(h.store.get(TARGET).title, 'Old title');
  assert.deepEqual(h.undone, [renamed.change_id]);
  assert.deepEqual(h.emitted.at(-1), { session_ids: [TARGET] });
  assert.deepEqual(await h.service.undo({ change_id: renamed.change_id }), { ok: false, reason: 'already_undone' });

  const pinned = await h.service.organize(ask({ action: 'pin' }));
  h.store.get(TARGET).pinned = false; // the user unpinned it meanwhile
  assert.deepEqual(await h.service.undo({ change_id: pinned.change_id }), { ok: false, reason: 'changed_since' });

  const archived = await h.service.organize(ask({ action: 'archive' }));
  h.store.delete(TARGET); // the user deleted the chat meanwhile: the change can no longer be undone
  assert.deepEqual(await h.service.undo({ change_id: archived.change_id }), { ok: false, reason: 'unknown' });

  assert.deepEqual(await h.service.undo({ change_id: `sc_${'b'.repeat(32)}` }), { ok: false, reason: 'unknown' });
  assert.deepEqual(await h.service.undo({ change_id: 'nope' }), { ok: false, reason: 'unknown' });
  assert.deepEqual(await h.service.undo({}), { ok: false, reason: 'unknown' });
});

test('undo covers each field: archive, project, model, effort and run mode', async () => {
  const h = harness();
  const archive = await h.service.organize(ask({ action: 'archive' }));
  assert.equal((await h.service.undo({ change_id: archive.change_id })).ok, true);
  assert.equal(h.store.get(TARGET).archived_at, null);
  const move = await h.service.configure(ask({ action: 'move_to_project', value: 'proj_a' }));
  assert.equal((await h.service.undo({ change_id: move.change_id })).ok, true);
  assert.equal(h.store.get(TARGET).project_id, 'general');
  const model = await h.service.configure(ask({ action: 'set_model', value: 'other' }));
  assert.equal((await h.service.undo({ change_id: model.change_id })).ok, true);
  assert.equal(h.store.get(TARGET).preferred_model, 'qwen3.8');
  const effort = await h.service.configure(ask({ action: 'set_effort', value: 'high' }));
  assert.equal((await h.service.undo({ change_id: effort.change_id })).ok, true);
  assert.equal(h.store.get(TARGET).reasoning_effort, 'default');
  const mode = await h.service.configure(ask({ action: 'set_run_mode', value: 'propose' }));
  assert.equal((await h.service.undo({ change_id: mode.change_id })).ok, true);
  assert.equal(h.store.get(TARGET).run_mode, 'ask');
});

test('undo of a run-mode or project change is busy while the chat is working, and a lost record is unavailable', async () => {
  const h = harness();
  const mode = await h.service.configure(ask({ action: 'set_run_mode', value: 'plan' }));
  const move = await h.service.configure(ask({ action: 'move_to_project', value: 'proj_a' }));
  const busy = createPrimaryChatManageService({
    backendService: () => ({}), sessionStore: () => ({ getSessionSummary: (id) => ({ ...h.store.get(id) }) }),
    controls: () => ({ findChatChange: (id) => h.history.get(id) || null }), featureFlags: () => ({}),
    isSessionBusy: () => true,
  });
  assert.deepEqual(await busy.undo({ change_id: mode.change_id }), { ok: false, reason: 'busy' });
  assert.deepEqual(await busy.undo({ change_id: move.change_id }), { ok: false, reason: 'busy' });
  const blind = createPrimaryChatManageService({ featureFlags: () => ({}) });
  assert.deepEqual(await blind.undo({ change_id: mode.change_id }), { ok: false, reason: 'unavailable' });
});

test('row 94 P2: Undo of a created project goes to the placement port and records the undo', async () => {
  const PROJECT_CHANGE = `sc_${'d'.repeat(32)}`;
  const entry = { change_id: PROJECT_CHANGE, session_id: PRIMARY, action: 'project_create', field: 'project', before: null, after: 'pr_1' };
  const undone = [];
  const delegated = [];
  const make = (answer) => createPrimaryChatManageService({
    controls: () => ({ findChatChange: () => ({ entry, undone: false }), recordChatChangeUndone: (id) => { undone.push(id); return true; } }),
    featureFlags: () => ({}), primarySessionId: () => PRIMARY,
    placement: () => ({ undoCreate: async (row) => { delegated.push(row); return answer; } }),
  });
  assert.deepEqual(await make({ ok: true }).undo({ change_id: PROJECT_CHANGE }), { ok: true, change_id: PROJECT_CHANGE });
  assert.deepEqual(delegated, [entry]);
  assert.deepEqual(undone, [PROJECT_CHANGE]);
  assert.deepEqual(await make({ ok: false, reason: 'changed_since' }).undo({ change_id: PROJECT_CHANGE }), { ok: false, reason: 'changed_since' });
  assert.equal(undone.length, 1, 'a refused undo records nothing');
  const missing = createPrimaryChatManageService({
    controls: () => ({ findChatChange: () => ({ entry, undone: false }) }), featureFlags: () => ({}), primarySessionId: () => PRIMARY,
  });
  assert.deepEqual(await missing.undo({ change_id: PROJECT_CHANGE }), { ok: false, reason: 'unavailable' });
});
