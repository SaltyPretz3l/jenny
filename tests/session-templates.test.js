'use strict';

// Coverage for services/backend/session-templates.js — pure-logic module with
// no Electron dependency.  All tests use Map-backed fakes and call recorders
// so every assertion fails when the guarded behaviour changes.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { SessionTemplateStore, normalizeTemplate, createTemplateId } = require('../services/backend/session-templates');

// ---------------------------------------------------------------------------
// createTemplateId
// ---------------------------------------------------------------------------

describe('createTemplateId', () => {
  test('returns a string starting with "tpl_"', () => {
    const id = createTemplateId();
    assert.equal(typeof id, 'string');
    assert.ok(id.startsWith('tpl_'), `expected "tpl_" prefix, got: ${id}`);
  });

  test('contains a decimal timestamp segment after the prefix', () => {
    const id = createTemplateId();
    // format: tpl_<digits>_<hex>
    assert.match(id, /^tpl_(\d+)_([0-9a-f]+)$/, `id "${id}" did not match tpl_<digits>_<hex>`);
  });

  test('produces unique ids across calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createTemplateId()));
    assert.equal(ids.size, 20, 'expected 20 unique ids');
  });
});

// ---------------------------------------------------------------------------
// normalizeTemplate — null / rejection cases
// ---------------------------------------------------------------------------

describe('normalizeTemplate — rejection cases', () => {
  test('returns null for null input', () => {
    assert.equal(normalizeTemplate(null), null);
  });

  test('returns null for undefined input', () => {
    assert.equal(normalizeTemplate(undefined), null);
  });

  test('returns null for a string input', () => {
    assert.equal(normalizeTemplate('hello'), null);
  });

  test('returns null for a number input', () => {
    assert.equal(normalizeTemplate(42), null);
  });

  test('returns null for an array input', () => {
    assert.equal(normalizeTemplate([{ id: 'x', name: 'y' }]), null);
  });

  test('returns null when id is missing', () => {
    assert.equal(normalizeTemplate({ name: 'My Template' }), null);
  });

  test('returns null when id is blank after trim', () => {
    assert.equal(normalizeTemplate({ id: '   ', name: 'My Template' }), null);
  });

  test('returns null when name is missing', () => {
    assert.equal(normalizeTemplate({ id: 'tpl_001' }), null);
  });

  test('returns null when name is blank after trim', () => {
    assert.equal(normalizeTemplate({ id: 'tpl_001', name: '   ' }), null);
  });
});

// ---------------------------------------------------------------------------
// normalizeTemplate — field normalizations
// ---------------------------------------------------------------------------

describe('normalizeTemplate — field normalizations', () => {
  function base(overrides = {}) {
    return { id: 'tpl_base', name: 'Base Template', ...overrides };
  }

  test('clamps name to 80 characters', () => {
    const longName = 'A'.repeat(120);
    const result = normalizeTemplate(base({ name: longName }));
    assert.notEqual(result, null);
    assert.equal(result.name.length, 80);
    assert.equal(result.name, longName.slice(0, 80));
  });

  test('clamps description to 200 characters', () => {
    const longDesc = 'B'.repeat(300);
    const result = normalizeTemplate(base({ description: longDesc }));
    assert.notEqual(result, null);
    assert.equal(result.description.length, 200);
    assert.equal(result.description, longDesc.slice(0, 200));
  });

  test('trims leading/trailing whitespace from name', () => {
    const result = normalizeTemplate(base({ name: '  My Name  ' }));
    assert.notEqual(result, null);
    assert.equal(result.name, 'My Name');
  });

  test('trims leading/trailing whitespace from description', () => {
    const result = normalizeTemplate(base({ description: '  desc  ' }));
    assert.notEqual(result, null);
    assert.equal(result.description, 'desc');
  });

  test('defaults description to empty string when absent', () => {
    const result = normalizeTemplate(base());
    assert.notEqual(result, null);
    assert.equal(result.description, '');
  });

  // reasoning_effort
  test('normalizes reasoning_effort "low" to "low"', () => {
    assert.equal(normalizeTemplate(base({ reasoning_effort: 'low' })).reasoning_effort, 'low');
  });

  test('normalizes reasoning_effort "medium" to "medium"', () => {
    assert.equal(normalizeTemplate(base({ reasoning_effort: 'medium' })).reasoning_effort, 'medium');
  });

  test('normalizes reasoning_effort "high" to "high"', () => {
    assert.equal(normalizeTemplate(base({ reasoning_effort: 'high' })).reasoning_effort, 'high');
  });

  test('normalizes unknown reasoning_effort to "default"', () => {
    assert.equal(normalizeTemplate(base({ reasoning_effort: 'ultra' })).reasoning_effort, 'default');
  });

  test('normalizes missing reasoning_effort to "default"', () => {
    const result = normalizeTemplate(base());
    assert.equal(result.reasoning_effort, 'default');
  });

  test('normalizes reasoning_effort case-insensitively', () => {
    assert.equal(normalizeTemplate(base({ reasoning_effort: 'HIGH' })).reasoning_effort, 'high');
    assert.equal(normalizeTemplate(base({ reasoning_effort: 'Medium' })).reasoning_effort, 'medium');
  });

  // conversation_mode
  test('normalizes conversation_mode "interactive" to "interactive"', () => {
    assert.equal(
      normalizeTemplate(base({ conversation_mode: 'interactive' })).conversation_mode,
      'interactive'
    );
  });

  test('normalizes conversation_mode "chat" to "chat"', () => {
    assert.equal(
      normalizeTemplate(base({ conversation_mode: 'chat' })).conversation_mode,
      'chat'
    );
  });

  test('normalizes unknown conversation_mode to "chat"', () => {
    assert.equal(
      normalizeTemplate(base({ conversation_mode: 'agent' })).conversation_mode,
      'chat'
    );
  });

  test('normalizes missing conversation_mode to "chat"', () => {
    const result = normalizeTemplate(base());
    assert.equal(result.conversation_mode, 'chat');
  });

  // linked_session_ids
  test('returns [] when linked_session_ids is absent', () => {
    const result = normalizeTemplate(base());
    assert.deepEqual(result.linked_session_ids, []);
  });

  test('returns [] when linked_session_ids is not an array', () => {
    assert.deepEqual(
      normalizeTemplate(base({ linked_session_ids: 'sess-1' })).linked_session_ids,
      []
    );
  });

  test('filters out empty/falsy entries from linked_session_ids', () => {
    const result = normalizeTemplate(base({ linked_session_ids: ['', '  ', 'sess-1', null, 'sess-2'] }));
    assert.deepEqual(result.linked_session_ids, ['sess-1', 'sess-2']);
  });

  test('trims whitespace from each linked_session_id entry', () => {
    const result = normalizeTemplate(base({ linked_session_ids: ['  s1  ', '  s2  '] }));
    assert.deepEqual(result.linked_session_ids, ['s1', 's2']);
  });

  test('slices linked_session_ids to at most 8 entries', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `sess-${i}`);
    const result = normalizeTemplate(base({ linked_session_ids: ids }));
    assert.equal(result.linked_session_ids.length, 8);
    assert.deepEqual(result.linked_session_ids, ids.slice(0, 8));
  });

  // context_preferences passthrough
  test('normalizes context_preferences to canonical shape', () => {
    const result = normalizeTemplate(base({ context_preferences: { include_personality: false } }));
    assert.notEqual(result, null);
    assert.equal(typeof result.context_preferences, 'object');
    assert.equal(result.context_preferences.include_personality, false);
    // defaults should be present
    assert.equal(typeof result.context_preferences.history_scope, 'string');
  });
});

// ---------------------------------------------------------------------------
// Fake shellConfigService factory
// ---------------------------------------------------------------------------

function createFakeShellConfig(initial = []) {
  const store = new Map();
  store.set('session_templates', initial);
  const getCalls = [];
  const setCalls = [];
  return {
    service: {
      get(key) {
        getCalls.push(key);
        return store.get(key);
      },
      set(key, value) {
        setCalls.push([key, value]);
        store.set(key, value);
      },
    },
    getCalls,
    setCalls,
    store,
  };
};

// ---------------------------------------------------------------------------
// SessionTemplateStore — list()
// ---------------------------------------------------------------------------

describe('SessionTemplateStore.list()', () => {
  test('returns an empty array when shellConfigService.get returns undefined', () => {
    const fake = createFakeShellConfig(undefined);
    fake.store.set('session_templates', undefined);
    const tplStore = new SessionTemplateStore(fake.service);
    const result = tplStore.list();
    assert.deepEqual(result, []);
  });

  test('returns an empty array when store holds an empty array', () => {
    const fake = createFakeShellConfig([]);
    const tplStore = new SessionTemplateStore(fake.service);
    assert.deepEqual(tplStore.list(), []);
  });

  test('returns normalized templates from the store', () => {
    const raw = [{ id: 'tpl_1', name: 'Alpha', reasoning_effort: 'high' }];
    const fake = createFakeShellConfig(raw);
    const tplStore = new SessionTemplateStore(fake.service);
    const result = tplStore.list();
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'tpl_1');
    assert.equal(result[0].name, 'Alpha');
    assert.equal(result[0].reasoning_effort, 'high');
  });

  test('filters out invalid (non-normalizable) entries', () => {
    const raw = [
      { id: 'tpl_1', name: 'Good' },
      { id: '', name: 'Bad — missing id' },
      null,
      { id: 'tpl_2', name: 'Also Good' },
    ];
    const fake = createFakeShellConfig(raw);
    const tplStore = new SessionTemplateStore(fake.service);
    const result = tplStore.list();
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'tpl_1');
    assert.equal(result[1].id, 'tpl_2');
  });

  test('records a get() call on the shellConfigService with key "session_templates"', () => {
    const fake = createFakeShellConfig([]);
    const tplStore = new SessionTemplateStore(fake.service);
    tplStore.list();
    assert.ok(fake.getCalls.includes('session_templates'), 'get("session_templates") was never called');
  });
});

// ---------------------------------------------------------------------------
// SessionTemplateStore — save()
// ---------------------------------------------------------------------------

describe('SessionTemplateStore.save()', () => {
  test('returns null when template is invalid (missing name)', () => {
    const fake = createFakeShellConfig([]);
    const tplStore = new SessionTemplateStore(fake.service);
    const result = tplStore.save({ id: 'tpl_x' }); // no name
    assert.equal(result, null);
  });

  test('pushes a new template when id does not already exist', () => {
    const fake = createFakeShellConfig([]);
    const tplStore = new SessionTemplateStore(fake.service);
    const saved = tplStore.save({ id: 'tpl_new', name: 'New Template' });
    assert.notEqual(saved, null);
    assert.equal(saved.id, 'tpl_new');
    assert.equal(saved.name, 'New Template');
    // The written array must contain exactly the new template
    assert.equal(fake.setCalls.length, 1);
    const [key, written] = fake.setCalls[0];
    assert.equal(key, 'session_templates');
    assert.equal(written.length, 1);
    assert.equal(written[0].id, 'tpl_new');
  });

  test('replaces an existing template by id', () => {
    const raw = [{ id: 'tpl_1', name: 'Original', reasoning_effort: 'low' }];
    const fake = createFakeShellConfig(raw);
    const tplStore = new SessionTemplateStore(fake.service);
    const saved = tplStore.save({ id: 'tpl_1', name: 'Updated', reasoning_effort: 'high' });
    assert.notEqual(saved, null);
    assert.equal(saved.name, 'Updated');
    assert.equal(saved.reasoning_effort, 'high');
    // Only one entry in the array after update
    const [, written] = fake.setCalls[0];
    assert.equal(written.length, 1);
    assert.equal(written[0].name, 'Updated');
  });

  test('auto-generates an id when none is provided', () => {
    const fake = createFakeShellConfig([]);
    const tplStore = new SessionTemplateStore(fake.service);
    const saved = tplStore.save({ name: 'Auto ID Template' });
    assert.notEqual(saved, null);
    assert.equal(typeof saved.id, 'string');
    assert.ok(saved.id.startsWith('tpl_'), `expected auto-generated id to start with "tpl_", got: ${saved.id}`);
  });

  test('calls shellConfigService.set() with key "session_templates" and the saved payload', () => {
    const fake = createFakeShellConfig([]);
    const tplStore = new SessionTemplateStore(fake.service);
    tplStore.save({ id: 'tpl_z', name: 'Zeta' });
    assert.equal(fake.setCalls.length, 1, 'set() should have been called exactly once');
    const [setKey, setVal] = fake.setCalls[0];
    assert.equal(setKey, 'session_templates');
    assert.ok(Array.isArray(setVal), 'set() value must be an array');
    assert.equal(setVal.some((t) => t.id === 'tpl_z' && t.name === 'Zeta'), true,
      'set() payload must contain the saved template');
  });

  test('does not call set() when template is invalid', () => {
    const fake = createFakeShellConfig([]);
    const tplStore = new SessionTemplateStore(fake.service);
    tplStore.save({ id: '  ', name: 'Has blank id' }); // blank id → normalizeTemplate returns null
    assert.equal(fake.setCalls.length, 0, 'set() must NOT be called when the template is invalid');
  });
});

// ---------------------------------------------------------------------------
// SessionTemplateStore — MAX_TEMPLATES clamp (20)
// ---------------------------------------------------------------------------

describe('SessionTemplateStore — MAX_TEMPLATES clamp', () => {
  test('clamps stored list to 20 entries when saving into a full store', () => {
    // Pre-populate 20 templates
    const initial = Array.from({ length: 20 }, (_, i) => ({ id: `tpl_${i}`, name: `T${i}` }));
    const fake = createFakeShellConfig(initial);
    const tplStore = new SessionTemplateStore(fake.service);
    // Save a 21st — it is pushed but the slice(0, 20) means only 20 survive
    tplStore.save({ id: 'tpl_21st', name: 'Twenty-First' });
    const [, written] = fake.setCalls[fake.setCalls.length - 1];
    assert.equal(written.length, 20, `expected exactly 20 stored templates, got ${written.length}`);
  });
});

// ---------------------------------------------------------------------------
// SessionTemplateStore — delete()
// ---------------------------------------------------------------------------

describe('SessionTemplateStore.delete()', () => {
  test('returns false when the template id is not found', () => {
    const fake = createFakeShellConfig([{ id: 'tpl_1', name: 'Alpha' }]);
    const tplStore = new SessionTemplateStore(fake.service);
    const result = tplStore.delete('tpl_nonexistent');
    assert.equal(result, false);
  });

  test('returns false when an empty id string is given', () => {
    const fake = createFakeShellConfig([{ id: 'tpl_1', name: 'Alpha' }]);
    const tplStore = new SessionTemplateStore(fake.service);
    assert.equal(tplStore.delete(''), false);
    assert.equal(tplStore.delete('  '), false);
  });

  test('returns true and removes the template when found', () => {
    const raw = [
      { id: 'tpl_1', name: 'Alpha' },
      { id: 'tpl_2', name: 'Beta' },
    ];
    const fake = createFakeShellConfig(raw);
    const tplStore = new SessionTemplateStore(fake.service);
    const result = tplStore.delete('tpl_1');
    assert.equal(result, true);
    // Persisted array must only contain the remaining template
    const [, written] = fake.setCalls[0];
    assert.equal(written.length, 1);
    assert.equal(written[0].id, 'tpl_2');
  });

  test('calls set() with the remaining templates after deletion', () => {
    const raw = [{ id: 'tpl_1', name: 'Alpha' }];
    const fake = createFakeShellConfig(raw);
    const tplStore = new SessionTemplateStore(fake.service);
    tplStore.delete('tpl_1');
    assert.equal(fake.setCalls.length, 1, 'set() must be called once on successful delete');
    const [key, val] = fake.setCalls[0];
    assert.equal(key, 'session_templates');
    assert.equal(val.length, 0);
  });

  test('does NOT call set() when the template is not found', () => {
    const fake = createFakeShellConfig([{ id: 'tpl_1', name: 'Alpha' }]);
    const tplStore = new SessionTemplateStore(fake.service);
    tplStore.delete('tpl_missing');
    assert.equal(fake.setCalls.length, 0, 'set() must NOT be called when nothing was removed');
  });
});

// ---------------------------------------------------------------------------
// SessionTemplateStore — apply()
// ---------------------------------------------------------------------------

describe('SessionTemplateStore.apply()', () => {
  function makeSessionStoreSpy() {
    const createSessionCalls = [];
    return {
      service: {
        createSession(opts) {
          createSessionCalls.push(opts);
          return { sessionId: 'new-sess', title: opts.title };
        },
      },
      createSessionCalls,
    };
  }

  test('returns null when the template id is not found', () => {
    const fake = createFakeShellConfig([{ id: 'tpl_1', name: 'Alpha' }]);
    const tplStore = new SessionTemplateStore(fake.service);
    const spy = makeSessionStoreSpy();
    const result = tplStore.apply('tpl_nonexistent', spy.service);
    assert.equal(result, null);
    assert.equal(spy.createSessionCalls.length, 0, 'createSession must NOT be called for a missing template');
  });

  test('calls sessionStore.createSession with the template preferences and returns the result', () => {
    const raw = [{
      id: 'tpl_1',
      name: 'Alpha',
      reasoning_effort: 'high',
      conversation_mode: 'interactive',
      preferred_model: 'gemma3',
      linked_session_ids: ['sess-a', 'sess-b'],
    }];
    const fake = createFakeShellConfig(raw);
    const tplStore = new SessionTemplateStore(fake.service);
    const spy = makeSessionStoreSpy();
    const result = tplStore.apply('tpl_1', spy.service);
    // Verify the session was created
    assert.equal(spy.createSessionCalls.length, 1, 'createSession must be called exactly once');
    const callArg = spy.createSessionCalls[0];
    assert.equal(callArg.title, 'Alpha session');
    assert.equal(callArg.preferences.reasoning_effort, 'high');
    assert.equal(callArg.preferences.conversation_mode, 'interactive');
    assert.equal(callArg.preferences.preferred_model, 'gemma3');
    assert.deepEqual(callArg.preferences.linked_session_ids, ['sess-a', 'sess-b']);
    // apply() returns the value from createSession
    assert.notEqual(result, null);
    assert.equal(result.sessionId, 'new-sess');
    assert.equal(result.title, 'Alpha session');
  });

  test('passes context_preferences from the template into the session', () => {
    const raw = [{
      id: 'tpl_2',
      name: 'Beta',
      context_preferences: { include_personality: false, history_scope: 'session' },
    }];
    const fake = createFakeShellConfig(raw);
    const tplStore = new SessionTemplateStore(fake.service);
    const spy = makeSessionStoreSpy();
    tplStore.apply('tpl_2', spy.service);
    assert.equal(spy.createSessionCalls.length, 1);
    const prefs = spy.createSessionCalls[0].preferences;
    assert.equal(typeof prefs.context_preferences, 'object');
    assert.equal(prefs.context_preferences.include_personality, false);
    assert.equal(prefs.context_preferences.history_scope, 'session');
  });
});

// ---------------------------------------------------------------------------
// SessionTemplateStore — null / missing shellConfigService guards
// ---------------------------------------------------------------------------

describe('SessionTemplateStore — missing shellConfigService', () => {
  test('list() returns [] when shellConfigService is null', () => {
    const tplStore = new SessionTemplateStore(null);
    assert.deepEqual(tplStore.list(), []);
  });

  test('list() returns [] when shellConfigService has no get method', () => {
    const tplStore = new SessionTemplateStore({});
    assert.deepEqual(tplStore.list(), []);
  });

  test('save() does not throw when shellConfigService is null (returns null for invalid or skips write)', () => {
    const tplStore = new SessionTemplateStore(null);
    // A valid template shape: normalizeTemplate succeeds but _writeTemplates is a no-op
    // save() should complete without throwing and still return the normalized template
    assert.doesNotThrow(() => {
      tplStore.save({ id: 'tpl_x', name: 'X' });
    });
    const result = tplStore.save({ id: 'tpl_x', name: 'X' });
    assert.notEqual(result, null);
    assert.equal(result.id, 'tpl_x');
    assert.equal(result.name, 'X');
  });

  test('delete() returns false when shellConfigService is null', () => {
    const tplStore = new SessionTemplateStore(null);
    assert.equal(tplStore.delete('tpl_x'), false);
  });
});
