'use strict';

// new-test-file: row 123 slice 6-5 model transport (services/team/model-transport.js had no unit test): the receiver's
// network side over a stub host. Loops against an untrusted host end in bounded time and calls, a stale transfer is
// cancelled and accepted again with the right resume list, and a re-pull is bounded even while pauses keep coming.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createModelTransport } = require('../services/team/model-transport');

const OFFER = `offer_${'a'.repeat(22)}`;
const MEMBER = 'member_abcdefghijklmnop';
const SENDER = 'member_bcdefghijklmnopq';
const PART = 10;
const transferId = (n) => `mxfer_${String(n).padStart(22, 'x')}`;

const viewOf = (id, { state = 'accepted', next = { index: 0, part: 0 }, done = 0 } = {}) => ({
  transfer_id: id, offer_id: OFFER, sender_member_id: SENDER, receiver_member_id: MEMBER, state, queued: false,
  reason: null, display_name: 'Qwen', bytes_done: done, bytes_total: 25, next,
});

// A stub host: `commands` and `parts` record every call; `part(...)` answers through `onPart`.
function stubHost({ onPart, onCommand = () => null, sizes = [25], pauses = () => 0 } = {}) {
  const commands = [];
  const parts = [];
  const sleeps = [];
  let now = 0;
  let accepts = 0;
  const transport = createModelTransport({
    command: async (operation, params) => {
      commands.push([operation, params]);
      const custom = onCommand(operation, params);
      if (custom) return custom;
      if (operation === 'team.model.accept') {
        // The host answers `next` at the first resume point not at its file's end.
        accepts += 1;
        const at = params.resume.find((point) => point.offset < sizes[point.index]);
        return { ok: true, transfer: viewOf(transferId(accepts), { next: at ? { index: at.index, part: at.offset / PART } : null }) };
      }
      if (operation === 'team.model.offers') return { ok: true, offers: [], transfers: [viewOf(transferId(accepts), { state: 'flowing' })] };
      return { ok: true };
    },
    part: async (id, index, n) => { parts.push([id, index, n]); return onPart(id, index, n, parts.length); },
    online: () => true, memberId: () => MEMBER, sizesOf: () => sizes, pausesOf: pauses,
    waitChange: async () => { now += 1000; }, sleep: async (ms) => { sleeps.push(ms); now += ms; },
    partBytes: PART, windowParts: 4,
  });
  return { transport, commands, parts, sleeps, clock: () => now };
}

const startAll = (sizes) => sizes.map((_size, file) => ({ file, offset: 0 }));

test('a host that answers a part GET with 204 at once ends the take in bounded time and calls', async () => {
  const host = stubHost({ onPart: (_id, _index, _n, count) => (count > 5000 ? { ok: false, error: { reason: 'guard_tripped' } }
    : { ok: true, ready: false, wait: 'not_ready' }) });
  await host.transport.accept({ offerId: OFFER, startPoints: startAll([25]), signal: null });
  await assert.rejects(host.transport.takePart({ offerId: OFFER, file: 0, offset: 0, signal: null }),
    (error) => error.code === 'team_model_transfer_stale');
  assert.ok(host.parts.length <= 64, `bounded part calls (${host.parts.length})`);
  assert.ok(host.sleeps.length >= host.parts.length - 1, 'a back-off between the answers');
  assert.ok(host.sleeps.every((ms) => ms > 0 && ms <= 30_000));
});

test('team_model_relay_busy forever ends the take after a bounded number of tries', async () => {
  const host = stubHost({ onPart: (_id, _index, _n, count) => (count > 5000 ? { ok: false, error: { reason: 'guard_tripped' } }
    : { ok: false, error: { reason: 'team_model_relay_busy' } }) });
  await host.transport.accept({ offerId: OFFER, startPoints: startAll([25]), signal: null });
  await assert.rejects(host.transport.takePart({ offerId: OFFER, file: 0, offset: 0, signal: null }),
    (error) => error.code === 'team_model_relay_busy');
  assert.ok(host.parts.length <= 64, `bounded part calls (${host.parts.length})`);
});

test('stale answers while pauses keep coming end the take: the re-pull bound is checked before the pauses', async () => {
  let pauses = 0;
  const host = stubHost({
    pauses: () => pauses,
    onPart: (_id, _index, _n, count) => {
      pauses += 1;
      return count > 5000 ? { ok: false, error: { reason: 'guard_tripped' } } : { ok: false, error: { reason: 'team_model_transfer_stale' } };
    },
  });
  await host.transport.accept({ offerId: OFFER, startPoints: startAll([25]), signal: null });
  await assert.rejects(host.transport.takePart({ offerId: OFFER, file: 0, offset: 0, signal: null }),
    (error) => error.code === 'team_model_transfer_stale');
  assert.ok(host.parts.length <= 64, `bounded part calls (${host.parts.length})`);
});

test('a part asked again before the base cancels the transfer and accepts the offer again with the right resume list', async () => {
  const sizes = [25, 7];
  const host = stubHost({ sizes, onPart: (_id, index, n) => ({ ok: true, ready: true, bytes: Buffer.from(`${index}:${n}`) }) });
  await host.transport.accept({ offerId: OFFER, startPoints: startAll(sizes), signal: null });
  for (const offset of [0, 10, 20]) await host.transport.takePart({ offerId: OFFER, file: 0, offset, signal: null });
  // A segment check failed: the receiver asks for the part at 10 again, which the live transfer is already past.
  const bytes = await host.transport.takePart({ offerId: OFFER, file: 0, offset: 10, signal: null });
  assert.equal(bytes.toString(), '0:1');
  const sent = host.commands.map(([operation, params]) => [operation, params.transfer_id || params.resume || null]);
  assert.deepEqual(sent, [
    ['team.model.accept', [{ index: 0, offset: 0 }, { index: 1, offset: 0 }]],
    ['team.model.cancel', transferId(1)],
    ['team.model.accept', [{ index: 0, offset: 10 }, { index: 1, offset: 0 }]],
  ]);
  assert.deepEqual(host.parts, [[transferId(1), 0, 0], [transferId(1), 0, 1], [transferId(1), 0, 2], [transferId(2), 0, 1]]);
});
