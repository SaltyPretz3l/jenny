'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { forkSession } = require('../services/backend/session-branching');
const { prepareReflection } = require('../services/backend/memory-reflection-run');
const { exportSession, importSession, validateSessionImportPayload } = require('../services/backend/session-export-import');
const fake = require('./fixtures/fake-sidecar-memory');

function harness() {
  const sessions = { sess_parent: { id: 'sess_parent', title: 'Parent', project_id: 'project_alpha',
    messages: [{ id: 'u1', role: 'user', content: 'I prefer tea.' },
      { id: 'receipt', role: 'assistant', kind: 'memory_note', memory_notes: [{ operation_id: 'parent_op' }] },
      { id: 'a1', role: 'assistant', content: 'Understood.' }] } };
  const store = { getSession: id => sessions[id] || null,
    peekSessionMessages: id => sessions[id]?.messages || [],
    _read: () => ({ sessions }), _write: payload => Object.assign(sessions, payload.sessions),
    _toSummary: session => ({ id: session.id, title: session.title }) };
  const state = new Map(); const calls = []; const logs = [];
  const service = { sessionStore: store, _emitServiceLog: (...args) => logs.push(args),
    projectAuthority: { captureSession: id => ({ project_id: sessions[id].project_id }) },
    sidecarClient: { async request(method, params) {
      calls.push({ method, params });
      if (method === 'memory.reflection_state') return { cursor: state.get(params.session_id)?.cursor || null, purged: false };
      if (method === 'memory.import_session') assert.ok(store.getSession(params.session_id), 'chat persisted before memory import');
      if (['memory.export_session', 'memory.import_session', 'memory.chat_sessions'].includes(method)) {
        return fake.requestSessionMemory(method, params, state);
      }
      throw new Error('unexpected method');
    } } };
  state.set('sess_parent', { notes: [{ text: 'Prefers tea.', kind: 'preference', origin: 'user', created_at: '2026-10-15' }],
    recap: { text: 'Tea preferences.', updated_at: '2026-10-15' }, cursor: { window_fingerprint: 'parent_cursor' } });
  return { store, state, service, calls, logs };
}

test('fork omits parent memory receipts and prepares with no inherited cursor, notes or recap', async () => {
  const h = harness();
  const branch = forkSession(h.store, 'sess_parent', 'a1');
  assert.deepEqual(h.store.getSession(branch.id).messages.map(m => m.content), ['I prefer tea.', 'Understood.']);
  const prepared = await prepareReflection(h.service, branch.id, { engineType: 'mock' });
  assert.equal(prepared.status, 'ready'); assert.equal(prepared.plan.expectedFingerprint, null);
  assert.equal(h.calls[0].params.session_id, branch.id);
  assert.deepEqual(await h.service.sidecarClient.request('memory.export_session', { session_id: branch.id }), { notes: [], recap: null });
});

test('memory appendix round trips into new chat id and final remapped project; default exports omit it', async () => {
  const h = harness();
  assert.equal(JSON.parse(exportSession(h.store, 'sess_parent')).session.memory, undefined);
  assert.equal(h.calls.length, 0);
  const json = await exportSession(h.store, 'sess_parent', null, { includeMemory: true, service: h.service });
  const exported = JSON.parse(json); assert.equal(exported.format_version, 1);
  assert.deepEqual(exported.session.memory.notes, h.state.get('sess_parent').notes);
  const imported = await importSession(h.store, json, null, { service: h.service, projectIdRemap: 'project_beta' });
  assert.notEqual(imported.id, 'sess_parent');
  assert.deepEqual(imported.memory, { status: 'imported', imported: 1, skipped: 0 });
  const call = h.calls.find(c => c.method === 'memory.import_session');
  assert.equal(call.params.project_id, 'project_beta');
  assert.deepEqual(call.params.notes, [{ text: 'Prefers tea.', kind: 'preference', origin: 'user' }]);
  assert.equal(call.params.recap, 'Tea preferences.');
  assert.deepEqual(h.state.get(imported.id).notes.map(n => n.text), ['Prefers tea.']);
  assert.equal(h.state.get(imported.id).recap.text, 'Tea preferences.');
  assert.deepEqual(await h.service.sidecarClient.request('memory.chat_sessions', { limit: 1 }), {
    session_ids: ['sess_parent'], truncated: true,
  });
  const general = await importSession(h.store, json, null, { service: h.service });
  assert.equal(h.calls.filter(c => c.method === 'memory.import_session').at(-1).params.project_id, 'project_general');
  assert.ok(general.id);
  const before = h.calls.length;
  importSession(h.store, json, null, { service: h.service, trustedArchive: true, restoredSessionId: 'sess_restored' });
  importSession(h.store, json, null, { service: h.service, trustedArchive: true });
  assert.equal(h.calls.length, before, 'trusted restores never import appendix');
});

test('export bounds notes and redacts appendix before serialization', async () => {
  const h = harness();
  const good = { text: 'Bearer abcdefghijklmnop1234', kind: 'fact', origin: 'user' };
  h.state.set('sess_parent', { notes: [null, { ...good, text: 'x'.repeat(2001) }, { ...good, kind: 'k'.repeat(41) },
    { ...good, origin: 'o'.repeat(41) }, ...Array.from({ length: 205 }, () => good)], recap: null });
  const json = await exportSession(h.store, 'sess_parent', null, { includeMemory: true, service: h.service });
  const memory = JSON.parse(json).session.memory;
  assert.equal(memory.notes.length, 200); assert.equal(json.includes('abcdefghijklmnop1234'), false);
});

test('invalid appendices are dropped with a reason without losing the chat', async () => {
  for (const memory of [[], { notes: 'bad', recap: null }, { notes: [{ text: 'x'.repeat(2001), kind: 'fact', origin: 'user' }], recap: null },
    { notes: Array.from({ length: 201 }, () => ({ text: 'ok', kind: 'fact', origin: 'user' })), recap: null },
    { notes: [], recap: { text: 42 } }]) {
    const h = harness(); const json = JSON.stringify({ format: 'jenny-session-export', session: { title: 'chat', messages: [], memory } });
    const validated = validateSessionImportPayload(json);
    assert.equal(validated.session.memory, undefined); assert.equal(validated.memory_drop_reason, 'invalid_memory_appendix');
    const result = await importSession(h.store, json, null, { service: h.service });
    assert.ok(h.store.getSession(result.id)); assert.equal(h.calls.length, 0);
    assert.equal(h.logs[0][2].reason, 'invalid_memory_appendix');
  }
});

test('sidecar unavailable, empty, refused or failing never blocks chat export/import or leaks text to logs', async () => {
  const h = harness();
  const json = await exportSession(h.store, 'sess_parent', null, { includeMemory: true, service: h.service });
  h.service.sidecarClient.request = async () => { throw new Error('private memory text'); };
  const failedExport = await exportSession(h.store, 'sess_parent', null, { includeMemory: true, service: h.service });
  assert.equal(JSON.parse(failedExport).session.memory, undefined);
  const imported = await importSession(h.store, json, null, { service: h.service });
  assert.ok(h.store.getSession(imported.id)); assert.deepEqual(imported.memory, { status: 'failed', imported: 0, skipped: 0 });
  h.service.sidecarClient.request = async () => ({ status: 'refused', reason: 'private memory text', imported: 0, skipped: 0 });
  const refused = await importSession(h.store, json, null, { service: h.service });
  assert.deepEqual(refused.memory, { status: 'refused', imported: 0, skipped: 0 });
  assert.equal(JSON.stringify(h.logs).includes('private memory text'), false);
  h.service.sidecarClient.request = async () => ({ notes: [], recap: null });
  assert.equal(JSON.parse(await exportSession(h.store, 'sess_parent', null, { includeMemory: true, service: h.service })).session.memory, undefined);
  delete h.service.sidecarClient;
  assert.equal(JSON.parse(await exportSession(h.store, 'sess_parent', null, { includeMemory: true, service: h.service })).session.memory, undefined);
  const offline = await importSession(h.store, json, null, { service: h.service }); assert.ok(offline.id);
});


test('memory failures remain best effort when the service logger throws', async () => {
  const h = harness();
  const json = await exportSession(h.store, 'sess_parent', null, { includeMemory: true, service: h.service });
  h.service._emitServiceLog = () => { throw new Error('logger unavailable'); };
  h.service.sidecarClient.request = async () => { throw new Error('sidecar unavailable'); };
  assert.ok(await exportSession(h.store, 'sess_parent', null, { includeMemory: true, service: h.service }));
  const result = await importSession(h.store, json, null, { service: h.service });
  assert.equal(result.memory.status, 'failed'); assert.ok(h.store.getSession(result.id));
});
