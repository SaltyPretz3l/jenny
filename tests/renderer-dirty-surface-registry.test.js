'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createDirtySurfaceRegistry,
  dirtySurfaces,
} = require('../renderer/features/renderer-window-exit-preflight');

function surface(id, overrides = {}) {
  let dirty = overrides.dirty !== undefined ? overrides.dirty : true;
  return {
    id,
    label: overrides.label || id,
    isDirty: overrides.isDirty || (() => dirty),
    save: overrides.save || (async () => { dirty = false; return true; }),
    setDirty: (value) => { dirty = value; },
  };
}

test('listDirty returns only the surfaces that report unsaved changes', () => {
  const registry = createDirtySurfaceRegistry();
  const notes = surface('memory-notes', { label: 'Long-term notes' });
  const persona = surface('personality', { label: 'Personality' });
  registry.register(notes);
  registry.register(persona);
  persona.setDirty(false);

  const dirty = registry.listDirty();
  assert.deepEqual(dirty.map((entry) => [entry.id, entry.label]), [['memory-notes', 'Long-term notes']]);
  assert.equal(typeof dirty[0].save, 'function');
});

test('register returns an unregister function that removes exactly that surface', () => {
  const registry = createDirtySurfaceRegistry();
  const unregister = registry.register(surface('memory-notes'));
  registry.register(surface('personality'));

  unregister();
  assert.deepEqual(registry.listDirty().map((entry) => entry.id), ['personality']);
  unregister();
  assert.deepEqual(registry.listDirty().map((entry) => entry.id), ['personality'], 'a second unregister is a no-op');
});

test('re-registering an id replaces the older entry and a stale unregister leaves the new one', () => {
  const registry = createDirtySurfaceRegistry();
  const unregisterOld = registry.register(surface('memory-notes', { label: 'old' }));
  registry.register(surface('memory-notes', { label: 'new' }));

  unregisterOld();
  assert.deepEqual(registry.listDirty().map((entry) => entry.label), ['new']);
});

test('a throwing isDirty is treated as clean and invalid specs register nothing', () => {
  const registry = createDirtySurfaceRegistry();
  registry.register(surface('broken', { isDirty: () => { throw new Error('boom'); } }));
  const noop = registry.register({ id: 'no-save', isDirty: () => true });
  registry.register(null);

  assert.equal(typeof noop, 'function');
  assert.deepEqual(registry.listDirty(), []);
});

test('the module exposes a shared singleton registry', () => {
  assert.equal(typeof dirtySurfaces.register, 'function');
  assert.equal(typeof dirtySurfaces.listDirty, 'function');
});
