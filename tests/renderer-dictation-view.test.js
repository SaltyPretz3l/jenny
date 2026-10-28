'use strict';

// Dictation (row 84): the level meter maths (accurate, no smoothing), PCM
// packing, error classification, the in-composer line and the first-use popover.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const capture = require('../renderer/features/renderer-dictation-capture');
const view = require('../renderer/features/renderer-dictation-view');

function sine(amplitude, n = 800) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amplitude * Math.sin(2 * Math.PI * 440 * i / 16000);
  return out;
}

test('meter: a block level is its RMS in dBFS mapped from -60..-6 onto 0..1', () => {
  // A sine of amplitude A has RMS A/sqrt(2): 0.1414 -> -20 dBFS.
  const db = capture.rmsDb(sine(0.1414));
  assert.ok(Math.abs(db - -20) < 0.1, `expected about -20 dBFS, got ${db}`);
  assert.ok(Math.abs(capture.levelFromDb(db) - (40 / 54)) < 0.01);
  assert.equal(capture.levelFromDb(-60), 0);
  assert.equal(capture.levelFromDb(-6), 1);
  assert.equal(capture.levelFromDb(0), 1);
  assert.equal(capture.levelFromDb(-90), 0);
  assert.equal(capture.levelFromDb(capture.rmsDb(new Float32Array(800))), 0, 'silence draws a flat bar');
});

test('PCM16 packing clamps and keeps the sample count', () => {
  const pcm = new Int16Array(capture.joinPcm16([Float32Array.from([0, 1, -1, 2, -2]), Float32Array.from([0.5])], 6));
  assert.deepEqual(Array.from(pcm), [0, 32767, -32768, 32767, -32768, 16384]);
});

test('capture errors map to the problems the composer can explain', () => {
  const named = (name) => Object.assign(new Error('x'), { name });
  assert.equal(capture.classify(named('NotAllowedError')).reason, 'blocked');
  assert.equal(capture.classify(named('NotReadableError')).reason, 'blocked');
  assert.equal(capture.classify(named('NotFoundError')).reason, 'no_device');
  assert.equal(capture.classify(named('OverconstrainedError')).reason, 'no_device');
  assert.equal(capture.classify(named('AbortError')).reason, 'failed');
});

test('capture closes the microphone and the audio context when setup fails late', async () => {
  let stopped = 0;
  let closed = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }] };
  class FakeContext {
    constructor() { this.audioWorklet = { addModule: async () => {} }; }
    createMediaStreamSource() { throw Object.assign(new Error('no audio track'), { name: 'InvalidStateError' }); }
    close() { closed += 1; return Promise.resolve(); }
  }
  const windowRef = { navigator: { mediaDevices: { getUserMedia: async () => stream } }, AudioContext: FakeContext, AudioWorkletNode: function () {} };
  await assert.rejects(capture.startCapture({ windowRef }), (error) => error.reason === 'failed');
  assert.deepEqual([stopped, closed], [1, 1]);
});

function composer() {
  const dom = new JSDOM(`<!doctype html><body><div class="composer"><div class="composer-main">
    <div class="composer-entry-row"><textarea class="composer-input"></textarea></div>
    <div class="composer-toolbar"><button class="composer-dictate-button" aria-expanded="false"></button></div>
  </div></div><div id="outside"></div></body>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  return { dom, doc, input: doc.querySelector('textarea'), button: doc.querySelector('.composer-dictate-button') };
}

test('the live line sits inside the composer above the draft, with 32 bars and no dot', () => {
  const { doc, input } = composer();
  view.showListening(input, { mode: 'hold', startedAt: 0, now: () => 4200 });
  const line = doc.querySelector('.composer-main > .composer-dictation-line');
  assert.ok(line, 'line is a child of the composer body');
  assert.equal(line.nextElementSibling.className, 'composer-entry-row');
  assert.equal(line.querySelectorAll('.composer-dictation-level > i').length, view.BARS);
  assert.equal(line.querySelector('.status-dot'), null);
  assert.equal(line.querySelector('.composer-dictation-time').textContent, '0:04');
  assert.match(line.textContent, /Listening/);
  assert.match(line.textContent, /Release to insert/);
  view.pushLevel(input, 0.75);
  const bars = line.querySelectorAll('.composer-dictation-level > i');
  assert.equal(bars[bars.length - 1].style.getPropertyValue('--level'), '0.75', 'the newest block is on the right');
  view.showListening(input, { mode: 'handsfree', startedAt: 0, now: () => 0 });
  assert.match(line.textContent, /press Enter to insert/);
  view.clearLine(input);
  assert.equal(doc.querySelector('.composer-dictation-line'), null);
});

test('a problem line offers its one action and clears itself on use', () => {
  const { doc, input } = composer();
  let opened = 0;
  view.configure({ openMicrophoneSettings: () => { opened += 1; } });
  view.showProblem(input, 'blocked');
  const action = doc.querySelector('.composer-dictation-line--problem .composer-dictation-action');
  assert.equal(action.textContent, 'Open Windows settings');
  action.click();
  assert.equal(opened, 1);
  assert.equal(doc.querySelector('.composer-dictation-line'), null);
  view.showProblem(input, 'engine_error', 'CMP-SPEECH-0003');
  assert.match(doc.querySelector('.composer-dictation-line').textContent, /CMP-SPEECH-0003/);
  assert.equal(doc.querySelector('.composer-dictation-action'), null);
  view.clearProblem(input);
  assert.equal(doc.querySelector('.composer-dictation-line'), null);
});

test('first-use popover: explains, downloads, shows progress, closes on Esc', () => {
  const { doc, button } = composer();
  let modelState = { state: 'not_installed' };
  let setups = 0;
  view.openSetup(button, { getState: () => modelState, api: { setup: () => { setups += 1; return Promise.resolve({ ok: true }); } } });
  const pop = doc.querySelector('.composer .composer-dictation-popover');
  assert.ok(pop);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.match(pop.textContent, /Talk instead of typing/);
  assert.match(pop.textContent, /One-time download: 673 MB/);
  pop.querySelector('[data-dictation-action="download"]').click();
  assert.equal(setups, 1);
  modelState = { state: 'downloading', downloadedBytes: 214e6, totalBytes: 672947357 };
  view.updateSetup(modelState);
  assert.match(pop.textContent, /214 of 673 MB/);
  assert.equal(pop.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '214000000');
  doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.composer-dictation-popover'), null);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('first-use popover survives the click that follows its opening press (inventory click-away installed)', () => {
  const { doc, button } = composer();
  delete require.cache[require.resolve('../renderer/inventory/popover')];
  require('../renderer/inventory/popover').initPopoverHandlers(doc);
  view.openSetup(button, { getState: () => ({ state: 'not_installed' }), api: {} });
  button.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const pop = doc.querySelector('.composer-dictation-popover');
  assert.ok(pop && pop.hidden === false, 'the mic click is not a click away');
  view.closeSetup();
});

test('first-use popover closes on an outside press', () => {
  const { doc, button } = composer();
  view.openSetup(button, { getState: () => ({ state: 'not_installed' }), api: {} });
  doc.getElementById('outside').dispatchEvent(new doc.defaultView.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(doc.querySelector('.composer-dictation-popover'), null);
});

test('clock formats minutes and seconds', () => {
  assert.equal(view.clock(0), '0:00');
  assert.equal(view.clock(9500), '0:09');
  assert.equal(view.clock(120000), '2:00');
});
