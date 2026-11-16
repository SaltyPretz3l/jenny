'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isSessionId } = require('../../server/team/ids');
const { VIEWER_LIMITS, createViewers } = require('../../server/team/viewers');

const S1 = 'sess_1800000000000_aaaaaaaaaaaa';
const S2 = 'sess_1800000000000_bbbbbbbbbbbb';
const D1 = 'device_AAAAAAAAAAAAAAAAAAAAAA';
const D2 = 'device_BBBBBBBBBBBBBBBBBBBBBB';
const D3 = 'device_CCCCCCCCCCCCCCCCCCCCCC';

function makeClock(start = 1_000_000) {
  let now = start;
  const clock = () => now;
  clock.set = (value) => { now = value; };
  clock.advance = (ms) => { now += ms; };
  return clock;
}

test('the defaults are 45 seconds and a stated capacity', () => {
  assert.equal(VIEWER_LIMITS.TTL_MS, 45_000);
  assert.ok(Number.isSafeInteger(VIEWER_LIMITS.CAPACITY) && VIEWER_LIMITS.CAPACITY >= 8 * 3);
  const clock = makeClock();
  const viewers = createViewers({ clock });
  assert.equal(viewers.ttlMs, 45_000);
  assert.equal(viewers.capacity, VIEWER_LIMITS.CAPACITY);
});

test('a record is viewing at 44,999 ms and not at 45,000 ms', () => {
  const clock = makeClock();
  const viewers = createViewers({ clock });
  assert.equal(viewers.touch(S1, D1), true);
  clock.advance(44_999);
  assert.equal(viewers.isViewing(S1, D1), true);
  assert.deepEqual(viewers.viewersOf(S1), [D1]);
  clock.advance(1);
  assert.equal(viewers.isViewing(S1, D1), false);
  assert.deepEqual(viewers.viewersOf(S1), []);
});

test('touch refreshes a live or expired record', () => {
  const clock = makeClock();
  const viewers = createViewers({ clock });
  viewers.touch(S1, D1);
  clock.advance(30_000);
  assert.equal(viewers.touch(S1, D1), true);
  clock.advance(30_000);
  assert.equal(viewers.isViewing(S1, D1), true, 'the refresh restarted the 45 s window');
  clock.advance(15_000);
  assert.equal(viewers.isViewing(S1, D1), false);
  assert.equal(viewers.touch(S1, D1), true, 'an expired record comes back on the next heartbeat');
  assert.equal(viewers.isViewing(S1, D1), true);
});

test('a record touched in the future (clock moved back) is not viewing', () => {
  const clock = makeClock(100_000);
  const viewers = createViewers({ clock });
  viewers.touch(S1, D1);
  clock.set(50_000);
  assert.equal(viewers.isViewing(S1, D1), false);
  assert.deepEqual(viewers.viewersOf(S1), []);
});

test('viewing is per (conversation, device)', () => {
  const clock = makeClock();
  const viewers = createViewers({ clock });
  viewers.touch(S1, D1);
  assert.equal(viewers.isViewing(S1, D2), false);
  assert.equal(viewers.isViewing(S2, D1), false);
  viewers.touch(S1, D2);
  viewers.touch(S2, D1);
  assert.deepEqual(viewers.viewersOf(S1).sort(), [D1, D2]);
  assert.deepEqual(viewers.viewersOf(S2), [D1]);
});

test('drop removes one record (stream close)', () => {
  const viewers = createViewers({ clock: makeClock() });
  viewers.touch(S1, D1);
  viewers.touch(S1, D2);
  assert.equal(viewers.drop(S1, D1), true);
  assert.equal(viewers.drop(S1, D1), false);
  assert.equal(viewers.isViewing(S1, D1), false);
  assert.equal(viewers.isViewing(S1, D2), true);
});

test('dropDevice removes every record of a device (revocation)', () => {
  const viewers = createViewers({ clock: makeClock() });
  viewers.touch(S1, D1);
  viewers.touch(S2, D1);
  viewers.touch(S1, D2);
  assert.equal(viewers.dropDevice(D1), 2);
  assert.equal(viewers.isViewing(S1, D1), false);
  assert.equal(viewers.isViewing(S2, D1), false);
  assert.deepEqual(viewers.viewersOf(S1), [D2]);
  assert.equal(viewers.dropDevice(D1), 0);
});

test('dropSession removes every record of a conversation', () => {
  const viewers = createViewers({ clock: makeClock() });
  viewers.touch(S1, D1);
  viewers.touch(S1, D2);
  viewers.touch(S2, D1);
  assert.equal(viewers.dropSession(S1), 2);
  assert.deepEqual(viewers.viewersOf(S1), []);
  assert.equal(viewers.isViewing(S2, D1), true);
});

test('dropWhere removes the records a predicate picks (project removal)', () => {
  const viewers = createViewers({ clock: makeClock() });
  viewers.touch(S1, D1);
  viewers.touch(S1, D2);
  viewers.touch(S2, D3);
  const seen = [];
  const dropped = viewers.dropWhere((record) => {
    seen.push(Object.keys(record).sort().join(','));
    return record.sessionId === S1 && record.deviceId !== D2;
  });
  assert.equal(dropped, 1);
  assert.deepEqual([...new Set(seen)], ['deviceId,sessionId'], 'the predicate sees ids only');
  assert.deepEqual(viewers.viewersOf(S1), [D2]);
  assert.equal(viewers.isViewing(S2, D3), true);
  assert.throws(() => viewers.dropWhere(null), TypeError);
  // Only exactly `true` drops: truthy answers do not.
  assert.equal(viewers.dropWhere(() => 1), 0);
  assert.equal(viewers.dropWhere(() => 'x'), 0);
  assert.equal(viewers.size(), 2);
  // A predicate cannot change a record through the object it is handed.
  viewers.dropWhere((record) => { record.sessionId = S2; return false; });
  assert.equal(viewers.isViewing(S1, D2), true);
});

test('at capacity a new record drops expired ones first', () => {
  const clock = makeClock();
  const viewers = createViewers({ clock, capacity: 2 });
  assert.equal(viewers.touch(S1, D1), true);
  clock.advance(40_000);
  assert.equal(viewers.touch(S1, D2), true);
  clock.advance(5_000); // S1/D1 has now expired, S1/D2 is live
  assert.equal(viewers.touch(S2, D3), true);
  assert.equal(viewers.size(), 2);
  assert.equal(viewers.isViewing(S1, D2), true);
  assert.equal(viewers.isViewing(S2, D3), true);
});

test('at capacity a prune that empties the same conversation still stores the new record', () => {
  const clock = makeClock();
  const viewers = createViewers({ clock, capacity: 2 });
  viewers.touch(S1, D1);
  viewers.touch(S1, D2);
  clock.advance(45_000);
  assert.equal(viewers.touch(S1, D3), true);
  assert.equal(viewers.isViewing(S1, D3), true);
  assert.deepEqual(viewers.viewersOf(S1), [D3]);
  assert.equal(viewers.size(), 1);
  assert.equal(viewers.dropSession(S1), 1);
  assert.equal(viewers.size(), 0);
});

test('at capacity with no expired record a new record is refused (fail closed); a refresh still works', () => {
  const clock = makeClock();
  const viewers = createViewers({ clock, capacity: 2 });
  viewers.touch(S1, D1);
  viewers.touch(S1, D2);
  assert.equal(viewers.touch(S2, D3), false);
  assert.equal(viewers.isViewing(S2, D3), false);
  assert.deepEqual(viewers.viewersOf(S2), []);
  assert.equal(viewers.size(), 2);
  clock.advance(10_000);
  assert.equal(viewers.touch(S1, D1), true, 'an existing record is refreshed at capacity');
  viewers.drop(S1, D2);
  assert.equal(viewers.touch(S2, D3), true, 'room again after a drop');
});

test('malformed ids are never stored and are never viewing', () => {
  const viewers = createViewers({ clock: makeClock() });
  const badSessions = [undefined, null, '', 'sess_', 'session_abc', 'sess_a/b', 'sess_..', 'sess_a b', `sess_${'a'.repeat(124)}`,
    42, { toString: () => S1 }];
  const badDevices = [undefined, null, '', 'device_', 'member_AAAA', 'device_a b', `device_${'A'.repeat(65)}`, 7];
  for (const sessionId of badSessions) {
    assert.equal(viewers.touch(sessionId, D1), false, String(sessionId));
    assert.equal(viewers.isViewing(sessionId, D1), false);
    assert.deepEqual(viewers.viewersOf(sessionId), []);
  }
  for (const deviceId of badDevices) {
    assert.equal(viewers.touch(S1, deviceId), false, String(deviceId));
    assert.equal(viewers.isViewing(S1, deviceId), false);
  }
  assert.equal(viewers.size(), 0);
  assert.equal(viewers.drop('bad', D1), false);
  assert.equal(viewers.dropDevice('bad'), 0);
  assert.equal(viewers.dropSession('bad'), 0);
  assert.equal(isSessionId(S1), true);
  assert.equal(isSessionId(`sess_${'a'.repeat(123)}`), true);
});

test('a broken clock makes nobody viewing', () => {
  let now = 1000;
  const viewers = createViewers({ clock: () => now });
  viewers.touch(S1, D1);
  now = Number.NaN;
  assert.equal(viewers.isViewing(S1, D1), false);
  assert.equal(viewers.touch(S2, D1), false);
  assert.deepEqual(viewers.viewersOf(S1), []);
});

test('a clock that is briefly not finite answers not viewing without dropping the record', () => {
  let now = 1000;
  const viewers = createViewers({ clock: () => now });
  viewers.touch(S1, D1);
  now = Number.NaN;
  assert.equal(viewers.isViewing(S1, D1), false);
  assert.deepEqual(viewers.viewersOf(S1), []);
  assert.equal(viewers.size(), 1, 'the record is kept');
  now = 1000 + 10_000;
  assert.equal(viewers.isViewing(S1, D1), true);
  assert.deepEqual(viewers.viewersOf(S1), [D1]);
});

test('viewersOf never lists an expired record and prunes it', () => {
  const clock = makeClock();
  const viewers = createViewers({ clock });
  viewers.touch(S1, D1);
  clock.advance(20_000);
  viewers.touch(S1, D2);
  clock.advance(25_000);
  assert.deepEqual(viewers.viewersOf(S1), [D2]);
  assert.equal(viewers.size(), 1, 'the expired record was pruned');
  clock.advance(20_000);
  assert.deepEqual(viewers.viewersOf(S1), []);
});

test('membersOf names each viewing member once; a device with no member and a lapsed record are left out', () => {
  const clock = makeClock();
  const viewers = createViewers({ clock });
  const M1 = 'member_AAAAAAAAAAAAAAAAAAAAAA';
  const M2 = 'member_BBBBBBBBBBBBBBBBBBBBBB';
  viewers.touch(S1, D1, M1);
  viewers.touch(S1, D2, M1); // one member on two devices
  viewers.touch(S1, D3); // a device whose member was never named
  assert.deepEqual(viewers.membersOf(S1), [M1]);
  clock.advance(30_000);
  viewers.touch(S1, D3, M2);
  clock.advance(20_000); // D1 and D2 lapse at 45 s; D3 was touched 20 s ago
  assert.deepEqual(viewers.membersOf(S1), [M2]);
  assert.deepEqual(viewers.membersOf(S2), []);
});

test('invalid options are refused', () => {
  for (const bad of [{ ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: 1.5 }, { capacity: 0 }, { capacity: 'many' }, { clock: 5 }]) {
    assert.throws(() => createViewers(bad), TypeError, JSON.stringify(bad));
  }
});

test('a device holds at most 32 records: its own least recently touched goes, other devices are untouched', () => {
  assert.equal(VIEWER_LIMITS.PER_DEVICE, 32);
  const clock = makeClock();
  const viewers = createViewers({ clock });
  const session = (i) => `sess_1_${String(i).padStart(12, '0')}`;
  assert.equal(viewers.touch(S1, D2), true);
  for (let i = 0; i < 40; i += 1) {
    clock.advance(1);
    assert.equal(viewers.touch(session(i), D1), true);
    if (i === 20) assert.equal(viewers.touch(session(0), D1), true, 'a refresh moves session 0 to the newest');
  }
  const kept = Array.from({ length: 40 }, (_, i) => i).filter((i) => viewers.isViewing(session(i), D1));
  assert.deepEqual(kept, [0, ...Array.from({ length: 31 }, (_, i) => i + 9)]);
  assert.equal(viewers.isViewing(S1, D2), true, 'another device is untouched');
  assert.equal(viewers.size(), 33);
});
