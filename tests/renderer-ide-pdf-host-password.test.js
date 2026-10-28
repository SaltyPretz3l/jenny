'use strict';

// Row 65 W4: password-protected PDFs in the Workspace IDE pane. A first open
// commits a locked tab that prompts in place; the password stays in memory
// for that tab only, a reload reuses it once, and it is never logged.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FakePDFViewer, keydown, loadFixture, makePane, makePdfjsHarness, tick } = require('./helpers/ide-pdf-pane-harness');

async function settle() {
  for (let i = 0; i < 8; i += 1) await tick();
}

function submitPassword(env, value) {
  const input = env.host.querySelector('.ide-pdf-password input');
  assert.ok(input, 'password prompt is shown');
  input.value = value;
  keydown(env, input, { key: 'Enter' });
}

function makeLockedPane(password, options = {}) {
  const logs = [];
  const env = makePane({ harness: makePdfjsHarness({ password }), log: (...entry) => logs.push(entry), ...options });
  return { env, logs };
}

test('an encrypted first open commits a locked tab that prompts in place', async (t) => {
  const { env } = makeLockedPane('secret');
  t.after(() => env.pane.dispose());

  const { result } = await loadFixture(env);
  assert.deepEqual(result, { ok: true, pageCount: 0, locked: true });
  assert.equal(env.pane.hasDocument('docs/text.pdf'), true);
  assert.equal(FakePDFViewer.instances.length, 0, 'no viewer before the password');
  assert.equal(env.pane.getReadingContext('docs/text.pdf'), null);

  assert.equal(env.pane.show('docs/text.pdf'), true);
  const input = env.host.querySelector('.ide-pdf-doc:not(.hidden) .ide-pdf-password input');
  assert.ok(input);
  assert.equal(input.type, 'password');
  assert.equal(env.dom.window.document.activeElement, input);
  assert.equal(env.host.querySelector('.ide-pdf-password-error').hidden, true);
});

test('a wrong password asks again with the retry line; the right one mounts the viewer', async (t) => {
  const { env } = makeLockedPane('secret');
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');

  submitPassword(env, 'nope');
  await settle();
  assert.equal(env.host.querySelector('.ide-pdf-password-error').hidden, false);
  assert.equal(env.host.querySelector('.ide-pdf-password input').value, '');
  // A wrong entry is not replayed: pdf.js gets each attempt once.
  assert.deepEqual(env.harness.tasks[0].passwordsTried, ['nope']);

  submitPassword(env, 'secret');
  await settle();
  assert.deepEqual(env.harness.tasks[0].passwordsTried, ['nope', 'secret']);
  assert.equal(env.host.querySelector('.ide-pdf-password'), null);
  assert.equal(FakePDFViewer.instances.length, 1);
  assert.equal(env.pane.getState('docs/text.pdf').pageCount, 2);
  assert.equal(FakePDFViewer.instances[0].updatedWhileVisible, true, 'mounted and shown in place');
});

test('an empty entry keeps the prompt and sends nothing', async (t) => {
  const { env } = makeLockedPane('secret');
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  submitPassword(env, '');
  await settle();
  assert.deepEqual(env.harness.tasks[0].passwordsTried, []);
  assert.ok(env.host.querySelector('.ide-pdf-password input'));
});

test('a locked background tab never covers or steals focus from the visible document', async (t) => {
  const env = makePane({ harness: makePdfjsHarness({ password: [null, 'secret'] }) });
  t.after(() => env.pane.dispose());
  await loadFixture(env, 'docs/plain.pdf');
  env.pane.show('docs/plain.pdf');
  const visibleScroller = env.host.querySelector('.ide-pdf-doc:not(.hidden) .ide-pdf-viewer-scroll');
  visibleScroller.focus();

  const { result } = await loadFixture(env, 'docs/locked.pdf');
  assert.equal(result.locked, true);
  const lockedContainer = env.host.querySelector('.ide-pdf-password').closest('.ide-pdf-doc');
  assert.equal(lockedContainer.classList.contains('hidden'), true);
  assert.equal(env.dom.window.document.activeElement, visibleScroller);

  env.pane.show('docs/locked.pdf');
  assert.equal(env.dom.window.document.activeElement, env.host.querySelector('.ide-pdf-doc:not(.hidden) .ide-pdf-password input'));
});

test('a reload reuses the tab password once and never prompts', async (t) => {
  const { env } = makeLockedPane(['secret', 'secret']);
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  submitPassword(env, 'secret');
  await settle();

  const { result } = await loadFixture(env);
  assert.equal(result.ok, true);
  assert.equal(result.locked, undefined);
  assert.deepEqual(env.harness.tasks[1].passwordsTried, ['secret']);
  assert.equal(env.host.querySelector('.ide-pdf-password'), null);
});

test('a reload whose password stopped working fails and keeps the live document', async (t) => {
  const { env } = makeLockedPane(['secret', 'changed']);
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  submitPassword(env, 'secret');
  await settle();
  const liveViewer = FakePDFViewer.instances[0];

  const { result } = await loadFixture(env);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'document_unsupported');
  assert.match(result.message, /needs a password/i);
  assert.ok(env.harness.tasks[1].destroyCalls >= 1, 'the refused load is torn down');
  assert.equal(env.host.querySelector('.ide-pdf-password'), null, 'no hidden prompt left behind');
  assert.equal(env.pane.hasDocument('docs/text.pdf'), true);
  assert.equal(liveViewer.document, env.harness.documents[0], 'the live document survives');
  assert.equal(env.host.querySelector('.ide-pdf-error').classList.contains('hidden'), true);
});

test('closing a locked tab destroys its loading task and prompt', async (t) => {
  const { env } = makeLockedPane('secret');
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  env.pane.close('docs/text.pdf');
  assert.equal(env.harness.tasks[0].destroyCalls, 1);
  assert.equal(env.host.querySelector('.ide-pdf-password'), null);
  assert.equal(env.pane.hasDocument('docs/text.pdf'), false);
});

test('the password never reaches the log or the pane state', async (t) => {
  const { env, logs } = makeLockedPane(['secret-value-123', 'other']);
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  submitPassword(env, 'wrong-value-456');
  await settle();
  submitPassword(env, 'secret-value-123');
  await settle();
  await loadFixture(env); // a failed reload logs its failure
  const recorded = JSON.stringify(logs) + JSON.stringify(env.pane.getState('docs/text.pdf'));
  assert.ok(logs.length > 0, 'the failed reload was logged');
  assert.doesNotMatch(recorded, /secret-value-123|wrong-value-456/);
});

test('toolbar actions are inert while a tab is locked', async (t) => {
  const { env } = makeLockedPane('secret');
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  env.host.querySelector('[data-ide-pdf-action="zoom-in"]').click();
  env.host.querySelector('[data-ide-pdf-action="highlight"]').click();
  assert.equal(env.pane.getState('docs/text.pdf').scale, 'page-width');
  assert.equal(env.pane.getState('docs/text.pdf').editorMode, 'none');
  assert.equal(env.pane.getViewPosition('docs/text.pdf'), null);
});

test('a reload that fails while the prompt is up leaves the prompt working', async (t) => {
  const env = makePane({ harness: makePdfjsHarness({ password: ['secret', null], rejections: [null, { name: 'InvalidPDFException' }] }) });
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const { result } = await loadFixture(env);
  assert.equal(result.ok, false);
  assert.equal(env.pane.hasDocument('docs/text.pdf'), true, 'the locked tab survives');
  submitPassword(env, 'secret');
  await settle();
  assert.equal(env.host.querySelector('.ide-pdf-password'), null);
  assert.equal(FakePDFViewer.instances.length, 1, 'the viewer mounts');
  assert.equal(env.pane.getState('docs/text.pdf').pageCount, 2);
});
