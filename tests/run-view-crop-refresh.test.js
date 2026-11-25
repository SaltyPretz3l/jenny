'use strict';
// new-test-file: crop-refresh.js is a new module (moved out of run-service.js to keep it under 600 lines).

// The live run's window crop (row 197, correctness review 3): kept while minimized or on a failed lookup,
// one lookup at a time with one trailing ask, and late answers dropped. The service-level crop tests are in
// run-view-service-look.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCropRefresh } = require('../services/run-view/crop-refresh');

const geometry = (width, height, edge, extra = {}) => ({
  bounds: { x: 0, y: 0, width, height }, offset: { left: edge, top: edge, right: edge, bottom: edge }, ...extra,
});
const HAD = { left: 0.01, top: 0.01, right: 0.01, bottom: 0.01 };

function harness() {
  const asks = [];
  const shown = [];
  let reply = () => geometry(100, 100, 2);
  const refresh = createCropRefresh({
    request: (op, args) => { asks.push([op, args.hwnd]); return Promise.resolve().then(() => reply(args)); },
    warn() {},
    onCrop: (r, projectId) => shown.push([projectId, r.crop]),
  });
  const r = { state: { state: 'running', hwnd: 7, generation: 1 }, crop: HAD, cropBusy: false, cropAgain: false };
  return { refresh, r, asks, shown, setReply: (fn) => { reply = fn; } };
}

test('a minimized window asks nothing and keeps its crop; a reply that says minimized is not a crop', async () => {
  const h = harness();
  h.r.state.state = 'minimized';
  await h.refresh(h.r, 'p1');
  assert.deepEqual(h.asks, [], 'Windows moves a minimized window off screen: no lookup');
  h.r.state.state = 'running';
  h.setReply(() => geometry(160, 28, 0, { minimized: true }));
  await h.refresh(h.r, 'p1');
  assert.deepEqual(h.r.crop, HAD);
  assert.deepEqual(h.shown, []);
});

test('a failed lookup or a reply that does not add up keeps the crop it had', async () => {
  const h = harness();
  h.setReply(() => { throw new Error('no such window'); });
  await h.refresh(h.r, 'p1');
  h.setReply(() => geometry(100, 100, 60));
  await h.refresh(h.r, 'p1');
  assert.deepEqual(h.r.crop, HAD);
  h.setReply(() => geometry(100, 100, 2));
  await h.refresh(h.r, 'p1');
  assert.deepEqual(h.shown, [['p1', { left: 0.02, top: 0.02, right: 0.02, bottom: 0.02 }]]);
});

test('one lookup at a time: changes while it is out ask once more, with the window as it is then', async () => {
  const h = harness();
  const gates = [];
  h.setReply((args) => new Promise((resolve) => gates.push(() => resolve(geometry(100, 100, args.hwnd)))));
  const first = h.refresh(h.r, 'p1');
  for (let i = 0; i < 4; i += 1) void h.refresh(h.r, 'p1');
  await Promise.resolve();
  assert.equal(h.asks.length, 1);
  h.r.state.hwnd = 3; // the program's next window
  gates.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.asks, [['window.geometry', 7], ['window.geometry', 3]]);
  assert.deepEqual(h.r.crop, HAD, 'the answer for the old window is dropped');
  gates.shift()();
  await first;
  assert.deepEqual(h.r.crop, { left: 0.03, top: 0.03, right: 0.03, bottom: 0.03 });
  assert.equal(h.r.cropBusy, false);
});

test('an answer that arrives after the run came to rest or a new generation began is dropped', async () => {
  for (const change of [(s) => { s.state = 'closed'; }, (s) => { s.generation = 2; }]) {
    const h = harness();
    let open;
    h.setReply(() => new Promise((resolve) => { open = () => resolve(geometry(100, 100, 4)); }));
    const pending = h.refresh(h.r, 'p1');
    await Promise.resolve();
    change(h.r.state);
    open();
    await pending;
    assert.deepEqual(h.r.crop, HAD);
    assert.deepEqual(h.shown, []);
  }
});
