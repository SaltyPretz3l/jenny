'use strict';
// new-test-file: the review fixes for the Live panel (rows 196/197) share its harness and would push renderer-live-run-panel.test.js past 600 lines.

// The picture's crop to the client area, the stale-slot guard, the composer wait, and the panel's race fixes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLiveRunCapture } = require('../renderer/chat/renderer-live-run-capture');
const { settle, gate, setup, snap, confirmed } = require('./helpers/live-run-panel-harness');

const CROP = { left: 0.02, top: 0.1, right: 0.02, bottom: 0.04 };
const RUNNING = { sourceId: 'w1', hwnd: 5 };
const sizeVideo = (video, width, height) => {
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: width });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: height });
};

// A capture module on its own, with a canvas that records what is drawn.
async function standalone(ctx) {
  const draws = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => draws.push(args.slice(1)) }), toDataURL: () => 'data:image/png;base64,BBBB' };
  const capture = createLiveRunCapture({ windowRef: ctx.windowRef, arm: async () => ({ ok: true }), onChange() {}, createCanvas: () => canvas });
  capture.sync({ projectId: 'p1', sourceId: 'w1', generation: 1 });
  await settle();
  await settle();
  const host = ctx.doc.createElement('div');
  assert.equal(capture.attach(host), true);
  return { capture, host, draws, canvas, video: host.querySelector('video'), clip: host.querySelector('.lv-clip') };
}

test('F6: a crop shows only the client area: the clip box takes the cropped shape and the video is sized and moved by the fractions', async () => {
  const ctx = setup();
  const { capture, video, clip } = await standalone(ctx);
  sizeVideo(video, 1000, 600);
  capture.setCrop(CROP);
  assert.equal(clip.dataset.cropped, 'true');
  assert.equal(clip.style.getPropertyValue('--lv-aspect'), '1.8605', '960 by 516 visible');
  assert.equal(video.style.getPropertyValue('--lv-vw'), '104.1667%');
  assert.equal(video.style.getPropertyValue('--lv-vh'), '116.2791%');
  assert.equal(video.style.getPropertyValue('--lv-left'), '-2.0833%');
  assert.equal(video.style.getPropertyValue('--lv-top'), '-11.6279%');
  sizeVideo(video, 2000, 1000); // the window was resized: the shape follows on the video's own resize event
  video.dispatchEvent(new ctx.window.Event('resize'));
  assert.equal(clip.style.getPropertyValue('--lv-aspect'), '2.2326', '1920 by 860 visible');
  capture.setCrop(null);
  assert.equal(clip.dataset.cropped, undefined, 'no crop: today\'s picture');
  assert.equal(video.style.getPropertyValue('--lv-vw'), '');
  ctx.close();
});

test('F6: the crop waits for the video size, and a crop that is not valid is ignored', async () => {
  const ctx = setup();
  const { capture, video, clip } = await standalone(ctx);
  capture.setCrop(CROP);
  assert.equal(clip.dataset.cropped, undefined, 'the size is not known yet');
  sizeVideo(video, 1000, 600);
  video.dispatchEvent(new ctx.window.Event('loadedmetadata'));
  assert.equal(clip.dataset.cropped, 'true');
  for (const bad of [{ left: 0.5, right: 0.45, top: 0, bottom: 0 }, { left: -0.1, right: 0, top: 0, bottom: 0 }, { left: 0, right: 0, top: 0.9, bottom: 0 },
    { left: 0.55, right: 0, top: 0, bottom: 0 }, { left: 'x', right: 0, top: 0, bottom: 0 }, { left: 0, right: 0, top: 0 }, 'no', undefined]) {
    capture.setCrop(bad);
    assert.equal(clip.dataset.cropped, undefined, JSON.stringify(bad));
    capture.setCrop(CROP);
  }
  ctx.close();
});

test('F6: the still is cut from the same rectangle', async () => {
  const ctx = setup();
  const { capture, video, draws, canvas } = await standalone(ctx);
  sizeVideo(video, 1000, 600);
  assert.equal(capture.still(), 'data:image/png;base64,BBBB');
  assert.deepEqual(draws.pop(), [0, 0], 'no crop: the whole frame');
  capture.setCrop(CROP);
  capture.still();
  const [sx, sy, sw, sh, dx, dy, dw, dh] = draws.pop();
  assert.deepEqual([sx, sy, sw, sh, dx, dy, dw, dh].map((n) => Math.round(n * 100) / 100), [20, 60, 960, 516, 0, 0, 960, 516]);
  assert.deepEqual([canvas.width, canvas.height], [960, 516]);
  ctx.close();
});

test('F6: the panel passes the run\'s crop to the picture and drops it when a push has none', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('running', { ...RUNNING, crop: CROP }));
  const video = ctx.doc.querySelector('.lv-picture video');
  sizeVideo(video, 1000, 600);
  video.dispatchEvent(new ctx.window.Event('loadedmetadata'));
  assert.equal(ctx.doc.querySelector('.lv-picture .lv-clip').dataset.cropped, 'true');
  await ctx.push(snap('running', { ...RUNNING, crop: null }));
  assert.equal(ctx.doc.querySelector('.lv-picture .lv-clip').dataset.cropped, undefined);
  await ctx.push(snap('running', { ...RUNNING, crop: CROP }));
  assert.equal(ctx.doc.querySelector('.lv-picture .lv-clip').dataset.cropped, 'true');
});

test('F1.1: an arm reply later than 1.5 s never leads to a window request; its one retry still works', async () => {
  const ctx = setup();
  const slow = gate();
  ctx.gates.armCapture = slow;
  await ctx.loadWith(snap('running', RUNNING));
  ctx.clock += 1600;
  delete ctx.gates.armCapture;
  slow.resolve();
  await settle();
  await settle();
  assert.ok(!ctx.events.includes('gdm'), 'a stale answer never opens the picker or eats a newer slot');
  await ctx.tick(450);
  await settle();
  assert.equal(ctx.named('armCapture').length, 1, 'correctness review 2: main still holds the slot it armed late');
  await ctx.tick(100); // 2.1 s after the arm: main's slot has timed out
  await settle();
  assert.equal(ctx.named('armCapture').length, 2, 'it tries once more');
  assert.equal(ctx.streams.length, 1, 'and that answer is used');
  ctx.close();
});

test('F1.1: a slow arm reply for a replaced request is dropped, not drained', async () => {
  const ctx = setup();
  const slow = gate();
  ctx.gates.armCapture = slow;
  await ctx.loadWith(snap('running', RUNNING));
  delete ctx.gates.armCapture;
  await ctx.push(snap('running', { sourceId: 'w2', hwnd: 6 }));
  ctx.clock += 1600;
  slow.resolve();
  await settle();
  await settle();
  assert.equal(ctx.streams.length, 1, 'only the newer request took a slot');
  ctx.close();
});

test('F1.2: while a Live capture is between its arm and the end of its window request, the window says so', async () => {
  const ctx = setup();
  assert.equal(ctx.windowRef.__jennyLiveCaptureIdle ?? null, null);
  const arm = gate();
  const request = gate();
  ctx.gates.armCapture = arm;
  ctx.windowRef.navigator.mediaDevices.getDisplayMedia = () => request.promise;
  await ctx.loadWith(snap('running', RUNNING));
  const idle = ctx.windowRef.__jennyLiveCaptureIdle;
  assert.ok(idle && typeof idle.then === 'function', 'published while the arm is pending');
  let done = false;
  void idle.then(() => { done = true; });
  arm.resolve();
  await settle();
  await settle();
  assert.equal(done, false, 'still busy while the window request is open');
  assert.equal(ctx.windowRef.__jennyLiveCaptureIdle, idle);
  request.promise.catch(() => {});
  request.resolve(null); // the request ends without a stream
  await settle();
  await settle();
  assert.equal(done, true);
  assert.equal(ctx.windowRef.__jennyLiveCaptureIdle, null, 'cleared when idle');
  ctx.close();
});

test('F1.2: a refused window request also clears the idle promise', async () => {
  const ctx = setup();
  ctx.windowRef.navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new Error('denied'));
  await ctx.loadWith(snap('running', RUNNING));
  assert.equal(ctx.windowRef.__jennyLiveCaptureIdle, null);
  ctx.close();
});

test('F13.3: the elapsed-time marks belong to a project: another project\'s first run does not inherit them', async () => {
  const ctx = setup();
  await ctx.loadWith(snap('running', RUNNING));
  ctx.clock += 5 * 60_000;
  ctx.state.currentSessionId = 'c3';
  ctx.answers.get = { ok: true, command: confirmed(), run: snap('running', { projectId: 'p2', chatId: 'c3', sourceId: 'w9', hwnd: 7 }) };
  ctx.panel.renderRailContent(ctx.surface);
  await settle();
  await settle();
  assert.equal(ctx.stateLine(), 'Running · started just now');
  ctx.close();
});

test('F13.4a: an older get reply (A, B, A again) cannot overwrite the newest one', async () => {
  const ctx = setup();
  const first = gate();
  const second = gate();
  const third = gate();
  ctx.gates.get = first;
  ctx.answers.get = { ok: true, command: confirmed(), run: snap('closed', { exitCode: 0 }) };
  await ctx.open(); // asks for A
  ctx.state.currentSessionId = 'c3';
  ctx.gates.get = second;
  ctx.answers.get = { ok: true, command: confirmed(), run: snap('idle', { projectId: 'p2' }) };
  ctx.panel.renderRailContent(ctx.surface); // asks for B
  ctx.state.currentSessionId = 'c1';
  ctx.gates.get = third;
  ctx.answers.get = { ok: true, command: confirmed(), run: snap('running', { generation: 2, ...RUNNING }) };
  ctx.panel.renderRailContent(ctx.surface); // asks for A again
  third.resolve();
  await settle();
  await settle();
  assert.equal(ctx.stateLine(), 'Running · started just now');
  first.resolve(); // the very first answer comes last
  second.resolve();
  await settle();
  await settle();
  assert.equal(ctx.stateLine(), 'Running · started just now', 'the stale answers were dropped');
  ctx.close();
});

test('F13.4b: a failed restart-switch save that returns after a project change leaves the new project\'s switch alone', async () => {
  const ctx = setup();
  ctx.answers.get = { ok: true, command: confirmed(), run: snap('running', RUNNING), restartAfterChanges: false };
  await ctx.open();
  const save = gate();
  ctx.gates.setRestartAfterChanges = save;
  ctx.answers.setRestartAfterChanges = { ok: false, reason: 'internal_error' };
  const track = ctx.doc.querySelector('.lv-line [role="switch"]');
  await ctx.click(track);
  assert.deepEqual(ctx.named('setRestartAfterChanges')[0][1], { projectId: 'p1', on: true });
  ctx.state.currentSessionId = 'c3';
  ctx.answers.get = { ok: true, command: confirmed(), run: snap('running', { projectId: 'p2', chatId: 'c3', sourceId: 'w9', hwnd: 7 }), restartAfterChanges: true };
  ctx.panel.renderRailContent(ctx.surface);
  await settle();
  await settle();
  assert.equal(track.getAttribute('aria-checked'), 'true', 'the other project\'s value');
  save.resolve();
  await settle();
  await settle();
  assert.equal(track.getAttribute('aria-checked'), 'true', 'the failure belongs to the old project');
  ctx.close();
});

test('F13.4b: a failed save for the same project still puts the switch back', async () => {
  const ctx = setup();
  ctx.answers.get = { ok: true, command: confirmed(), run: snap('running', RUNNING), restartAfterChanges: true };
  await ctx.open();
  ctx.answers.setRestartAfterChanges = { ok: false, reason: 'internal_error' };
  const track = ctx.doc.querySelector('.lv-line [role="switch"]');
  await ctx.click(track);
  assert.equal(track.getAttribute('aria-checked'), 'true');
  ctx.close();
});

test('F13.5: a disabled answer that arrives after the person moved to another tab does not close that tab', async () => {
  const ctx = setup();
  const reply = gate();
  ctx.gates.get = reply;
  ctx.answers.get = { ok: false, reason: 'disabled' };
  await ctx.open();
  ctx.panelEl.dataset.artifactReviewMode = 'artifact'; // another right-panel tab is showing now
  await settle();
  reply.resolve();
  await settle();
  await settle();
  assert.equal(ctx.toggles, 0);
  ctx.close();
});
