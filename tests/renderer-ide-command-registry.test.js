'use strict';

/* Workspace IDE command registry (row 82 seed): one table of commands with VS Code
 * chord spelling, `when` guards and palette rows. Plain stubs, no DOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeCommandRegistry,
  normalizeChord,
  stepFromEvent,
  displayChord,
} = require('../renderer/features/renderer-ide-command-registry');

function key(overrides) {
  return Object.assign({ key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, overrides);
}

test('normalizeChord canonicalizes modifier order, case and chord steps', () => {
  assert.equal(normalizeChord('Shift+Ctrl+P'), 'ctrl+shift+p');
  assert.equal(normalizeChord('ctrl+k  ctrl+w'), 'ctrl+k ctrl+w');
  assert.equal(normalizeChord('Cmd+\\'), 'ctrl+\\');
  assert.equal(normalizeChord('F8'), 'f8');
  assert.equal(normalizeChord('ctrl+='), 'ctrl+=');
  assert.equal(normalizeChord('ctrl++'), 'ctrl++');
  assert.equal(normalizeChord(''), '');
  assert.equal(normalizeChord('ctrl+'), '');
});

test('stepFromEvent reads letters from key and punctuation from code', () => {
  assert.equal(stepFromEvent(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })), 'ctrl+shift+p');
  assert.equal(stepFromEvent(key({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true })), 'ctrl+shift+`');
  assert.equal(stepFromEvent(key({ key: '|', code: 'Backslash', ctrlKey: true })), 'ctrl+\\');
  assert.equal(stepFromEvent(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true })), 'ctrl+shift+1');
  assert.equal(stepFromEvent(key({ key: 'F1', code: 'F1' })), 'f1');
  assert.equal(stepFromEvent(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true })), '');
  assert.equal(stepFromEvent(key({ key: 'k', code: 'KeyK', metaKey: true })), 'ctrl+k');
});

test('displayChord renders the palette hint', () => {
  assert.equal(displayChord('ctrl+shift+p'), 'Ctrl+Shift+P');
  assert.equal(displayChord('ctrl+k ctrl+w'), 'Ctrl+K Ctrl+W');
  assert.equal(displayChord('f8'), 'F8');
  assert.equal(displayChord('ctrl+`'), 'Ctrl+`');
});

test('register validates ids and runs, derives the hint, and lists by when(ctx)', () => {
  const registry = createIdeCommandRegistry();
  assert.throws(() => registry.register({ id: 'goToLine', run() {} }), /ide:verb-object/);
  assert.throws(() => registry.register({ id: 'ide:go-to-line' }), /run/);
  const calls = [];
  const dispose = registry.register({
    id: 'ide:go-to-line',
    label: 'Go to Line/Column...',
    keys: ['Ctrl+G'],
    when: (ctx) => ctx.activeView === 'ide' && ctx.hasActiveFile === true,
    run: (ctx) => calls.push(ctx),
  });
  registry.register({ id: 'ide:toggle-panel', label: 'View: Toggle Panel', keys: ['ctrl+j'], run() { calls.push('panel'); } });

  const ide = registry.list({ ctx: { activeView: 'ide', hasActiveFile: true } });
  assert.deepEqual(ide.map((r) => r.id).sort(), ['ide:go-to-line', 'ide:toggle-panel']);
  assert.equal(ide.find((r) => r.id === 'ide:go-to-line').hint, 'Ctrl+G');
  assert.equal(ide.find((r) => r.id === 'ide:go-to-line').group, 'Workspace');

  const noFile = registry.list({ ctx: { activeView: 'ide', hasActiveFile: false } });
  assert.deepEqual(noFile.map((r) => r.id), ['ide:toggle-panel']);
  assert.deepEqual(registry.list({ ctx: { activeView: 'chat' } }), []);

  assert.equal(registry.run('ide:go-to-line', { activeView: 'ide', hasActiveFile: false }), false);
  assert.equal(registry.run('ide:go-to-line', { activeView: 'ide', hasActiveFile: true }), true);
  assert.equal(calls.length, 1);
  ide.find((r) => r.id === 'ide:toggle-panel').run();
  assert.equal(calls[1], 'panel');

  dispose();
  assert.equal(registry.get('ide:go-to-line'), null);
  assert.deepEqual(registry.bindings(), [{ chord: 'ctrl+j', id: 'ide:toggle-panel' }]);
});

test('a throwing when() hides the command instead of breaking the palette', () => {
  const registry = createIdeCommandRegistry();
  registry.register({ id: 'ide:bad', when() { throw new Error('boom'); }, run() {} });
  assert.deepEqual(registry.list({ ctx: { activeView: 'ide' } }), []);
  assert.equal(registry.run('ide:bad', {}), false);
});

test('resolveChord handles single chords, two-step chords and the when guard', () => {
  const registry = createIdeCommandRegistry();
  registry.register({ id: 'ide:command-palette', keys: ['ctrl+shift+p', 'f1'], run() {} });
  registry.register({ id: 'ide:close-all-editors', keys: ['ctrl+k ctrl+w'], run() {} });
  registry.register({ id: 'ide:save-all', keys: ['ctrl+k s'], run() {} });
  registry.register({ id: 'ide:focus-group-2', keys: ['ctrl+2'], when: (ctx) => ctx.groupCount >= 1, run() {} });
  const ctx = { activeView: 'ide', groupCount: 1 };

  assert.deepEqual(registry.resolveChord(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), null, ctx), { id: 'ide:command-palette' });
  assert.deepEqual(registry.resolveChord(key({ key: 'F1', code: 'F1' }), null, ctx), { id: 'ide:command-palette' });
  assert.deepEqual(registry.resolveChord(key({ key: 'k', code: 'KeyK', ctrlKey: true }), null, ctx), { pending: 'ctrl+k' });
  assert.deepEqual(registry.resolveChord(key({ key: 'w', code: 'KeyW', ctrlKey: true }), 'ctrl+k', ctx), { id: 'ide:close-all-editors' });
  assert.deepEqual(registry.resolveChord(key({ key: 's', code: 'KeyS' }), 'ctrl+k', ctx), { id: 'ide:save-all' });
  assert.equal(registry.resolveChord(key({ key: 'z', code: 'KeyZ' }), 'ctrl+k', ctx), null);
  assert.equal(registry.resolveChord(key({ key: 'x', code: 'KeyX', ctrlKey: true }), null, ctx), null);
  assert.deepEqual(registry.resolveChord(key({ key: '2', code: 'Digit2', ctrlKey: true }), null, ctx), { id: 'ide:focus-group-2' });
  assert.equal(registry.resolveChord(key({ key: '2', code: 'Digit2', ctrlKey: true }), null, { activeView: 'ide', groupCount: 0 }), null);
  assert.equal(registry.resolveChord(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), null, { activeView: 'chat' }), null);
});

test('ctrl+k alone resolves to nothing when no two-step chord is registered', () => {
  const registry = createIdeCommandRegistry();
  registry.register({ id: 'ide:toggle-panel', keys: ['ctrl+j'], run() {} });
  assert.equal(registry.resolveChord(key({ key: 'k', code: 'KeyK', ctrlKey: true }), null, { activeView: 'ide' }), null);
});

test('the first registration of a chord wins and re-registering an id replaces it', () => {
  const registry = createIdeCommandRegistry();
  registry.register({ id: 'ide:one', keys: ['ctrl+j'], run() {} });
  registry.register({ id: 'ide:two', keys: ['ctrl+j'], run() {} });
  assert.deepEqual(registry.bindings(), [{ chord: 'ctrl+j', id: 'ide:one' }]);
  registry.register({ id: 'ide:one', keys: ['ctrl+b'], run() {} });
  assert.deepEqual(registry.bindings().sort((a, b) => a.chord.localeCompare(b.chord)), [
    { chord: 'ctrl+b', id: 'ide:one' },
    { chord: 'ctrl+j', id: 'ide:two' },
  ]);
});
