/* Sibling of tests/renderer-chat-timeline-virtualizer.test.js — split out
   because that file sits near the 600-line test-size ratchet. Scroll-program
   W1b: every virtualizer mutation that can perturb scroll geometry funnels
   through restoreIfDetached(), and that choke point must report a
   programmatic write to the scroll coordinator (new optional dep
   `noteProgrammaticWrite`) so the follow guard never mistakes mount
   compensation for reader scrolling. Unmounts are height-preserving
   (placeholder keeps the measured min-height) and are not pinned here. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTimelineVirtualizer } = require('../renderer/chat/renderer-chat-timeline-virtualizer');

const {
  buildEnvironment,
  bulkEntries,
  makeChatTimeline,
  makeFakeDocument,
} = require('./helpers/renderer-chat-timeline-virtualizer-helpers');

test('remounting a virtualized entry reports a programmatic write to the coordinator', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const writes = [];
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({
    chatTimeline,
    document: makeFakeDocument(),
    noteProgrammaticWrite(reason) { writes.push(reason); },
  });
  t.after(() => v.dispose());
  v.rebuild();

  const target = entries[42];
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.equal(target.getAttribute('data-virtualized'), 'true');
  writes.length = 0;

  assert.equal(v.ensureMountedForMessageId('m42'), true);
  assert.ok(writes.length >= 1, 'the mount mutation must be reported before its scroll event lands');
  assert.ok(
    writes.every((reason) => reason === 'virtualizer'),
    `every reported write carries the virtualizer reason (got ${JSON.stringify(writes)})`
  );
});

test('an intersection-enter mount batch reports a programmatic write', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const writes = [];
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({
    chatTimeline,
    document: makeFakeDocument(),
    noteProgrammaticWrite(reason) { writes.push(reason); },
  });
  t.after(() => v.dispose());
  v.rebuild();

  const target = entries[17];
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.equal(target.getAttribute('data-virtualized'), 'true');
  writes.length = 0;

  env.observers[0]._fire([{ target, isIntersecting: true }]);
  assert.equal(target.getAttribute('data-virtualized'), null);
  assert.ok(writes.length >= 1, 'observer-driven mounts funnel through the same choke point');
  assert.ok(writes.every((reason) => reason === 'virtualizer'));
});

test('an ensureMounted call that mounts nothing reports no programmatic write', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const writes = [];
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({
    chatTimeline,
    document: makeFakeDocument(),
    noteProgrammaticWrite(reason) { writes.push(reason); },
  });
  t.after(() => v.dispose());
  v.rebuild();

  assert.equal(v.ensureMountedForMessageId('m42'), false, 'm42 was never virtualized, so there is nothing to mount');
  assert.deepEqual(writes, [], 'a no-op mount must not attribute the next frame');
});

test('the virtualizer works unchanged when no noteProgrammaticWrite dep is supplied', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();

  const target = entries[42];
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.doesNotThrow(() => {
    assert.equal(v.ensureMountedForMessageId('m42'), true);
  });
  assert.equal(target.getAttribute('data-virtualized'), null);
});

// Pre-land fix (spec 1b item 4, binding): a large unmount can shrink
// scrollHeight below scrollTop + clientHeight and let the browser clamp
// scrollTop with NO restore write to attribute (restore is skipped while
// follow is latched). The unmount batch itself must therefore report a
// programmatic write — the virtualizer knows its own mutations.

test('an unmount batch reports a programmatic write even though no restore runs', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const writes = [];
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({
    chatTimeline,
    document: makeFakeDocument(),
    noteProgrammaticWrite(reason) { writes.push(reason); },
  });
  t.after(() => v.dispose());
  v.rebuild();

  writes.length = 0;
  env.observers[0]._fire([{ target: entries[42], isIntersecting: false }]);
  assert.equal(entries[42].getAttribute('data-virtualized'), 'true');
  assert.ok(writes.length >= 1, 'the unmount clamp risk is attributed');
  assert.ok(
    writes.every((reason) => reason === 'virtualizer'),
    `every reported write carries the virtualizer reason (got ${JSON.stringify(writes)})`
  );
});

test('a batch that unmounts nothing reports no programmatic write', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const writes = [];
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({
    chatTimeline,
    document: makeFakeDocument(),
    noteProgrammaticWrite(reason) { writes.push(reason); },
  });
  t.after(() => v.dispose());
  v.rebuild();

  env.observers[0]._fire([{ target: entries[42], isIntersecting: false }]);
  writes.length = 0;
  env.observers[0]._fire([{ target: entries[42], isIntersecting: false }]);
  assert.deepEqual(writes, [], 'an already-virtualized entry unmounts nothing and must not attribute the next frame');
});
