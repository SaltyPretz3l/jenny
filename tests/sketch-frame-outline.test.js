'use strict';

// new-test-file: the frame's `outline` message (row 150 slice B9) is one new message of renderer/frames/sketch-frame-init.js;
// sketch-frame-contract.test.js holds the frame's other messages and is at its line cap, so this file copies its small harness.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const INIT_SOURCE = fs.readFileSync(path.resolve(__dirname, '../renderer/frames/sketch-frame-init.js'), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const KEYS = {
  answer: ['type', 'requestId', 'ok', 'nodes', 'groups', 'edges'],
  node: ['id', 'label', 'group'],
  group: ['id', 'label', 'parent'],
  edge: ['from', 'to', 'label', 'dashed'],
};

function startFrame(laidOut) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="sketch-root"></div></body></html>');
  const posted = [];
  const listeners = {};
  const parent = { postMessage: (payload) => posted.push(payload) };
  const api = {
    SKETCH_BOUNDS: { chars: 16384, lines: 400, nodes: 120 },
    render: async () => ({ kind: 'drawn', problems: [], counts: null, laidOut }),
    previousLayout: () => ({ direction: 'right', positions: {} }),
    setPalette: () => {},
  };
  const frameWindow = { parent, jennySketch: api, addEventListener: (type, listener) => { listeners[type] = listener; } };
  new Function('window', 'document', 'ResizeObserver', INIT_SOURCE)(frameWindow, dom.window.document, undefined);
  const send = (data, source = parent) => listeners.message({ source, data });
  const outlines = () => posted.filter((payload) => payload.type === 'outline');
  return { posted, send, outlines };
}

const SCENE = () => ({
  width: 400, height: 200,
  nodes: [
    { id: 'a', label: 'Alpha', group: 'g', x: 0, y: 0, width: 100, height: 40, lines: ['Alpha'], shape: 'box', icon: 'cloud', description: 'secret', file: 'x.js' },
    { id: 'b', label: 'Beta', x: 200, y: 0, width: 100, height: 40, lines: ['Beta'] },
  ],
  groups: [{ id: 'g', label: 'Core', x: 0, y: 0, width: 150, height: 90 }, { id: 'h', label: 'Inner', parent: 'g', x: 5, y: 5, width: 50, height: 50 }],
  edges: [
    { id: 'e1', from: 'a', to: 'b', label: 'next', style: 'dashed', points: [{ x: 1, y: 2 }], tone: 'accent' },
    { id: 'e2', from: 'b', to: 'a', points: [] },
    { id: 'e3', from: 'a', to: 'missing' },
  ],
  parts: [{ id: 'p' }], steps: [{ title: 'one' }], figures: [], images: [], labels: [], wires: [],
});

async function drawn(laidOut, requestId = 'r1') {
  const frame = startFrame(laidOut);
  frame.send({ type: 'render', requestId, source: 'a Alpha' });
  await settle();
  return frame;
}

test('outline answers with the nodes, groups and edges of the drawing that is up and nothing else', async () => {
  const frame = await drawn(SCENE());
  frame.send({ type: 'outline', requestId: 'r1' });
  await settle();
  const [answer] = frame.outlines();
  assert.deepEqual(answer, {
    type: 'outline', requestId: 'r1', ok: true,
    nodes: [{ id: 'a', label: 'Alpha', group: 'g' }, { id: 'b', label: 'Beta', group: '' }],
    groups: [{ id: 'g', label: 'Core', parent: '' }, { id: 'h', label: 'Inner', parent: 'g' }],
    edges: [{ from: 'a', to: 'b', label: 'next', dashed: true }, { from: 'b', to: 'a', label: '', dashed: false }],
  });
  assert.equal(frame.outlines().length, 1, 'exactly one message');
  assert.deepEqual(Object.keys(answer), KEYS.answer);
  answer.nodes.forEach((node) => assert.deepEqual(Object.keys(node), KEYS.node));
  answer.groups.forEach((group) => assert.deepEqual(Object.keys(group), KEYS.group));
  answer.edges.forEach((e) => assert.deepEqual(Object.keys(e), KEYS.edge));
  const text = JSON.stringify(answer);
  for (const leak of ['secret', 'x.js', 'cloud', 'points', 'accent', 'steps', 'one']) assert.equal(text.includes(leak), false, leak);
});

test('a wrong request id, and a request before the drawing is up, are ignored', async () => {
  const frame = startFrame(SCENE());
  frame.send({ type: 'outline', requestId: 'r1' });
  await settle();
  assert.deepEqual(frame.outlines(), [], 'nothing is drawn yet');
  frame.send({ type: 'render', requestId: 'r1', source: 'a Alpha' });
  frame.send({ type: 'outline', requestId: 'r1' });
  assert.deepEqual(frame.outlines(), [], 'still being drawn');
  await settle();
  frame.send({ type: 'outline', requestId: 'other' });
  frame.send({ type: 'outline' });
  frame.send({ type: 'outline', requestId: 'r1' }, { postMessage() {} });
  await settle();
  assert.deepEqual(frame.outlines(), []);
  frame.send({ type: 'outline', requestId: 'r1' });
  await settle();
  assert.equal(frame.outlines().length, 1);
});

test('labels are cut, ids are cut to 64, and a group, id or label that is not text is left empty', async () => {
  const scene = SCENE();
  scene.nodes = [
    { id: 'n'.repeat(80), label: 'L'.repeat(500), group: 'g'.repeat(70) },
    { id: 'plain', label: { text: 'not a string' } },
  ];
  scene.groups = [{ id: 'g'.repeat(70), label: 'G'.repeat(401), parent: 5 }];
  scene.edges = [{ from: 'n'.repeat(80), to: 'plain', label: 'E'.repeat(450), style: 'solid' }];
  const frame = await drawn(scene);
  frame.send({ type: 'outline', requestId: 'r1' });
  await settle();
  const [answer] = frame.outlines();
  assert.equal(answer.ok, true);
  assert.equal(answer.nodes[0].id.length, 64);
  assert.equal(answer.nodes[0].label.length, 400);
  assert.equal(answer.nodes[0].group.length, 64);
  assert.equal(answer.nodes[1].label, '');
  assert.equal(answer.groups[0].label.length, 400);
  assert.equal(answer.groups[0].parent, '');
  assert.equal(answer.edges.length, 1, 'an end that was cut still names its node');
  assert.equal(answer.edges[0].label.length, 400);
  assert.equal(answer.edges[0].from, 'n'.repeat(64));
});

test('over 120 nodes, 50 groups or 400 edges the answer is ok:false and carries nothing else', async () => {
  const many = (count, make) => Array.from({ length: count }, (_, index) => make(index));
  const cases = [
    { nodes: many(121, (i) => ({ id: `n${i}`, label: 'N' })) },
    { groups: many(51, (i) => ({ id: `g${i}`, label: 'G' })) },
    { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: many(401, () => ({ from: 'a', to: 'b' })) },
  ];
  for (const change of cases) {
    const frame = await drawn({ ...SCENE(), nodes: [], groups: [], edges: [], ...change });
    frame.send({ type: 'outline', requestId: 'r1' });
    await settle();
    assert.deepEqual(frame.outlines(), [{ type: 'outline', requestId: 'r1', ok: false }]);
  }
  const edge = await drawn({ ...SCENE(), nodes: many(120, (i) => ({ id: `n${i}`, label: 'N' })), groups: many(50, (i) => ({ id: `g${i}`, label: 'G' })), edges: [] });
  edge.send({ type: 'outline', requestId: 'r1' });
  await settle();
  assert.equal(edge.outlines()[0].ok, true, 'exactly at the bounds is answered');
});

test('a scene that cannot be read answers ok:false and never throws; two nodes with one id do too', async () => {
  for (const scene of [{ width: 1, nodes: 'x', groups: [], edges: [] }, { width: 1, nodes: [null], groups: [], edges: [] }, { width: 1 },
    { width: 1, nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], groups: [], edges: [] }]) {
    const frame = await drawn(scene);
    assert.doesNotThrow(() => frame.send({ type: 'outline', requestId: 'r1' }));
    await settle();
    assert.deepEqual(frame.outlines(), [{ type: 'outline', requestId: 'r1', ok: false }]);
  }
});
