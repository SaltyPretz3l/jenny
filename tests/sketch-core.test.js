'use strict';

// Golden scenes for the vendored Sketchy core. A re-sync of vendor/sketchy that
// changes how a source parses or builds fails here instead of silently
// changing drawings. Set UPDATE_SKETCH_GOLDEN=1 to rewrite the stored scenes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildSketchBundles, sketchBuildPlan, REPO_ROOT } = require('../scripts/build/build-sketch');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sketch');
const MAX_FRAME_BYTES = 3_000_000;
const UPDATE = process.env.UPDATE_SKETCH_GOLDEN === '1';

const GOLDEN_SCENES = [
  'flow',
  'groups',
  'arrows',
  'steps',
  'shapes-icons',
  'followup-base',
  'followup-added',
  'chart',
  'sequence',
  'tree',
  'molecule',
  'map',
];

let core;
let frameBundlePath;

test.before(async () => {
  // Builds both bundles only when their stamp is stale, so a clean checkout passes.
  const result = await buildSketchBundles({ root: REPO_ROOT });
  const plan = sketchBuildPlan(REPO_ROOT);
  frameBundlePath = plan.frameOutput;
  assert.equal(typeof result.skipped, 'boolean');
  core = require(plan.coreOutput);
});

function readSource(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.sketch`), 'utf8').replace(/\r\n/g, '\n');
}

async function buildScene(source) {
  return core.buildScene(core.parse(source));
}

// JSON round trip so the comparison sees exactly what is stored on disk.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

for (const name of GOLDEN_SCENES) {
  test(`golden scene: ${name}`, async () => {
    const scene = plain(await buildScene(readSource(name)));
    const storedPath = path.join(FIXTURE_DIR, `${name}.scene.json`);
    if (UPDATE) fs.writeFileSync(storedPath, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
    const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
    assert.deepEqual(scene, stored);
  });
}

test('the core bundle names the pinned upstream commit and its entry points', () => {
  assert.equal(core.version, 'c246cd47');
  for (const key of ['parse', 'buildScene', 'layout']) assert.equal(typeof core[key], 'function', key);
});

test('every golden source is covered by a stored scene', () => {
  const sources = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.sketch')).map((f) => f.replace(/\.sketch$/, ''));
  assert.deepEqual(sources.sort(), [...GOLDEN_SCENES].sort());
});

test('the icon set is Lucide only and reports an unknown name instead of throwing', async () => {
  assert.equal(core.hasIcon('lucide:database'), true);
  assert.equal(core.hasIcon('database'), true);
  assert.equal(core.hasIcon('simple-icons:react'), false);
  assert.equal(core.hasIcon('lucide:no-such-icon-xyz'), false);
  // The builder stays strict: the checking layer removes the icon before this point.
  await assert.rejects(() => buildScene('a Alpha @no-such-icon-xyz'), /Unknown icon/);
});

test('the parser is permissive and the builder names a missing id', async () => {
  const parsed = core.parse('a Alpha\nb Beta\na -> missing');
  assert.equal(parsed.nodes.length, 2);
  await assert.rejects(() => core.buildScene(parsed), /missing/);
});

function inside(inner, outer) {
  const slack = 0.5;
  return inner.x >= outer.x - slack
    && inner.y >= outer.y - slack
    && inner.x + inner.width <= outer.x + outer.width + slack
    && inner.y + inner.height <= outer.y + outer.height + slack;
}

test('layout of a plain flow places every node on the canvas without overlap', async () => {
  const laid = await core.layout(await buildScene(readSource('flow')));
  assert.equal(laid.kind, 'scene');
  assert.equal(laid.nodes.length, 3);
  for (const node of laid.nodes) {
    assert.ok(node.x >= 0 && node.y >= 0, `${node.id} starts on the canvas`);
    assert.ok(node.x + node.width <= laid.width + 0.5 && node.y + node.height <= laid.height + 0.5, `${node.id} ends on the canvas`);
  }
  for (const edge of laid.edges) assert.ok(edge.points.length >= 2, 'edges are routed');
});

test('elkjs 0.12.1 regression guard: every grouped node lies inside its group', async () => {
  const laid = await core.layout(await buildScene(readSource('groups')));
  const groupById = new Map(laid.groups.map((g) => [g.id, g]));
  const grouped = laid.nodes.filter((n) => n.group);
  assert.equal(grouped.length, 5, 'five grouped nodes in the scene');
  for (const node of grouped) {
    const group = groupById.get(node.group);
    assert.ok(group, `group ${node.group} exists`);
    assert.ok(inside(node, group), `${node.id} (${node.x},${node.y},${node.width},${node.height}) is inside ${group.id} (${group.x},${group.y},${group.width},${group.height})`);
  }
  // Nested groups obey the same rule.
  const nested = laid.groups.filter((g) => g.parent);
  for (const group of nested) assert.ok(inside(group, groupById.get(group.parent)), `${group.id} is inside ${group.parent}`);
});

test('a follow-up that appends a node keeps the earlier nodes in their order along the flow', async () => {
  const first = await core.layout(await buildScene(readSource('followup-base')));
  const previous = core.previousLayout(first);
  assert.equal(previous.direction, 'right');
  const second = await core.layout(await buildScene(readSource('followup-added')), previous);
  assert.equal(second.nodes.length, first.nodes.length + 1);
  const byX = (scene, ids) => ids.map((id) => scene.nodes.find((n) => n.id === id).x);
  const ids = ['in', 'parse', 'check', 'out'];
  const before = byX(first, ids);
  const after = byX(second, ids);
  for (const xs of [before, after]) assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'left to right');
  const log = second.nodes.find((n) => n.id === 'log');
  assert.ok(log.x > after[3], 'the appended node lands downstream of its neighbour');
});

test('the frame bundle is under its size ceiling, is browser code, and has no eval or fetch of its own', () => {
  const stat = fs.statSync(frameBundlePath);
  assert.ok(stat.size > 100_000 && stat.size <= MAX_FRAME_BYTES, `frame bundle is ${stat.size} bytes`);
  const text = fs.readFileSync(frameBundlePath, 'utf8');
  assert.equal(/\beval\s*\(|new Function\b/.test(text), false, 'no eval and no new Function');
  assert.equal(/jsdelivr|unpkg/.test(text), false, 'no CDN address');
  assert.equal(/require\(["']node:/.test(text), false, 'no Node built-in');
  assert.match(text, /jennySketch/);
});

test('the frame bundle exposes jennySketch with render, parse, setPalette and version', () => {
  const vm = require('node:vm');
  const sandbox = { window: undefined, globalThis: undefined, performance, console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // No DOM here: evaluating the bundle must only define the global.
  vm.runInContext(fs.readFileSync(frameBundlePath, 'utf8'), sandbox);
  const api = vm.runInContext('jennySketch', sandbox);
  assert.equal(api.version, 'c246cd47');
  for (const key of ['render', 'parse', 'setPalette']) assert.equal(typeof api[key], 'function', key);
  // The palette accepts six-digit hex only and does not need a document.
  assert.doesNotThrow(() => api.setPalette({ ink: '#112233', paper: 'red' }));
  const parsed = api.parse('a Alpha\nb Beta\na -> b');
  assert.equal(parsed.nodes.length, 2);
});

test('render draws one svg into a container, applies the palette and reports a bad source instead of rejecting', async (t) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  // jsdom has no layout engine: give the viewer the two measuring APIs it calls after drawing.
  dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
  dom.window.document.fonts = { ready: Promise.resolve() };
  dom.window.eval(fs.readFileSync(frameBundlePath, 'utf8'));
  const api = dom.window.jennySketch;
  const root = dom.window.document.getElementById('root');

  api.setPalette({ ink: '#e0e0e0', paper: '#101010', card: 'not a colour' });
  const result = await api.render(root, 'title T\na Alpha @database\nb Beta\na -> b call', {});
  assert.equal(result.kind, 'drawn');
  assert.equal(result.laidOut.nodes.length, 2);
  assert.equal(root.querySelectorAll('svg').length, 1);
  assert.ok(dom.window.document.getElementById('sketch-styles'), 'styles injected once');
  const style = dom.window.document.documentElement.style;
  assert.equal(style.getPropertyValue('--ink'), '#e0e0e0');
  assert.equal(style.getPropertyValue('--paper'), '#101010');
  assert.equal(style.getPropertyValue('--jenny-card'), '#ffffff', 'a value that is not six-digit hex falls back to cream');

  // The checking layer (tests/sketch-check.test.js) drops the arrow to a missing id; with half the drawing gone, render refuses.
  const refused = await api.render(root, 'a Alpha\na -> missing');
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.problems[0].code, 'missing_id');
  await new Promise((resolve) => dom.window.setTimeout(resolve, 20));
});
