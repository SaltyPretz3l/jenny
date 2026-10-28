'use strict';

// Push-to-talk dictation (row 84): the controller's press/release state
// machine, the Ctrl+Space hold, target choice and insertion, driven with fake
// capture and view modules (no audio in jsdom).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createDictationController, spacedInsertion, TAP_MS } = require('../renderer/features/renderer-dictation-controller');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush() { for (let i = 0; i < 6; i += 1) await settle(); }

function setup({ model = 'ready', flag = true, clip = { pcm: new ArrayBuffer(32000), durationMs: 1000, peakDb: -20 }, transcribe, idle = null } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="composer"><div class="composer-main">
      <div class="composer-entry-row"><textarea class="composer-input" id="chatInput"></textarea></div>
      <div class="composer-toolbar"><button class="composer-icon-button composer-dictate-button" aria-pressed="false"></button></div>
    </div></div>
    <input id="search">
  </body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  input.getClientRects = () => [{}];
  const clock = { t: 1000 };
  const calls = { start: 0, stop: 0, cancel: 0, transcribe: [], prepare: 0, problems: [], setup: 0, listening: [], transcribing: 0, loads: 0 };
  if (idle) window.requestIdleCallback = idle;
  const session = {
    stop: () => { calls.stop += 1; return Promise.resolve(clip); },
    cancel: () => { calls.cancel += 1; },
  };
  const modules = {
    capture: { startCapture: () => { calls.start += 1; return Promise.resolve(session); } },
    view: {
      configure() {},
      clearProblem() {},
      clearLine() {},
      pushLevel() {},
      showListening: (_input, opts) => calls.listening.push(opts.mode),
      showTranscribing: () => { calls.transcribing += 1; },
      showProblem: (_input, reason, code) => calls.problems.push([reason, code]),
      openSetup: () => { calls.setup += 1; },
    },
  };
  window.jennyShell = {
    dictation: {
      getState: () => Promise.resolve({ state: model }),
      onChanged: () => () => {},
      prepare: () => { calls.prepare += 1; return Promise.resolve({ ok: true }); },
      transcribe: (pcm) => { calls.transcribe.push(pcm); return Promise.resolve(transcribe || { ok: true, text: 'hello there', durationMs: 1000, engineMs: 40 }); },
    },
  };
  const state = { features: { featureFlags: { dictation: flag } }, ui: {} };
  const controller = createDictationController({
    windowRef: window, documentRef: doc, state, now: () => clock.t,
    getPrimaryComposerInput: () => input, loadModules: () => { calls.loads += 1; return modules; },
  });
  controller.bind();
  const key = (type, init) => window.dispatchEvent(new window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  return { window, doc, input, controller, clock, calls, key, state, button: doc.querySelector('.composer-dictate-button') };
}

test('holding Ctrl+Space records, release inserts at the caret with a space and an input event', async () => {
  const h = setup();
  await flush();
  h.input.value = 'CI log says:';
  h.input.focus();
  h.input.setSelectionRange(12, 12);
  let inputs = 0;
  h.input.addEventListener('input', () => { inputs += 1; });
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  assert.equal(h.controller.getPhase(), 'listening');
  assert.equal(h.button.getAttribute('aria-pressed'), 'true');
  assert.equal(h.calls.prepare, 1, 'the model warms on press');
  h.clock.t += 2000;
  h.key('keyup', { code: 'Space', key: ' ' });
  await flush();
  assert.equal(h.calls.transcribe.length, 1);
  assert.equal(h.input.value, 'CI log says: hello there');
  assert.equal(inputs, 1, 'the draft is saved through an input event');
  assert.equal(h.controller.getPhase(), 'idle');
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
});

test('a quick press goes hands-free; Enter inserts without reaching the send handler', async () => {
  const h = setup();
  await flush();
  h.input.focus();
  let sendKeydowns = 0;
  h.input.addEventListener('keydown', (event) => { if (event.key === 'Enter') sendKeydowns += 1; });
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  h.clock.t += TAP_MS - 50;
  h.key('keyup', { code: 'Space', key: ' ' });
  await flush();
  assert.equal(h.controller.getMode(), 'handsfree');
  assert.equal(h.controller.getPhase(), 'listening');
  assert.deepEqual(h.calls.listening, ['hold', 'handsfree']);
  h.input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  assert.equal(sendKeydowns, 0, 'Enter stops dictation and never sends');
  assert.equal(h.input.value, 'hello there');
});

test('with the model installed, capture and view load while idle after boot', async () => {
  const ready = setup({ idle: (fn) => fn() });
  await flush();
  assert.equal(ready.calls.loads, 1, 'prefetched before any press');
  const fresh = setup({ model: 'not_installed', idle: (fn) => fn() });
  await flush();
  assert.equal(fresh.calls.loads, 0, 'nothing is loaded for someone who never set dictation up');
});

test('a stop tap while the microphone is still opening stops it once it opens', async () => {
  const h = setup();
  await flush();
  h.input.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  h.key('keyup', { code: 'Space', key: ' ' });
  assert.equal(h.controller.getPhase(), 'starting');
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  h.key('keyup', { code: 'Space', key: ' ' });
  await flush();
  assert.equal(h.calls.start, 1, 'the second tap does not open a second capture');
  assert.equal(h.calls.transcribe.length, 1);
  assert.equal(h.controller.getPhase(), 'idle');
});

test('a clip shorter than main accepts is not sent, whatever its rounded duration says', async () => {
  const h = setup({ clip: { pcm: new ArrayBuffer(6398), durationMs: 200, peakDb: -20 } });
  await flush();
  h.input.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  h.clock.t += 1000;
  h.key('keyup', { code: 'Space' });
  await flush();
  assert.equal(h.calls.transcribe.length, 0);
  assert.deepEqual(h.calls.problems, [['nothing_heard', undefined]]);
});

test('Esc discards the recording: no model call, nothing inserted', async () => {
  const h = setup();
  await flush();
  h.input.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  h.key('keydown', { key: 'Escape' });
  await flush();
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.calls.transcribe.length, 0);
  assert.equal(h.input.value, '');
  assert.equal(h.controller.getPhase(), 'idle');
});

test('Ctrl+Space inside another editable element is left alone', async () => {
  const h = setup();
  await flush();
  h.doc.getElementById('search').focus();
  const event = new h.window.KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, bubbles: true, cancelable: true });
  h.window.dispatchEvent(event);
  await flush();
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.calls.start, 0);
});

test('with no composer focused the shortcut targets the primary composer', async () => {
  const h = setup();
  await flush();
  h.doc.body.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  assert.equal(h.calls.start, 1);
  h.clock.t += 1000;
  h.key('keyup', { key: 'Control' });
  await flush();
  assert.equal(h.input.value, 'hello there');
});

test('a hidden composer is never a target', async () => {
  const h = setup();
  await flush();
  h.input.getClientRects = () => [];
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  assert.equal(h.calls.start, 0);
});

test('without the model, the press opens the first-use popover instead of recording', async () => {
  const h = setup({ model: 'not_installed' });
  await flush();
  h.button.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  await flush();
  assert.equal(h.calls.setup, 1);
  assert.equal(h.calls.start, 0);
});

test('the flag off hides every mic and ignores the shortcut', async () => {
  const h = setup({ flag: false });
  await flush();
  assert.equal(h.doc.documentElement.hasAttribute('data-dictation-off'), true);
  h.input.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  assert.equal(h.calls.start, 0);
  h.state.features.featureFlags.dictation = true;
  h.controller.syncAvailability();
  assert.equal(h.doc.documentElement.hasAttribute('data-dictation-off'), false);
});

test('silence is not sent to the model', async () => {
  const h = setup({ clip: { pcm: new ArrayBuffer(32000), durationMs: 1000, peakDb: -70 } });
  await flush();
  h.input.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  h.clock.t += 1000;
  h.key('keyup', { code: 'Space' });
  await flush();
  assert.equal(h.calls.transcribe.length, 0);
  assert.deepEqual(h.calls.problems, [['nothing_heard', undefined]]);
});

test('an engine failure shows its code and inserts nothing', async () => {
  const h = setup({ transcribe: { ok: false, reason: 'engine_error', code: 'CMP-SPEECH-0003' } });
  await flush();
  h.input.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  h.clock.t += 1000;
  h.key('keyup', { code: 'Space' });
  await flush();
  assert.deepEqual(h.calls.problems, [['engine_error', 'CMP-SPEECH-0003']]);
  assert.equal(h.input.value, '');
});

test('losing the window ends a hold and inserts what was said', async () => {
  const h = setup();
  await flush();
  h.input.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  h.clock.t += 1000;
  h.window.dispatchEvent(new h.window.Event('blur'));
  await flush();
  assert.equal(h.input.value, 'hello there');
});

test('the mic button: hold and release records; the button keeps composer focus', async () => {
  const h = setup();
  await flush();
  const down = new h.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  h.button.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  await flush();
  assert.equal(h.controller.getPhase(), 'listening');
  h.clock.t += 1500;
  h.window.dispatchEvent(new h.window.MouseEvent('pointerup', { bubbles: true }));
  await flush();
  assert.equal(h.input.value, 'hello there');
});

test('dispose cancels a live recording and removes the listeners', async () => {
  const h = setup();
  await flush();
  h.input.focus();
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  h.controller.dispose();
  assert.equal(h.calls.cancel, 1);
  h.key('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  await flush();
  assert.equal(h.calls.start, 1, 'no new recording after dispose');
});

test('the pane-0 mic is an inventory button inserted before Stop, once', () => {
  const { insertMicBefore } = require('../renderer/features/renderer-dictation-controller');
  const actionButton = require('../renderer/inventory/action-button').actionButton || require('../renderer/inventory/action-button');
  const dom = new JSDOM('<!doctype html><body><div class="composer-toolbar-right"><button id="stopStreamButton"></button><button class="composer-send"></button></div></body>');
  const stop = dom.window.document.getElementById('stopStreamButton');
  const mic = insertMicBefore(stop, actionButton);
  assert.equal(insertMicBefore(stop, actionButton), mic, 'idempotent');
  const row = [...stop.parentElement.children].map((node) => node.className || node.id);
  assert.deepEqual(row, ['composer-icon-button composer-dictate-button', 'stopStreamButton', 'composer-send']);
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
  assert.equal(mic.getAttribute('aria-label'), 'Dictate');
  assert.equal(mic.getAttribute('type'), 'button');
  assert.ok(mic.querySelector('svg'));
});

test('spacedInsertion adds a space only between words', () => {
  assert.equal(spacedInsertion('', 'hi'), 'hi');
  assert.equal(spacedInsertion('word', 'hi'), ' hi');
  assert.equal(spacedInsertion('word ', 'hi'), 'hi');
  assert.equal(spacedInsertion('word\n', 'hi'), 'hi');
  assert.equal(spacedInsertion('word', ', then'), ', then');
});
