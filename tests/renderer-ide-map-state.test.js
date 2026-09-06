'use strict';

/* tests/renderer-ide-map-state.test.js - red-first coverage for
 * renderer/features/renderer-ide-map-states.js. Uses jsdom directly (no
 * dependency on the full IDE controller harness — this module is a standalone
 * leaf renderer), and always disposes via t.after() rather than
 * dom.window.close(), per the project's test-cleanup convention. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createMapStates } = require('../renderer/features/renderer-ide-map-states');

function setupDom() {
  const dom = new JSDOM('<div id="host"></div>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const hostEl = dom.window.document.getElementById('host');
  return {
    dom,
    hostEl,
    teardown() {
      globalThis.window = previousWindow;
    },
  };
}

test('idle state renders copy + Generate Map action, fires onGenerate', (t) => {
  const { dom, hostEl, teardown } = setupDom();
  let generated = 0;
  const states = createMapStates({ hostEl, onGenerate: () => { generated += 1; } });
  t.after(() => { states.dispose(); teardown(); });

  states.render('idle');
  assert.match(hostEl.textContent, /Generate a map of this workspace\./);
  const btn = hostEl.querySelector('[data-map-state-action="generate"]');
  assert.ok(btn, 'expected Generate Map action button');
  assert.match(btn.textContent, /Generate Map/);

  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(generated, 1);
});

test('loading state renders "Building the map…" copy with a pulsing tone dot', (t) => {
  const { hostEl, teardown } = setupDom();
  const states = createMapStates({ hostEl });
  t.after(() => { states.dispose(); teardown(); });

  states.render('loading');
  assert.match(hostEl.textContent, /Building the map…/);
  assert.ok(hostEl.querySelector('.inv-status-row-dot'), 'expected the status-row tone dot');
  assert.ok(
    hostEl.querySelector('.inv-status-row--with-spinner'),
    'expected the dot to be flagged as pulsing while work is in flight'
  );
  assert.equal(hostEl.querySelector('.inv-spinner'), null, 'the spinner glyph is retired');
});

test('empty state renders the empty-workspace copy', (t) => {
  const { hostEl, teardown } = setupDom();
  const states = createMapStates({ hostEl });
  t.after(() => { states.dispose(); teardown(); });

  states.render('empty');
  assert.match(hostEl.textContent, /Workspace is empty — nothing to map\./);
});

test('error state interpolates {message} into copy and renders a danger-tone Retry action', (t) => {
  const { dom, hostEl, teardown } = setupDom();
  let retried = 0;
  const states = createMapStates({ hostEl, onRetry: () => { retried += 1; } });
  t.after(() => { states.dispose(); teardown(); });

  states.render('error', { message: 'ENOENT: scan failed' });
  assert.match(hostEl.textContent, /Couldn't build the map\. ENOENT: scan failed/);
  const btn = hostEl.querySelector('[data-map-state-action="retry"]');
  assert.ok(btn, 'expected a Retry action button');
  assert.match(btn.textContent, /Retry/);
  assert.match(btn.className, /btn--danger/, 'Retry action should carry the danger tone');

  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(retried, 1);
});

test('error state escapes message HTML', (t) => {
  const { hostEl, teardown } = setupDom();
  const states = createMapStates({ hostEl });
  t.after(() => { states.dispose(); teardown(); });

  states.render('error', { message: '<script>alert(1)</script>' });
  assert.equal(hostEl.querySelector('script'), null);
  assert.match(hostEl.innerHTML, /&lt;script&gt;/);
});

test('no-root state renders copy + Choose Folder action, fires onChooseFolder', (t) => {
  const { dom, hostEl, teardown } = setupDom();
  let chosen = 0;
  const states = createMapStates({ hostEl, onChooseFolder: () => { chosen += 1; } });
  t.after(() => { states.dispose(); teardown(); });

  states.render('no-root');
  assert.match(hostEl.textContent, /Choose a workspace folder to map\./);
  const btn = hostEl.querySelector('[data-map-state-action="choose-folder"]');
  assert.ok(btn);
  assert.match(btn.textContent, /Choose Folder/);

  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(chosen, 1);
});

test('render() rejects an unknown state name', (t) => {
  const { hostEl, teardown } = setupDom();
  const states = createMapStates({ hostEl });
  t.after(() => { states.dispose(); teardown(); });

  assert.throws(() => states.render('bogus'), /unknown state/);
});

test('clear() empties the host and resets currentState', (t) => {
  const { hostEl, teardown } = setupDom();
  const states = createMapStates({ hostEl });
  t.after(() => { states.dispose(); teardown(); });

  states.render('idle');
  assert.notEqual(hostEl.innerHTML, '');
  assert.equal(states.currentState, 'idle');

  states.clear();
  assert.equal(hostEl.innerHTML, '');
  assert.equal(states.currentState, null);
  // The host is an inset-0 OPAQUE cover: cleared must mean hidden, or an
  // empty host silently blanks the rendered map underneath (the blank-atlas
  // incident). render() must un-hide it again.
  assert.ok(hostEl.classList.contains('hidden'), 'clear() must hide the opaque cover');
  states.render('loading');
  assert.ok(!hostEl.classList.contains('hidden'), 'render() must un-hide the cover');
});

test('hide()/show() toggle the hidden class without clearing content', (t) => {
  const { hostEl, teardown } = setupDom();
  const states = createMapStates({ hostEl });
  t.after(() => { states.dispose(); teardown(); });

  states.render('idle');
  states.hide();
  assert.ok(hostEl.classList.contains('hidden'));
  assert.notEqual(hostEl.innerHTML, '', 'hide() should not clear rendered markup');

  states.show();
  assert.ok(!hostEl.classList.contains('hidden'));
});

test('dispose() is idempotent and stops delegated actions from firing', (t) => {
  const { dom, hostEl, teardown } = setupDom();
  let generated = 0;
  const states = createMapStates({ hostEl, onGenerate: () => { generated += 1; } });
  t.after(teardown);

  states.render('idle');
  const btn = hostEl.querySelector('[data-map-state-action="generate"]');
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(generated, 1);

  states.dispose();
  assert.equal(hostEl.innerHTML, '');

  // Second dispose() must not throw.
  assert.doesNotThrow(() => states.dispose());

  // render() after dispose is a no-op (host stays empty, no throw).
  assert.doesNotThrow(() => states.render('idle'));
  assert.equal(hostEl.innerHTML, '');
});

test('no raw HTML primitives are emitted (policy: inventory components only)', (t) => {
  const { hostEl, teardown } = setupDom();
  const states = createMapStates({ hostEl });
  t.after(() => { states.dispose(); teardown(); });

  for (const stateName of ['idle', 'loading', 'empty', 'no-root']) {
    states.render(stateName, {});
    assert.equal(hostEl.querySelector('input'), null, `${stateName}: no raw <input>`);
    assert.equal(hostEl.querySelector('select'), null, `${stateName}: no raw <select>`);
  }
  states.render('error', { message: 'x' });
  assert.equal(hostEl.querySelector('input'), null);
  assert.equal(hostEl.querySelector('select'), null);
});
