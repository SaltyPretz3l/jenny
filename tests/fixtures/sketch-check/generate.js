'use strict';

// Seeded generator of messy sketch sources for the property test in tests/sketch-check.test.js: valid lines mixed
// with the mistakes small models make (and some plain noise), so a failure names its seed and can be replayed.

// mulberry32
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['web', 'api', 'db', 'cache', 'user', 'queue', 'Server', 'cloud', 'clouds', 'login', 'page', 'in', 'flow', 'step', 'end', 'group', 'label', 'dir', 'part', 'wire', 'image'];
const NOISE = ['[', ']', '(', ')', '{', '}', '->', '-->', '<->', '|', '~', '@', '!accent', ':', '.', '#', '"', "'", '=', ',', '</script>', '__proto__', 'constructor', '@nginx', '@globe', '(cylinder)', '(circle)', 'in g1', '!muted'];

function generateSource(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const ids = [];
  const newId = () => {
    const id = `${pick(['n', 'svc', 'box', 'Item', 'a'])}${ids.length}`;
    ids.push(id);
    return id;
  };
  const someId = () => (ids.length ? pick(ids) : 'a0');
  const mistakeId = () => (ids.length && random() < 0.5 ? pick(ids).toUpperCase() : pick(['ghost', 'clouds', 'servr', 'n99', '__proto__', 'constructor', 'x y']));

  const valid = [
    () => `${newId()} ${pick(['Alpha', 'Beta gamma', 'Queue', 'Disk', 'Client'])}`,
    () => `${newId()} ${pick(['Alpha', 'Gamma'])} @${pick(['database', 'server', 'globe'])}`,
    () => `${newId()} ${pick(['Alpha', 'Delta'])} (${pick(['cylinder', 'circle', 'person', 'note'])})`,
    () => `${someId()} ${pick(['->', '-->', '<->'])} ${someId()} ${pick(['', 'sends', 'reads'])}`,
    () => `${someId()} ${pick(['->', '->'])} ${someId()}`,
    () => `label ${someId()} ${pick(['Caption', 'More text here'])}`,
    () => `step ${pick(['Go', 'Look'])}: ${pick(['text', 'it runs'])} | ${someId()} ${someId()}`,
    () => pick(['group g1 Group', 'title A title', '', '']),
  ];
  const mistakes = [
    () => `${newId()} ${pick(['Log in page', 'Check in lobby now'])}`,
    () => `${newId()} ${pick(['Alpha', 'Gamma'])} @${pick(['nginx', 'no-such-icon', 'simple-icons:react'])}`,
    () => `${newId()} ${pick(['Alpha', 'Delta'])} (${pick(['hexagon', 'box'])}) ${pick(['!accent', 'in g1', 'in nowhere', '~ hover text'])}`,
    () => `${newId()} (${pick(['circle', 'cylinder'])})`,
    () => `${pick(['start', 'ok', 'fix'])}${pick(['[Bug report]', '{Is it critical?}', '((Round))', '[(Database)]'])}`,
    () => `${mistakeId()} ${pick(['->', '-->', '<->'])} ${someId()} ${pick(['', 'sends', '[label]', '~ note', '!accent'])}`,
    () => `${someId()} -> ${mistakeId()}`,
    () => `group ${pick(['g1', 'g2', 'flow', 'g1'])} ${pick(['', 'Group in g2', 'Group in g2'])}`.trim(),
    () => `label ${mistakeId()}${pick(['', '.region'])} ${pick(['Caption', 'More text here'])}`,
    () => `step ${pick(['Go', 'Look'])}: ${pick(['text', 'a -> b'])} | ${[mistakeId(), someId(), `${someId()}${pick([' -> ', '->', '-->'])}${someId()}`, pick(['', 'k=2', 'a[2]', 'i=1'])].join(' ')}`,
    () => `step ${pick(['No bar', 'Also none: here'])}`,
    () => `part ${newId()} resistor value=10k`,
    () => `wire ${someId()}.a -> ${someId()}.b ${pick(['', 'red'])}`,
    () => `image ${pick(['photo1', 'p2'])}`,
    () => pick(['dir right|down', 'dir sideways', 'end', '# a comment']),
    () => pick(['Here is how the whole system works in practice.', 'First, the user logs in:', '- a bullet point', '1. numbered item', '**bold** text', 'Note: this is prose', '> quote']),
    () => pick(['map m Atlantis', 'country France', 'draw d 0x0', 'circle 50,50 20', 'molecule m Zz9!!', 'chart c bar: Sales', 'plot p: Empty', 'array a = 1 2 3', 'ptr i 0', 'tree t = a(b,c)',
      'timeline t: Plan', '2024: Start', 'seq s: Calls', 'cycle c: Loop', 'Step one', 'plot p: T', 'fn y = x^2']),
    () => Array.from({ length: 1 + Math.floor(random() * 8) }, () => pick(random() < 0.5 ? NOISE : WORDS)).join(pick([' ', '', ' ', '  '])),
    () => `${newId()} ${'long '.repeat(Math.floor(random() * 700))}`,
  ];

  // Each source has its own mess level, so some are nearly clean and some are hopeless.
  const mess = random() * 0.5;
  const lines = [];
  const lineCount = 3 + Math.floor(random() * 35);
  for (let i = 0; i < lineCount; i++) lines.push(pick(random() < mess ? mistakes : valid)());
  if (random() < 0.03) lines.unshift(pick(['graph TD', 'sequenceDiagram', 'flowchart LR']));
  return lines.join(pick(['\n', '\n', '\r\n']));
}

module.exports = { seeded, generateSource };
