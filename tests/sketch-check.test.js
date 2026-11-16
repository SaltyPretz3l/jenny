'use strict';

// new-test-file: the checking layer (scripts/build/sketch/check*.ts) is a new surface. tests/sketch-core.test.js
// keeps the golden scenes of the vendored core; this file covers what Jenny adds around the parser and the builder.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { buildSketchBundles, sketchBuildPlan, REPO_ROOT } = require('../scripts/build/build-sketch');
const { seeded, generateSource } = require('./fixtures/sketch-check/generate');
const { rendererHeaderPattern, loadFrame } = require('./fixtures/sketch-check/helpers');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sketch-check');
const MESSY = fs.readFileSync(path.join(FIXTURE_DIR, 'messy.sketch'), 'utf8').replace(/\r\n/g, '\n');

let core;
let frameBundlePath;

test.before(async () => {
  // Builds the bundles only when their stamp is stale, so a clean checkout passes.
  await buildSketchBundles({ root: REPO_ROOT });
  const plan = sketchBuildPlan(REPO_ROOT);
  frameBundlePath = plan.frameOutput;
  core = require(plan.coreOutput);
});

const prepare = (source) => core.prepare(source);
const codes = (result) => result.problems.map((p) => p.code);
const nodeOf = (result, id) => result.input.nodes.find((n) => n.id === id);
const join = (lines) => lines.join('\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
// [code, line, id, to] for each problem: what most checks compare.
const brief = (result) => result.problems.map((p) => [p.code, p.line, p.id, p.to]);

function asScene(source) {
  const result = prepare(source);
  assert.equal(result.kind, 'scene', `expected a scene, got ${JSON.stringify(result)}`);
  return result;
}

// `n` nodes (n1..nN) joined by n-1 arrows: 2n-1 elements, so one stray line stays under a quarter. Lines 1 to 2n-1.
function chain(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`n${i} Node ${i}`);
  for (let i = 1; i < n; i++) lines.push(`n${i} -> n${i + 1}`);
  return lines;
}

test('both bundles export prepare and SKETCH_BOUNDS; the bounds are the plan 5.2 numbers', () => {
  assert.deepEqual({ ...core.SKETCH_BOUNDS }, { chars: 16384, lines: 400, nodes: 120 });
  const sandbox = { performance, console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(frameBundlePath, 'utf8'), sandbox);
  const api = vm.runInContext('jennySketch', sandbox);
  assert.deepEqual({ ...api.SKETCH_BOUNDS }, { chars: 16384, lines: 400, nodes: 120 });
  assert.equal(api.prepare('a Alpha\nb Beta\na -> b').kind, 'scene');
  for (const name of ['render', 'parse', 'buildScene', 'layout', 'previousLayout', 'setPalette', 'hasIcon', 'SceneError', 'version']) {
    assert.ok(name in api, `${name} stays exported`);
  }
});

test('a clean source passes through untouched, with no problems', () => {
  const source = 'title T\ndir right\ngroup g One\na Alpha @database in g\nb Beta (cylinder) !accent ~ hover\na -> b call\nlabel a Primary\nstep Go: it runs | a b a->b';
  const result = asScene(source);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.counts, { elements: 6, dropped: 0, flagged: 0, nodes: 3 });
  const parsed = core.parse(source);
  for (const key of ['title', 'direction', 'groups', 'nodes', 'edges', 'labels', 'steps']) assert.deepEqual(result.input[key], parsed[key], key);
});

test('prepare is pure: results are not shared between calls', () => {
  const first = prepare(MESSY);
  first.input.nodes.length = 0;
  first.problems.length = 0;
  assert.ok(prepare(MESSY).input.nodes.length > 5);
  assert.deepEqual(prepare(MESSY), prepare(MESSY));
});

test('part, wire and image lines are removed and reported with their line number', () => {
  const lines = chain(10);
  lines.splice(2, 0, 'part r1 resistor value=10k', 'wire r1.a -> r2.b red', 'image photo1', 'wire something odd');
  const result = asScene(join(lines));
  assert.deepEqual(result.problems.map((p) => [p.code, p.line, p.text]), [
    ['removed_line', 3, 'part r1 resistor value=10k'],
    ['removed_line', 4, 'wire r1.a -> r2.b red'],
    ['removed_line', 5, 'image photo1'],
    ['removed_line', 6, 'wire something odd'], // the parser would have read this one as a node called wire
  ]);
  assert.equal(result.input.nodes.length, 10);
  assert.equal(result.counts.dropped, 4);
  assert.deepEqual(Object.keys(result.input).filter((k) => ['parts', 'wires', 'images'].includes(k)), []);
});

test('a line over 2000 characters is not a statement: it is removed and reported, cut to 200 characters', () => {
  const result = asScene(join([...chain(10), `x ${'word '.repeat(500)}`]));
  assert.deepEqual(codes(result), ['removed_line']);
  assert.equal(result.problems[0].line, 20);
  assert.ok(result.problems[0].text.length <= 200);
});

test('a Mermaid header as the first non-empty line is detected and the source is handed back', () => {
  for (const header of ['graph TD', 'graph LR', 'flowchart LR', 'flowchart TB', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram',
    'journey', 'gantt', 'pie title Pets', 'gitGraph', 'quadrantChart', 'block-beta', 'GRAPH td']) {
    const source = `\n  \n${header}\n  A-->B`;
    assert.deepEqual(prepare(source), { kind: 'mermaid', source }, header);
  }
  // Not a header: no direction, a word that only starts like one, or a header that is not the first line.
  for (const source of ['graph Graph of things\na Alpha', 'pies Pies\na Alpha', 'title T\ngraph TD\na Alpha']) assert.equal(prepare(source).kind, 'scene', source);
  // Sketchy's own figure headers share two words with Mermaid: a header with an id is a figure, a bare word is Mermaid.
  assert.equal(prepare('timeline t: Plan\n2024: Start').kind, 'scene');
  assert.equal(prepare('mindmap m: Plan\nIdea').kind, 'scene');
  assert.equal(prepare('timeline\n  title History').kind, 'mermaid');
  assert.equal(prepare('mindmap\n  root').kind, 'mermaid');
});

test('the Mermaid header list equals the one the renderer already has', () => {
  const pattern = rendererHeaderPattern();
  const words = [...pattern.source.matchAll(/[A-Za-z][A-Za-z0-9-]*/g)].map((m) => m[0]).filter((w) => w !== 's' && w !== 'b');
  assert.ok(words.length >= 15, `read ${words.length} words from the renderer's pattern`);
  // Words Mermaid has that neither list is expected to know are probed too, so a one-sided addition shows.
  const extra = ['requirementDiagram', 'architecture-beta', 'kanban', 'radar-beta', 'treemap-beta', 'zenuml', 'C4Context', 'sankey-beta', 'xychart-beta', 'state', 'node', 'database', 'user'];
  let compared = 0;
  for (const word of new Set([...words, ...extra])) {
    for (const sample of [word, `${word} TD`, `${word} LR`, word.toUpperCase(), `${word}x`, `  ${word}  `, `${word}-v2`, `${word} title Sales`]) {
      const tokens = sample.trim().split(/\s+/);
      // The one documented difference: a figure header (`timeline t`, `mindmap m`) is not Mermaid.
      const expected = pattern.test(sample.trim()) && !(tokens.length > 1 && ['timeline', 'mindmap'].includes(tokens[0].toLowerCase()));
      assert.equal(prepare(`${sample}\nA-->B`).kind === 'mermaid', expected, JSON.stringify(sample));
      compared++;
    }
  }
  assert.ok(compared > 200);
});

test('inside a step, a -> b is rewritten to a->b so it names the arrow', () => {
  const result = asScene('browser Browser\ndns DNS\nbrowser -> dns lookup\nstep Ask: x | browser -> dns');
  assert.deepEqual(result.input.steps[0].highlight, ['browser->dns']);
  assert.deepEqual(result.problems, []);
  // Dashed and two-way arrows name the same edge id; with spaces on either side or none.
  assert.deepEqual(asScene('a Alpha\nb Beta\nc Gamma\na <-> b\nb --> c\nstep S: t | a <-> b, b-->c  c').input.steps[0].highlight, ['a->b', 'b->c', 'c']);
  // The arrow in the step's text is prose and stays.
  assert.equal(asScene('a Alpha\nb Beta\na -> b\nstep S: a -> b happens | a b').input.steps[0].text, 'a -> b happens');
});

test('square brackets copied from the grammar notation are taken off; brackets that are label text stay', () => {
  const result = asScene([
    'group g1 One', 'a Alpha [(cylinder)]', 'b Beta [@database]', 'c Gamma [in g1]', 'd Delta [!accent]', 'e Echo [~ hover text]',
    'f Foxtrot [@server] [(person)] [in g1] [!muted] [~ all of them]', 'a -> b [sends data]',
  ].join('\n'));
  assert.deepEqual(result.problems, []);
  const pick = (id, ...keys) => keys.map((k) => nodeOf(result, id)[k]);
  assert.deepEqual([pick('a', 'shape'), pick('b', 'icon'), pick('c', 'group'), pick('d', 'tone'), pick('e', 'description')].flat(),
    ['cylinder', 'lucide:database', 'g1', 'accent', 'hover text']);
  assert.deepEqual(pick('f', 'label', 'icon', 'shape', 'group', 'tone', 'description'), ['Foxtrot', 'lucide:server', 'person', 'g1', 'muted', 'all of them']);
  assert.equal(result.input.edges[0].label, 'sends data');
  const text = asScene('a Array [0..9]\nb Beta [draft]\na -> b [x] now');
  assert.deepEqual([nodeOf(text, 'a').label, nodeOf(text, 'b').label, text.input.edges[0].label], ['Array [0..9]', 'Beta [draft]', '[x] now']);
});

test('a node with no label takes its id as its label; group flow takes its id; dir right|down takes the first', () => {
  const result = asScene('dir right|down\ngroup flow\npaid (circle)\nshipped !accent in flow\npaid -> shipped');
  assert.deepEqual(result.problems, []);
  assert.equal(result.input.direction, 'right');
  assert.equal(result.input.groups[0].label, 'flow');
  assert.deepEqual([nodeOf(result, 'paid').label, nodeOf(result, 'paid').shape], ['paid', 'circle']);
  assert.deepEqual([nodeOf(result, 'shipped').label, nodeOf(result, 'shipped').tone, nodeOf(result, 'shipped').group], ['shipped', 'accent', 'flow']);
  assert.equal(asScene('dir down|right\na Alpha\nb Beta\na -> b').input.direction, 'down');
  // Mermaid's direction words are read, with no report; a direction Sketchy does not have is removed.
  for (const [word, direction] of [['LR', 'right'], ['TD', 'down'], ['tb', 'down']]) {
    const mermaid = asScene(`dir ${word}\na Alpha\nb Beta\na -> b`);
    assert.equal(mermaid.input.direction, direction, word);
    assert.deepEqual(mermaid.problems, [], word);
  }
  assert.deepEqual(asScene('dir RL\na Alpha\nb Beta\nc Gamma\nd Delta\na -> b').problems.map((p) => p.code), ['removed_line']);
});

test('Mermaid node shapes become plain nodes, with no report', () => {
  const result = asScene('start[Bug report]\nok{Is it critical?}\nfix(Patch it)\nend2[[Done]]\nstart -> ok\nok -> fix yes\nfix -> end2');
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.input.nodes.map((n) => n.label), ['Bug report', 'Is it critical?', 'Patch it', 'Done']);
});

test('a line the parser refuses and no rule repairs is removed and reported', () => {
  const result = asScene(join([...chain(10), '- a bullet', 'step Missing bar', 'n2 -> n3: with a colon']));
  assert.deepEqual(result.problems.map((p) => [p.code, p.line]), [['removed_line', 20], ['removed_line', 21], ['removed_line', 22]]);
  assert.deepEqual([result.input.nodes.length, result.input.steps.length, result.input.edges.length], [10, 0, 9]);
});

test('lb Balancer @nginx: an unknown icon is removed with no report, the node stays', () => {
  const result = asScene('lb Balancer @nginx\nweb Web @globe\nlb -> web');
  assert.deepEqual(result.problems, []);
  assert.deepEqual([nodeOf(result, 'lb').icon, nodeOf(result, 'lb').label, nodeOf(result, 'web').icon], [undefined, 'Balancer', 'lucide:globe']);
});

test('login Log in page: `in X` with no group X goes back into the label', () => {
  const result = asScene('login Log in page\nhome Home\nlogin -> home');
  assert.deepEqual(result.problems, []);
  assert.deepEqual([nodeOf(result, 'login').label, nodeOf(result, 'login').group], ['Log in page', undefined]);
  // Words after the pair come back in their place, and the rest of the line is kept.
  const middle = asScene('check Check in lobby now @eye\nlobby Lobby\ncheck -> lobby');
  assert.deepEqual([nodeOf(middle, 'check').label, nodeOf(middle, 'check').icon], ['Check in lobby now', 'lucide:eye']);
  // With the group declared (even later) the pair is a group, as upstream reads it.
  const grouped = asScene('login Log in page\ngroup page Pages\nhome Home in page\nlogin -> home');
  assert.deepEqual([nodeOf(grouped, 'login').label, nodeOf(grouped, 'login').group], ['Log', 'page']);
});

test('a group whose parent is no group loses the `in` to its label; a parent that comes later is reordered; a loop is broken', () => {
  const missing = asScene('group a Alpha in nowhere\nn1 One in a\nn2 Two\nn1 -> n2');
  assert.deepEqual([missing.input.groups[0].label, missing.input.groups[0].parent], ['Alpha in nowhere', undefined]);
  const later = asScene('group inner Inner in outer\ngroup outer Outer\nn1 One in inner\nn2 Two\nn1 -> n2');
  assert.deepEqual(later.input.groups.map((g) => [g.id, g.parent]), [['outer', undefined], ['inner', 'outer']]);
  const loop = asScene('group a A in b\ngroup b B in a\nn1 One in a\nn2 Two in b\nn1 -> n2');
  assert.deepEqual([loop.input.groups.length, loop.input.groups.filter((g) => g.parent).length], [2, 1]);
});

test('an arrow naming a missing id is dropped and reported', () => {
  const result = asScene(join([...chain(10), 'n3 -> ghost', 'phantom -> n4 hello']));
  assert.deepEqual(brief(result), [['missing_id', 20, 'ghost', undefined], ['missing_id', 21, 'phantom', undefined]]);
  assert.equal(result.problems[0].text, 'n3 -> ghost');
  assert.deepEqual([result.input.edges.length, result.counts.dropped], [9, 2]);
});

test('a label naming a missing id, or an id that is not a node, is dropped; an anchor on a node is removed', async () => {
  const result = asScene(join([...chain(10), 'label ghost Hello', 'group g Group', 'label g Caption', 'label n1 Fine', 'label n2.region Anchored']));
  assert.deepEqual(result.problems.map((p) => [p.code, p.id]), [['missing_id', 'ghost'], ['missing_id', 'g']]);
  assert.deepEqual(result.input.labels.map((l) => [l.target, l.anchor]), [['n1', undefined], ['n2', undefined]]);
  await core.buildScene(result.input);
});

test('a step naming a missing id is reported and keeps its other ids; an assignment no figure owns is dropped', () => {
  const result = asScene(join([...chain(10), 'step Look: text | n1 ghost n2 n1->n2 ghost2 n9->n1 k=2']));
  assert.deepEqual(result.input.steps[0].highlight, ['n1', 'n2', 'n1->n2']);
  assert.equal(result.input.steps[0].set, undefined);
  assert.deepEqual(result.problems.map((p) => p.id), ['ghost', 'ghost2', 'n9->n1', 'k']);
  assert.equal(result.counts.dropped, 0);
});

test('a duplicate id keeps the first and reports the second', () => {
  const result = asScene(join([...chain(10), 'n2 Imposter', 'group n3 Also taken']));
  assert.deepEqual(brief(result), [['duplicate_id', 20, 'n2', undefined], ['duplicate_id', 21, 'n3', undefined]]);
  assert.deepEqual([nodeOf(result, 'n2').label, result.input.groups.length], ['Node 2', 0]);
});

test('an id the builder would refuse, and an arrow line the parser read as a node, are removed and reported', () => {
  const result = asScene(join([...chain(10), '9lives Nine lives', '-dash Dashed', `${'x'.repeat(70)} Long id`, 'n1 -> café']));
  assert.deepEqual(codes(result), ['removed_line', 'removed_line', 'removed_line', 'removed_line']);
  assert.equal(result.input.nodes.length, 10, 'n1 is not declared a second time by the broken arrow');
});

test('an id one step from exactly one declared id is re-pointed and reported', () => {
  const lines = ['cloud Cloud', 'server Server', 'db DB', 'cloud -> clouds', 'Server -> cloud', 'servr -> cloud', 'server -> serverr', 'cloud -> serber'];
  const result = asScene(join(lines));
  assert.deepEqual(brief(result), [
    ['repointed_id', 4, 'clouds', 'cloud'], ['repointed_id', 5, 'Server', 'server'], ['repointed_id', 6, 'servr', 'server'],
    ['repointed_id', 7, 'serverr', 'server'], ['repointed_id', 8, 'serber', 'server'],
  ]);
  assert.deepEqual(result.input.edges.map((e) => [e.from, e.to]), [['cloud', 'cloud'], ['server', 'cloud'], ['server', 'cloud'], ['server', 'server'], ['cloud', 'server']]);
});

test('a near match is not made when it is ambiguous, too short, or not near', () => {
  const lines = [...chain(10), 'cat Cat', 'car Car', 'ab1x A', 'ab2x B', 'n1 -> cab', 'n2 -> ab3x', 'n3 -> dog', 'n4 -> Nodes'];
  assert.deepEqual(asScene(join(lines)).problems.map((p) => [p.code, p.id]), [['missing_id', 'cab'], ['missing_id', 'ab3x'], ['missing_id', 'dog'], ['missing_id', 'Nodes']]);
});

test('re-pointing also covers labels and step ids, and is not reported for an arrow that is dropped anyway', () => {
  const result = asScene(join([...chain(10), 'label N1 Hello', 'step S: t | N2 N3', 'N4 -> nowhere']));
  assert.equal(result.input.labels[0].target, 'n1');
  assert.deepEqual(result.input.steps[0].highlight, ['n2', 'n3']);
  assert.deepEqual(result.problems.map((p) => [p.code, p.id, p.to]), [
    ['repointed_id', 'N1', 'n1'], ['repointed_id', 'N2', 'n2'], ['repointed_id', 'N3', 'n3'], ['missing_id', 'nowhere', undefined],
  ]);
});

test('lines under a figure header that failed are dropped with it', () => {
  const result = asScene(join([...chain(10), '', 'map m Atlantis', 'country France blue', 'place Paris 48.8 2.3', '', 'tail Still here', 'n1 -> tail']));
  assert.deepEqual(brief(result).map((p) => p.slice(0, 2)), [['figure_dropped', 21]]);
  assert.equal(result.problems[0].text, 'map m Atlantis');
  assert.deepEqual([result.input.figures.length, nodeOf(result, 'tail').label, result.counts.dropped], [0, 'Still here', 3]);
  assert.equal(result.input.nodes.some((n) => n.id === 'country' || n.id === 'place'), false);
  const draw = asScene(join([...chain(10), 'draw d 0x0', 'circle 50,50 20', 'rect 10,10 20 20', '', 'last Last', 'n1 -> last']));
  assert.deepEqual([codes(draw), draw.counts.dropped], [['figure_dropped'], 3]);
  // A molecule has no body: the line after it is not its line. A bad line in the middle of a good body is only that line.
  const molecule = asScene(join([...chain(10), 'molecule m Zz9!!', 'after Next', 'n1 -> after']));
  assert.deepEqual([brief(molecule).map((p) => p.slice(0, 2)), molecule.counts.dropped, nodeOf(molecule, 'after').label], [[['figure_dropped', 20]], 1, 'Next']);
  const middle = asScene(join([...chain(10), 'draw d 100x100', 'circle 50,50 20', 'rect nonsense', 'circle 20,20 5']));
  assert.deepEqual([brief(middle).map((p) => p.slice(0, 2)), middle.input.figures[0].spec.shapes.length], [[['removed_line', 22]], 2]);
});

test('a figure the builder would refuse is dropped; a good one is kept, counts its parts, and steps may name its parts', async () => {
  const bad = asScene(join([...chain(10), 'chart c bar: Sales', '', 'plot p: Empty']));
  assert.deepEqual(brief(bad).map((p) => p.slice(0, 2)), [['figure_dropped', 20], ['figure_dropped', 22]]);
  await core.buildScene(bad.input);
  const good = asScene(join([...chain(4), 'array a = 5 2 8 1', 'ptr i 0', '', 'step Look: text | a[2] i a', 'step Move: text | i=2']));
  assert.deepEqual([good.problems, good.input.figures.length, good.counts.nodes], [[], 1, 4 + 1 + 4]);
  await core.buildScene(good.input);
});

test('a node whose label reads as prose is flagged: more than eight words, or ends with a colon or a full stop', () => {
  const result = asScene(join([...chain(14), 'p1 This label has far too many words to be a name', 'p2 Steps:', 'p3 It ends here.', 'ok1 Exactly eight words are fine in a label']));
  assert.deepEqual(brief(result).map((p) => p.slice(0, 3)), [['prose_node', 28, 'p1'], ['prose_node', 29, 'p2'], ['prose_node', 30, 'p3']]);
  assert.equal(result.problems[0].text, 'This label has far too many words to be a name');
  assert.deepEqual([result.counts.flagged, result.counts.dropped, Boolean(nodeOf(result, 'p1'))], [3, 0, true], 'a flagged node is kept');
  // A prose line is a node whose id is its first word, and it is flagged rather than drawn as a silent box.
  const prose = asScene(join([...chain(10), 'Here is how the whole system works in practice.']));
  assert.deepEqual(brief(prose).map((p) => p.slice(0, 3)), [['prose_node', 20, 'Here']]);
});

test('a messy model reply (the mistakes the probe saw) draws, with each repair reported once', async () => {
  const result = asScene(MESSY);
  assert.deepEqual(brief(result), [
    ['prose_node', 13, 'Here', undefined], ['removed_line', 14, undefined, undefined], ['repointed_id', 17, 'Orders', 'orders'],
    ['missing_id', 18, 'dbb', undefined], ['missing_id', 19, 'cache', undefined], ['repointed_id', 20, 'users', 'user'],
    ['missing_id', 22, 'orders->db', undefined],
  ]);
  assert.deepEqual(result.counts, { elements: 20, dropped: 3, flagged: 1, nodes: 11 });
  assert.deepEqual([result.input.direction, nodeOf(result, 'web').group, nodeOf(result, 'api').icon, result.input.groups[1].label], ['right', 'edge', undefined, 'edge']);
  assert.deepEqual(['paid', 'start', 'check'].map((id) => nodeOf(result, id).label), ['paid', 'Order placed', 'Stock available?']);
  assert.deepEqual(result.input.steps[0].highlight, ['user', 'web', 'user->web']);
  assert.equal((await core.layout(await core.buildScene(result.input))).nodes.length, 9);
});

test('more than a quarter of the elements dropped or flagged: refused with the problems; exactly a quarter is allowed', () => {
  // Three nodes and two arrows (5 elements) plus two removed lines: 2 of 7 is 28.6%.
  const refused = prepare('a Alpha\nb Beta\nc Gamma\na -> b\nb -> c\npart x resistor\npart y resistor');
  assert.deepEqual([refused.kind, refused.reason], ['refused', 'too_many_problems']);
  assert.deepEqual(refused.problems.map((p) => [p.code, p.line]), [['removed_line', 6], ['removed_line', 7]]);
  assert.deepEqual(asScene('a Alpha\nb Beta\na -> b\npart x resistor').counts, { elements: 4, dropped: 1, flagged: 0, nodes: 2 });
  // Flagged nodes count with dropped ones.
  const mixed = prepare('a Alpha\nb Beta\na -> b\nc Steps:\nd Done.\na -> ghost');
  assert.deepEqual([mixed.reason, mixed.problems.map((p) => p.code)], ['too_many_problems', ['prose_node', 'prose_node', 'missing_id']]);
  assert.equal(prepare('part a resistor\nwire a.b -> c.d').reason, 'too_many_problems');
  assert.equal(prepare('title Only a title').reason, 'empty', 'nothing to draw');
  assert.equal(prepare('# a comment\n\n').reason, 'empty');
});

test('the refusal reasons: empty, too_long, too_many_lines, too_many_nodes', () => {
  for (const empty of ['', '   ', '\n\n\n', '\r\n\r\n', '\t \n \t']) assert.deepEqual(prepare(empty), { kind: 'refused', reason: 'empty', problems: [] }, JSON.stringify(empty));
  assert.deepEqual(prepare(`a ${'x'.repeat(16384)}`), { kind: 'refused', reason: 'too_long', problems: [] });
  assert.notEqual(prepare(`a ${'x'.repeat(16382)}`).reason, 'too_long', '16384 characters exactly is allowed');
  const lines = (n) => Array.from({ length: n }, () => 'a A');
  assert.notEqual(prepare(join(lines(400))).reason, 'too_many_lines', '400 lines are allowed');
  assert.deepEqual(prepare(join(lines(401))), { kind: 'refused', reason: 'too_many_lines', problems: [] });
  assert.notEqual(prepare(`${join(lines(400))}\n\n\n`).reason, 'too_many_lines', 'trailing blank lines do not count');
  assert.equal(prepare(lines(401).join('\r\n')).reason, 'too_many_lines');
  assert.equal(prepare(lines(401).join('\r')).reason, 'too_many_lines');
  const nodes = (n) => Array.from({ length: n }, (_, i) => `n${i} N${i}`);
  assert.equal(asScene(join(nodes(120))).counts.nodes, 120);
  const over = prepare(join(nodes(121)));
  assert.deepEqual([over.kind, over.reason, Array.isArray(over.problems)], ['refused', 'too_many_nodes', true]);
  // Groups and the parts of a figure count too.
  assert.equal(prepare(join([...nodes(100), ...Array.from({ length: 21 }, (_, i) => `group g${i} G${i}`)])).reason, 'too_many_nodes');
  assert.equal(prepare(join([...nodes(90), `array big = ${Array.from({ length: 30 }, (_, i) => i).join(' ')}`])).reason, 'too_many_nodes');
});

test('prepare never throws, whatever it is given', () => {
  const hostile = { toString() { throw new Error('boom'); } };
  for (const value of [undefined, null, 42, {}, [], Symbol('s'), () => 1, NaN]) assert.ok(['mermaid', 'refused', 'scene'].includes(prepare(value).kind), String(typeof value));
  const refused = prepare(hostile);
  assert.deepEqual([refused.kind, refused.reason, typeof refused.message], ['refused', 'error', 'string']);
});

test('a 5 MB string is refused at once; newlines and whitespace alone are empty or too long, never a crash', () => {
  const huge = 'a Alpha\n'.repeat(700_000);
  const started = performance.now();
  assert.deepEqual(prepare(huge), { kind: 'refused', reason: 'too_long', problems: [] });
  assert.ok(performance.now() - started < 1000, 'refused in well under a second');
  assert.equal(prepare('\n'.repeat(16384)).reason, 'empty');
  assert.equal(prepare('\n'.repeat(20000)).reason, 'too_long');
  assert.equal(prepare(' \n'.repeat(5000)).reason, 'empty');
});

test('__proto__, constructor and other Object.prototype names are plain ids, never properties', async () => {
  const result = asScene(join([...chain(10), '__proto__ Proto', 'constructor Builder', 'toString Text', 'hasOwnProperty Has', 'valueOf Value',
    'n1 -> constructor', 'constructor -> toString', 'n2 -> __proto__', 'label constructor About', 'step S: t | constructor toString constructor->toString __proto__ constructor=1',
    'group prototype Group', 'x1 Member in prototype']));
  assert.equal(Object.getPrototypeOf(result.input.nodes[0]), Object.prototype);
  assert.deepEqual([Boolean(nodeOf(result, 'constructor')), nodeOf(result, '__proto__')], [true, undefined], 'an id the builder refuses is removed');
  assert.deepEqual(result.input.steps[0].highlight, ['constructor', 'toString', 'constructor->toString']);
  assert.equal(Object.keys(result.input.steps[0].set ?? {}).length, 0);
  assert.deepEqual([({}).polluted, ({}).constructor === Object], [undefined, true]);
  await core.buildScene(result.input);
});

test('a label with </script> and markup is data: it is kept verbatim for the frame to draw as text', async () => {
  const label = '</script><img src=x onerror=alert(1)> & "quotes"';
  const result = asScene(`a ${label}\nb Beta ~ <b>hover</b></script>\na -> b ${label}`);
  assert.deepEqual([nodeOf(result, 'a').label, nodeOf(result, 'b').description, result.input.edges[0].label], [label, '<b>hover</b></script>', label]);
  assert.equal(plain(result).input.nodes[0].label, label);
  await core.buildScene(result.input);
});

test('a step naming a run of parts wider than 200 is removed at once; a run of 200 is a statement', () => {
  const started = performance.now();
  const wide = asScene(join([...chain(10), 'step Go: x | n1 a[1..99999999]', 'step Far: x | a[-5..99999999999999999999] n2', 'step Back: x | a[5000..1]']));
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
  assert.deepEqual(brief(wide).map((p) => [p[0], p[1]]), [['removed_line', 20], ['removed_line', 21], ['removed_line', 22]]);
  assert.equal((wide.input.steps || []).length, 0);
  const narrow = asScene(join([...chain(10), 'step Go: x | n1 a[0..200] a[3..1]']));
  assert.equal(codes(narrow).includes('removed_line'), false);
  assert.deepEqual(narrow.input.steps[0].highlight, ['n1']);
});

test('long lines of nested brackets and repeated arrows finish quickly', () => {
  const started = performance.now();
  for (const sample of [`a ${'['.repeat(1900)}`, `a -> b ${'[x '.repeat(600)}`, `${'a -> '.repeat(380)}b`, `step ${'-> '.repeat(600)} | ${'<-> '.repeat(300)}`,
    `${'(('.repeat(900)}`, `x ${'~ '.repeat(900)}`, `${'a'.repeat(1900)} ${'-'.repeat(50)}`, `n${'{'.repeat(1900)}`]) {
    assert.ok(['scene', 'refused'].includes(prepare(`a Alpha\nb Beta\n${sample}`).kind));
  }
  assert.ok(performance.now() - started < 2000, `took ${performance.now() - started} ms`);
});

test('property: for 300 seeded messy sources prepare never throws and a scene always builds', async () => {
  const outcomes = { scene: 0, refused: 0, mermaid: 0 };
  let laidOut = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const source = generateSource(seeded(seed));
    let result;
    try {
      result = prepare(source);
    } catch (error) {
      assert.fail(`seed ${seed}: prepare threw ${error && error.stack}\n${source}`);
    }
    outcomes[result.kind] += 1;
    if (result.kind === 'refused') assert.notEqual(result.reason, 'error', `seed ${seed}: ${result.message}\n${source}`);
    if (result.kind !== 'scene') continue;
    assert.ok(result.counts.nodes <= 120 && (result.counts.dropped + result.counts.flagged) * 4 <= result.counts.elements, `seed ${seed}: bounds held`);
    assert.deepEqual(plain(result.input), result.input, `seed ${seed}: plain data`);
    for (const p of result.problems) assert.ok((p.line === null || p.line >= 1) && (p.text === undefined || p.text.length <= 200), `seed ${seed}`);
    let scene;
    try {
      scene = await core.buildScene(result.input);
    } catch (error) {
      assert.fail(`seed ${seed}: buildScene threw ${error && error.message}\n${source}\n${JSON.stringify(result.input)}`);
    }
    if (laidOut < 6 && scene.nodes.length > 1) {
      await core.layout(scene);
      laidOut += 1;
    }
  }
  // The generator must exercise every outcome or it proves nothing.
  assert.ok(outcomes.scene >= 120 && outcomes.refused >= 20 && outcomes.mermaid >= 1, JSON.stringify(outcomes));
});

test('render never rejects for a model mistake: it draws, hands Mermaid back, or refuses with the problems', async (t) => {
  const { api, root, dom } = loadFrame(t, frameBundlePath);
  const drawn = await api.render(root, MESSY);
  assert.deepEqual([drawn.kind, drawn.problems.length, drawn.laidOut.nodes.length, root.querySelectorAll('svg').length], ['drawn', 7, 9, 1]);
  assert.deepEqual({ ...drawn.counts }, { elements: 20, dropped: 3, flagged: 1, nodes: 11 });
  assert.equal(typeof api.previousLayout(drawn.laidOut), 'object');
  const clean = await api.render(root, 'title T\na Alpha @database\nb Beta\na -> b call', {});
  assert.deepEqual([clean.kind, clean.problems.length, clean.laidOut.nodes.length], ['drawn', 0, 2]);
  assert.deepEqual({ ...(await api.render(root, 'graph TD\nA-->B')) }, { kind: 'mermaid', source: 'graph TD\nA-->B' });

  const before = root.innerHTML;
  const refused = await api.render(root, 'a Alpha\na -> missing');
  assert.deepEqual([refused.kind, refused.reason, plain(refused.problems.map((p) => [p.code, p.id]))], ['refused', 'too_many_problems', [['missing_id', 'missing']]]);
  assert.equal(root.innerHTML, before, 'a refused source leaves the container as it was');
  for (const [source, reason] of [['', 'empty'], ['x'.repeat(16385), 'too_long'], ['a A\n'.repeat(401), 'too_many_lines']]) {
    const result = await api.render(root, source);
    assert.deepEqual([result.kind, result.reason], ['refused', reason]);
  }
  // Something the layer does not cover reaches the builder, which throws; render reports it instead of rejecting.
  const slider = await api.render(root, 'plot p: T\nslider k 1..5 = 2\nfn k*x\n\nstep S: t | k=9\na Alpha\nb Beta\na -> b');
  assert.deepEqual([slider.kind, slider.reason, Array.isArray(slider.problems)], ['refused', 'error', true]);
  assert.match(slider.message, /slider/);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 20));
});

test('the 120-node fixture is prepared quickly and lays out', async () => {
  const lines = [];
  for (let g = 0; g < 6; g++) lines.push(`group g${g} Group ${g}`);
  for (let i = 0; i < 114; i++) lines.push(`n${i} Node ${i} ${i % 3 === 0 ? `in g${i % 6}` : ''} ${i % 5 === 0 ? '@database' : ''}`.trim());
  for (let i = 1; i < 114; i += 2) lines.push(`n${i - 1} -> n${i} step`);
  lines.push('n3 -> ghost', 'step A: text | n0 n1 n0->n1');
  const source = join(lines);
  assert.ok(source.length < 16384 && lines.length < 400, `${source.length} characters, ${lines.length} lines`);
  const started = performance.now();
  const result = prepare(source);
  const elapsed = performance.now() - started;
  assert.deepEqual([result.kind, result.counts.nodes, codes(result)], ['scene', 120, ['missing_id']]);
  assert.ok(elapsed < 1500, `prepare took ${elapsed} ms`);
  console.log(`# prepare of the 120-node fixture (${lines.length} lines, ${result.counts.elements} elements): ${elapsed.toFixed(1)} ms`);
  await core.layout(await core.buildScene(result.input));
});
