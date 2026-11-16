'use strict';

// new-test-file: server/team/model-relay-window.js is a new module (slice 6-2); parts, the part window and start points.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createTransferWindow, parseResume } = require('../../server/team/model-relay-window');
const {
  RECEIVER, SENDER, SMALL, body, bytesOf, makeRelay, mustOk, reasonOf, startTransfer, viewOf,
} = require('./helpers/model-relay-fixture');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const files = (...sizes) => sizes.map((size) => ({ size }));
const STALE = 'team_model_transfer_stale';

test('the spec red test: a fifth part never enters a full window', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay, { sizes: [40] });
  for (let part = 0; part < 4; part += 1) assert.equal(mustOk(relay.putPart(SENDER, transferId, 0, part, bytesOf(4))).ready, true);
  assert.deepEqual(relay.checkPut(SENDER, transferId, 0, 4), { ok: true, ready: false, wait: 'window_full' });
  assert.deepEqual(relay.putPart(SENDER, transferId, 0, 4, bytesOf(4)), { ok: true, ready: false, wait: 'window_full' });
  assert.deepEqual([relay.resources().windowParts, relay.resources().windowBytes], [4, 16]);
});

test('only the next part number; short, oversized and past-the-end parts are refused', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay, { sizes: [10] });
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 1, bytesOf(4))), STALE);
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 0, bytesOf(3))), STALE, 'short and not the last');
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 0, bytesOf(5))), 'team_model_size_limit');
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 1, 0, bytesOf(4))), STALE, 'no such file');
  assert.equal(reasonOf(relay.checkPut(SENDER, transferId, 0, 3)), 'team_model_size_limit', 'past the file end');
  for (const part of [Number.NaN, 0.5, '0', 2 ** 53]) {
    assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, part, bytesOf(4))), STALE, String(part));
    assert.equal(reasonOf(relay.takePart(RECEIVER, transferId, 0, part)), STALE, String(part));
  }
  assert.equal(mustOk(relay.checkPut(SENDER, transferId, 0, 0)).bytes, 4);
  mustOk(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4)));
  mustOk(relay.putPart(SENDER, transferId, 0, 1, bytesOf(4)));
  assert.equal(mustOk(relay.checkPut(SENDER, transferId, 0, 2)).bytes, 2, 'the last part is the remainder');
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 2, bytesOf(4))), 'team_model_size_limit');
  mustOk(relay.putPart(SENDER, transferId, 0, 2, bytesOf(2)));
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 3, bytesOf(1))), 'team_model_size_limit');
  // A retry of a part already put, even with other bytes, is a duplicate and changes nothing.
  assert.equal(mustOk(relay.putPart(SENDER, transferId, 0, 1, bytesOf(4, 9))).duplicate, true);
  mustOk(relay.takePart(RECEIVER, transferId, 0, 0));
  assert.ok(mustOk(relay.takePart(RECEIVER, transferId, 0, 1)).bytes.equals(bytesOf(4)));
});

test('ownership passes on put: a pooled or sliced buffer is refused, an exact allocation kept as is', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay, { sizes: [10] });
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 0, Buffer.from([1, 2, 3, 4]))), 'team_model_request_invalid');
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 0, Buffer.alloc(8).subarray(0, 4))), 'team_model_request_invalid');
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 0, 'text')), 'team_model_request_invalid');
  const own = bytesOf(4);
  mustOk(relay.putPart(SENDER, transferId, 0, 0, own));
  assert.equal(mustOk(relay.takePart(RECEIVER, transferId, 0, 0)).bytes, own, 'zero copy');
});

test('parts for a paused or ended transfer are refused', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay, { sizes: [10] });
  mustOk(relay.pause(SENDER, transferId));
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4))), STALE);
  assert.equal(reasonOf(relay.takePart(RECEIVER, transferId, 0, 0)), STALE);
  mustOk(relay.cancel(RECEIVER, transferId));
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4))), STALE);
  assert.equal(reasonOf(relay.checkPut(SENDER, transferId, 0, 0)), STALE);
});

test('the receiver gets the same bytes in order across files; a part stays until a later one is served', () => {
  const { relay } = makeRelay();
  const sizes = [10, 7];
  const source = sizes.map((size, index) => bytesOf(size, index + 3));
  const { transferId } = startTransfer(relay, { sizes });
  const received = sizes.map(() => []);
  for (const [index, part] of [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1]]) {
    assert.equal(mustOk(relay.takePart(RECEIVER, transferId, index, part)).ready, false);
    const slice = source[index].subarray(part * 4, part * 4 + 4);
    mustOk(relay.putPart(SENDER, transferId, index, part, bytesOf(slice.length).fill(slice)));
    const first = mustOk(relay.takePart(RECEIVER, transferId, index, part));
    const again = mustOk(relay.takePart(RECEIVER, transferId, index, part));
    assert.ok(first.bytes.equals(again.bytes), 'a retry of the same take returns the same bytes');
    assert.equal(relay.resources().windowParts, 1, 'the earlier part left when this one was served');
    received[index].push(first.bytes);
  }
  sizes.forEach((_, index) => assert.equal(sha(Buffer.concat(received[index])), sha(source[index])));
  assert.equal(reasonOf(relay.takePart(RECEIVER, transferId, 0, 0)), STALE, 'a passed part is gone');
  mustOk(relay.complete(RECEIVER, transferId, { ok: true }));
  assert.equal(relay.resources().windowBytes, 0);
});

test('pipelined takes never lose an unserved part, in either order', () => {
  // take(k) waits, take(k+1) waits, the sender puts k; the retry of take(k+1) arrives first.
  const one = makeRelay().relay;
  const a = startTransfer(one, { sizes: [40] }).transferId;
  assert.equal(mustOk(one.takePart(RECEIVER, a, 0, 0)).wait, 'not_ready');
  assert.equal(mustOk(one.takePart(RECEIVER, a, 0, 1)).wait, 'not_ready');
  mustOk(one.putPart(SENDER, a, 0, 0, bytesOf(4, 1)));
  assert.equal(mustOk(one.takePart(RECEIVER, a, 0, 1)).wait, 'not_ready', 'k+1 waits and leaves k alone');
  assert.ok(mustOk(one.takePart(RECEIVER, a, 0, 0)).bytes.equals(bytesOf(4, 1)));
  // Both put; k+1 is served before k: k stays, and is served after.
  const two = makeRelay().relay;
  const b = startTransfer(two, { sizes: [40] }).transferId;
  mustOk(two.putPart(SENDER, b, 0, 0, bytesOf(4, 1)));
  mustOk(two.putPart(SENDER, b, 0, 1, bytesOf(4, 2)));
  assert.ok(mustOk(two.takePart(RECEIVER, b, 0, 1)).bytes.equals(bytesOf(4, 2)));
  assert.equal(two.resources().windowParts, 2, 'unserved k is never released by a take');
  assert.ok(mustOk(two.takePart(RECEIVER, b, 0, 0)).bytes.equals(bytesOf(4, 1)), 'k still there');
  assert.equal(two.resources().windowParts, 1, 'k served and a later part served: k passed');
  assert.ok(mustOk(two.takePart(RECEIVER, b, 0, 1)).bytes.equals(bytesOf(4, 2)), 'k+1 stays until a later part is served');
});

test('a receiver that never takes part k fills the window; the sender gets full, then the idle rule pauses', () => {
  const { relay, clock } = makeRelay();
  const { transferId } = startTransfer(relay, { sizes: [40] });
  for (let part = 0; part < 4; part += 1) mustOk(relay.putPart(SENDER, transferId, 0, part, bytesOf(4)));
  for (let part = 1; part < 4; part += 1) mustOk(relay.takePart(RECEIVER, transferId, 0, part));
  assert.equal(mustOk(relay.checkPut(SENDER, transferId, 0, 4)).wait, 'window_full');
  clock.advance(SMALL.pauseIdleMs);
  mustOk(relay.sweep());
  assert.equal(viewOf(relay, transferId).reason, 'idle');
  assert.deepEqual(viewOf(relay, transferId).next, { index: 0, part: 0 }, 'the sender restarts at the unserved part');
  assert.equal(relay.resources().windowBytes, 0);
});

test('a take is allowed for a part in the window or the next part and one more', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay, { sizes: [40] });
  assert.equal(mustOk(relay.takePart(RECEIVER, transferId, 0, 1)).wait, 'not_ready');
  assert.equal(reasonOf(relay.takePart(RECEIVER, transferId, 0, 2)), STALE);
  assert.equal(reasonOf(relay.takePart(RECEIVER, transferId, 3, 0)), STALE);
});

test('serving a later part frees window room for the sender', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay, { sizes: [40] });
  for (let part = 0; part < 4; part += 1) mustOk(relay.putPart(SENDER, transferId, 0, part, bytesOf(4)));
  assert.equal(mustOk(relay.checkPut(SENDER, transferId, 0, 4)).ready, false);
  mustOk(relay.takePart(RECEIVER, transferId, 0, 0));
  mustOk(relay.takePart(RECEIVER, transferId, 0, 1));
  assert.equal(relay.resources().windowParts, 3);
  assert.equal(mustOk(relay.checkPut(SENDER, transferId, 0, 4)).ready, true);
});

test('resume: start points are honoured and the sender is told where to start', () => {
  const { relay } = makeRelay();
  const { transferId, accepted } = startTransfer(relay, { sizes: [10, 7], resume: [{ index: 0, offset: 8 }, { index: 1, offset: 7 }] });
  assert.deepEqual(accepted.transfer.next, { index: 0, part: 2 });
  assert.equal(accepted.transfer.bytes_done, 15);
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4))), STALE);
  mustOk(relay.putPart(SENDER, transferId, 0, 2, bytesOf(2)));
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 1, 0, bytesOf(4))), STALE, 'file 1 was complete at accept');
  assert.equal(mustOk(relay.takePart(RECEIVER, transferId, 0, 2)).bytes.length, 2);

  const done = makeRelay().relay;
  const all = startTransfer(done, { sizes: [10, 7], resume: [{ index: 0, offset: 10 }, { index: 1, offset: 7 }] });
  assert.deepEqual([all.accepted.transfer.next, all.accepted.transfer.bytes_done], [null, 17], 'every file complete');
  const empty = makeRelay().relay;
  assert.deepEqual(startTransfer(empty, { sizes: [10], resume: [] }).accepted.transfer.next, { index: 0, part: 0 });
});

test('resume: a bad start point is refused', () => {
  const { relay } = makeRelay();
  const made = mustOk(relay.offer(SENDER, body({ to: RECEIVER, sizes: [10, 7] }), { receivers: [RECEIVER.memberId] }));
  const bad = [
    [{ index: 0, offset: 3 }], [{ index: 0, offset: 12 }], [{ index: 2, offset: 0 }], [{ index: -1, offset: 0 }],
    [{ index: 0, offset: 4 }, { index: 0, offset: 4 }], [{ index: 0 }], [{ index: 0, offset: 4, extra: 1 }],
    [{ index: 0, offset: 0 }, { index: 1, offset: 0 }, { index: 0, offset: 0 }], 'all', [null], [{ index: '0', offset: 0 }],
    [{ index: 0, offset: -4 }], [{ index: 0, offset: 4.5 }], [{ index: 0, offset: Number.NaN }], [{ index: 0.5, offset: 0 }],
  ];
  for (const resume of bad) {
    assert.equal(reasonOf(relay.accept(RECEIVER, made.offer.offer_id, { resume, canReceive: true })),
      'team_model_request_invalid', JSON.stringify(resume));
  }
  assert.equal(relay.resources().transfers.accepted, 0);
});

test('parseResume and the window directly', () => {
  assert.deepEqual(parseResume(files(10), undefined, 4), { ok: true, starts: [0] });
  assert.deepEqual(parseResume(files(10, 8), [{ index: 1, offset: 8 }], 4), { ok: true, starts: [0, 8] });
  assert.deepEqual(parseResume(files(10), [{ index: 0, offset: 10 }], 4), { ok: true, starts: [10] });
  const window = createTransferWindow({ files: files(10), starts: [4], partBytes: 4, windowParts: 4, lookahead: SMALL.partRequestsPerParty });
  assert.deepEqual(window.next(), { index: 0, part: 1 });
  assert.equal(window.put(0, 1, bytesOf(4)), 'ok');
  assert.equal(window.put(0, 2, bytesOf(2)), 'ok');
  assert.equal(window.next(), null);
  assert.equal(window.take(0, 2).word, 'ok', 'serving part 2 leaves unserved part 1 in place');
  assert.equal(window.parts(), 2);
  assert.equal(window.drop(), 2, 'pause releases the window');
  assert.deepEqual(window.next(), { index: 0, part: 1 }, 'and rewinds the sender to the first part not passed');
  assert.equal(window.bytesDone(), 4);
});

test('R14-F03: a part still being streamed counts against the window until its stream ends, across a pause too', () => {
  const window = createTransferWindow({ files: files(40), starts: [0], partBytes: 4, windowParts: 4, lookahead: 2 });
  for (let part = 0; part < 4; part += 1) assert.equal(window.put(0, part, bytesOf(4)), 'ok');
  const held = [0, 1, 2, 3].map((part) => window.take(0, part, { hold: true }));
  assert.equal(window.take(0, 3).release, undefined, 'a take that streams nothing holds nothing');
  // At the bound: one part in the window, three passed but still streaming; the fifth part waits.
  assert.deepEqual([window.parts(), window.streamParts(), window.streamBytes(), window.check(0, 4).word], [1, 3, 12, 'full']);
  assert.equal(held[0].release(), true, 'a passed part whose stream ends frees its place');
  assert.equal(held[0].release(), false, 'a second release changes nothing');
  assert.deepEqual([window.streamParts(), window.check(0, 4).word], [2, 'ok']);
  // A pause empties the window, but the parts still streaming keep their places.
  window.drop();
  assert.deepEqual([window.parts(), window.streamParts(), window.check(0, 3).word], [0, 3, 'ok']);
  assert.equal(window.put(0, 3, bytesOf(4)), 'ok');
  assert.equal(window.check(0, 4).word, 'full', 'one past the bound');
  for (const hold of held.slice(1)) hold.release();
  assert.deepEqual([window.streamParts(), window.streamBytes(), window.check(0, 4).word], [0, 0, 'ok']);
});
