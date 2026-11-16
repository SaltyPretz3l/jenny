'use strict';

// new-test-file: the follow-up picker (plan 5.5, slice S7) is a new surface of the sketch core bundle; it
// is exercised through the built Node bundle like tests/sketch-core.test.js, which stays the golden-scene file.

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSketchBundles, sketchBuildPlan, REPO_ROOT } = require('../scripts/build/build-sketch');

let core;

test.before(async () => {
  await buildSketchBundles({ root: REPO_ROOT });
  core = require(sketchBuildPlan(REPO_ROOT).coreOutput);
});

const lines = (...rows) => rows.join('\n');

// The earlier drawing: a four-step flow.
const BASE = lines('title Pipeline', 'dir right', 'in Input', 'parse Parse', 'check Check', 'out Output',
  'in -> parse', 'parse -> check', 'check -> out');
// Nodes appended downstream of everything that was there.
const APPENDED = lines('title Pipeline', 'dir right', 'in Input', 'parse Parse', 'check Check', 'out Output',
  'log Audit log', 'alert Alert', 'in -> parse', 'parse -> check', 'check -> out', 'out -> log', 'log -> alert');
// A node inserted upstream, between in and parse.
const UPSTREAM = lines('title Pipeline', 'dir right', 'in Input', 'intake Intake', 'parse Parse', 'check Check', 'out Output',
  'in -> intake', 'intake -> parse', 'parse -> check', 'check -> out');

async function laidOut(source, previous) {
  const prepared = core.prepare(source);
  assert.equal(prepared.kind, 'scene', 'the test source is a drawing');
  return core.layout(await core.buildScene(prepared.input), previous);
}

// As the page hands positions over: a plain object that crossed postMessage.
const plainCopy = (value) => JSON.parse(JSON.stringify(value));
const spots = (laid) => Object.fromEntries(laid.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));

/** How far each node both layouts have moved, in px, as { id: { dx, dy } }. */
function moves(before, after) {
  const out = {};
  for (const id of Object.keys(before)) {
    if (after[id]) out[id] = { dx: Math.abs(after[id].x - before[id].x), dy: Math.abs(after[id].y - before[id].y) };
  }
  return out;
}

const worst = (moved) => Math.max(0, ...Object.values(moved).flatMap((m) => [m.dx, m.dy]));
const say = (moved) => Object.entries(moved).map(([id, m]) => `${id} dx=${m.dx.toFixed(1)} dy=${m.dy.toFixed(1)}`).join('; ');

// Positions no real layout would produce, so a result can be told apart from a laid-out one.
const fake = (tag) => ({ direction: 'right', positions: { [tag]: { x: 7777, y: 8888 } } });

// Sources of a given number of nodes: n0, n1, ...; `only` picks which of them are declared.
const nodesOf = (ids) => ids.map((id) => `${id} ${id.toUpperCase()}`).join('\n');

test('a follow-up that adds a node named like an Object.prototype key still lays out', async () => {
  const first = lines('a Alpha', 'b Beta', 'c Gamma', 'a -> b', 'b -> c');
  const previous = plainCopy(core.previousLayout(await laidOut(first)));
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const next = await laidOut(lines(first, `${name} Extra`, `c -> ${name}`), previous);
    assert.ok(next.nodes.some((node) => node.id === name), `${name} is drawn`);
  }
});

test('the core bundle exports pickPrevious', () => {
  assert.equal(typeof core.pickPrevious, 'function');
});

test('nodes appended downstream: the nodes both drawings share move by less than 40 px', async () => {
  const earlier = await laidOut(BASE);
  const previous = await core.pickPrevious(APPENDED, [{ source: BASE, positions: null }]);
  assert.ok(previous, 'the earlier drawing is picked');
  const followUp = await laidOut(APPENDED, previous);
  const moved = moves(spots(earlier), spots(followUp));
  assert.deepEqual(Object.keys(moved).sort(), ['check', 'in', 'out', 'parse'], 'all four earlier nodes are shared');
  console.log(`appended downstream, shared nodes moved: ${say(moved)}`);
  assert.ok(worst(moved) < 40, `shared nodes moved by ${worst(moved).toFixed(1)} px at most (${say(moved)})`);
  // Without help the same follow-up is a layout of its own; the claim is about what the picker adds.
  assert.ok(spots(followUp).log && spots(followUp).alert, 'the new nodes are drawn too');
});

test('a node inserted upstream starts a fresh layout: the earlier drawing is passed over, because starting from it bends the drawing', async () => {
  const earlier = await laidOut(BASE);
  assert.equal(await core.pickPrevious(UPSTREAM, [{ source: BASE, positions: null }]), null, 'the earlier drawing is not picked');
  assert.equal(await core.pickPrevious(UPSTREAM, [{ source: BASE, positions: core.previousLayout(earlier) }]), null, 'with its positions known either');
  // A new node that only receives arrows from shared nodes is downstream: that earlier drawing is still picked.
  assert.ok(await core.pickPrevious(APPENDED, [{ source: BASE, positions: null }]));
  // An older drawing that already had the inserted node is picked instead of the nearer one that lacks it.
  assert.ok(await core.pickPrevious(UPSTREAM, [{ source: BASE, positions: null }, { source: UPSTREAM, positions: null }]));
  const fresh = spots(await laidOut(UPSTREAM));
  const flow = ['in', 'intake', 'parse', 'check', 'out'].map((id) => fresh[id].x);
  assert.deepEqual([...flow].sort((a, b) => a - b), flow, 'laid out fresh, every arrow runs forward');
  // What the rule avoids, measured on the engine at the pinned commit: started from the earlier layout, the shared
  // nodes keep their columns, the ones after the insertion drop to another row, and the new node lands past the
  // node it feeds.
  const previous = core.previousLayout(earlier);
  const followUp = await laidOut(UPSTREAM, previous);
  const before = spots(earlier);
  const after = spots(followUp);
  const moved = moves(before, after);
  // Recorded behaviour (engine at the pinned commit): the shared nodes keep their columns, the ones after the
  // insertion drop to another row, and the new node is placed one step past its neighbour, so it can land
  // beside or after a node it feeds. No "less than 40 px" is claimed here (plan 5.5).
  console.log(`inserted upstream, shared nodes moved: ${say(moved)}`);
  console.log(`inserted upstream, earlier ${JSON.stringify(before)}; follow-up ${JSON.stringify(after)}`);
  const along = (positions) => ['in', 'parse', 'check', 'out'].map((id) => positions[id].x);
  assert.deepEqual([...along(after)].sort((a, b) => a - b), along(after), 'in, parse, check and out keep their order along the flow');
  assert.deepEqual(along(after), along(before), 'and their columns');
  assert.ok(worst(moved) >= 40, `the shift is real: shared nodes moved by ${worst(moved).toFixed(1)} px at most (${say(moved)})`);
  assert.ok(after.intake.x > after.parse.x, 'the inserted node is drawn after the node it feeds: its arrow runs backwards');
});

test('positions from memory and positions from one fresh layout of the same earlier source give the same follow-up within 1 px', async () => {
  const earlier = await laidOut(BASE);
  const fromMemory = await core.pickPrevious(APPENDED, [{ source: BASE, positions: core.previousLayout(earlier) }]);
  const fromFresh = await core.pickPrevious(APPENDED, [{ source: BASE, positions: null }]);
  const a = spots(await laidOut(APPENDED, fromMemory));
  const b = spots(await laidOut(APPENDED, fromFresh));
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  const gap = moves(a, b);
  console.log(`memory against fresh, follow-up nodes differ by: ${say(gap)}`);
  assert.ok(worst(gap) <= 1, `the two follow-ups differ by ${worst(gap).toFixed(3)} px at most`);
});

test('the half rule: exactly half of the new drawing\'s ids is enough, just under is not, and no shared id is never', async () => {
  const mine = nodesOf(['a', 'b', 'c', 'd']);
  const half = nodesOf(['a', 'b', 'x', 'y']); // 2 of 4
  const under = nodesOf(['a', 'x', 'y', 'z']); // 1 of 4
  const none = nodesOf(['x', 'y', 'z', 'w']);
  assert.equal(await core.pickPrevious(mine, [{ source: half, positions: fake('half') }]).then((p) => Object.keys(p.positions)[0]), 'half');
  assert.equal(await core.pickPrevious(mine, [{ source: under, positions: fake('under') }]), null);
  assert.equal(await core.pickPrevious(mine, [{ source: none, positions: fake('none') }]), null);
  // Five ids, two shared is 0.4: under half. Five ids, three shared passes.
  const five = nodesOf(['a', 'b', 'c', 'd', 'e']);
  assert.equal(await core.pickPrevious(five, [{ source: nodesOf(['a', 'b', 'x']), positions: fake('two') }]), null);
  assert.ok(await core.pickPrevious(five, [{ source: nodesOf(['a', 'b', 'c', 'x']), positions: fake('three') }]));
  // The share is of the new drawing's ids: an earlier drawing that holds all of them and more qualifies.
  assert.ok(await core.pickPrevious(mine, [{ source: nodesOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), positions: fake('big') }]));
});

test('nearest first: when two earlier drawings qualify the nearer one is taken', async () => {
  const mine = nodesOf(['a', 'b', 'c']);
  const near = { source: nodesOf(['a', 'b']), positions: fake('near') };
  const far = { source: nodesOf(['a', 'b', 'c']), positions: fake('far') };
  assert.deepEqual(await core.pickPrevious(mine, [near, far]), fake('near'));
  assert.deepEqual(await core.pickPrevious(mine, [far, near]), fake('far'));
});

test('a nearer drawing that does not qualify is passed over', async () => {
  const mine = nodesOf(['a', 'b', 'c', 'd']);
  const unrelated = { source: nodesOf(['x', 'y']), positions: fake('unrelated') };
  const refused = { source: '', positions: fake('refused') };
  const mermaid = { source: 'graph TD\nA-->B', positions: fake('mermaid') };
  const qualifies = { source: nodesOf(['a', 'b', 'c']), positions: fake('qualifies') };
  assert.deepEqual(await core.pickPrevious(mine, [unrelated, refused, mermaid, qualifies]), fake('qualifies'));
});

test('given positions come back untouched, and no layout is run for them', async () => {
  const given = fake('given');
  const item = { source: nodesOf(['a', 'b', 'c']), positions: given };
  const picked = await core.pickPrevious(nodesOf(['a', 'b', 'c', 'd']), [item]);
  assert.equal(picked, given, 'the very object the caller gave');
  assert.deepEqual(picked, fake('given'), 'and not a laid-out layout of the source (7777/8888 is no layout)');
});

test('without positions the item taken is laid out once, fresh, with no previous of its own (no chain)', async () => {
  const earlierSource = APPENDED;
  const fresh = core.previousLayout(await laidOut(earlierSource));
  // A nearer drawing that does not qualify carries positions, and a farther one qualifies and carries positions
  // that are not laid out: neither feeds the layout of the one taken.
  const next = `${APPENDED}\npage Pager\nalert -> page`; // one more step downstream of the one taken
  const picked = await core.pickPrevious(next, [
    { source: nodesOf(['q', 'r']), positions: fake('unrelated') },
    { source: earlierSource, positions: null },
    { source: BASE, positions: fake('chain') },
  ]);
  assert.deepEqual(picked, fresh, 'the same as a layout of that source on its own');
  assert.ok(!('chain' in picked.positions) && !('unrelated' in picked.positions));
});

test('an earlier source that cannot be built, or whose item fails, is skipped and the walk goes on', async () => {
  const mine = nodesOf(['a', 'b', 'c']);
  const broken = { source: nodesOf(['a', 'b', 'c']), get positions() { throw new Error('a hostile getter'); } };
  const notText = { source: 42, positions: fake('number') };
  const hole = null;
  const qualifies = { source: nodesOf(['a', 'b', 'c']), positions: fake('good') };
  assert.deepEqual(await core.pickPrevious(mine, [broken, notText, hole, qualifies]), fake('good'));
  // A source the checker refuses has no ids, so it never qualifies; the one after it is laid out fresh.
  const tooMany = { source: Array.from({ length: 130 }, (_, i) => `n${i} N${i}`).join('\n') + '\na B', positions: null };
  const fresh = await core.pickPrevious(nodesOf(['a', 'b']), [tooMany, { source: nodesOf(['a', 'b', 'c']), positions: null }]);
  assert.deepEqual(Object.keys(fresh.positions).sort(), ['a', 'b', 'c']);
});

test('a refused new source, a Mermaid source and an empty list give null', async () => {
  const earlier = [{ source: nodesOf(['a', 'b']), positions: fake('earlier') }];
  assert.equal(await core.pickPrevious('', earlier), null, 'empty source is refused');
  assert.equal(await core.pickPrevious('   \n', earlier), null);
  assert.equal(await core.pickPrevious('x'.repeat(20000), earlier), null, 'over the size bound is refused');
  assert.equal(await core.pickPrevious('graph TD\nA-->B', earlier), null, 'a Mermaid source has no ids');
  assert.equal(await core.pickPrevious(nodesOf(['a', 'b']), []), null);
  // A source of figures only has no node ids, so nothing is picked.
  assert.equal(await core.pickPrevious('title Only a title', earlier), null);
});

test('a call never rejects, whatever it is given', async () => {
  const earlier = [{ source: nodesOf(['a']), positions: fake('x') }];
  for (const [source, list] of [
    [undefined, earlier], [null, earlier], [7, earlier], [{}, earlier],
    [nodesOf(['a']), undefined], [nodesOf(['a']), null], [nodesOf(['a']), 'text'], [nodesOf(['a']), 5], [nodesOf(['a']), { length: 1 }],
    [nodesOf(['a']), [undefined]], [nodesOf(['a']), [{ source: {} }]], [nodesOf(['a']), [{ source: nodesOf(['a']), positions: 'text' }]],
  ]) {
    const result = await core.pickPrevious(source, list);
    assert.ok(result === null || typeof result === 'object', `${String(source).slice(0, 12)} / ${typeof list} resolves`);
  }
  // A list whose reading throws.
  const trap = new Proxy([], { get() { throw new Error('a trapped list'); } });
  assert.equal(await core.pickPrevious(nodesOf(['a']), trap), null);
});
