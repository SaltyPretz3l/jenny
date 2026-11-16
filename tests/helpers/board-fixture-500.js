'use strict';

// A full project board for the performance tests (row 150 hardening, P5-A): 500 cards, 20 groups and 600
// connectors by default, built through the real model (createBoard and applyBatch with authority), so the
// result is a normalized document and every alias, z and revision is what the app would have written.
//
// Deterministic: one small seeded generator (mulberry32) and no clock. The cards sit in a 12,000 by 9,000
// area; four fifths of them inside the groups (a 5 by 4 grid of boxes), the rest loose between them.
// Kinds: 60% notes (every tenth one 4,000 characters long), then links, file cards and chat cards, 5 image
// cards (a picture name only) and 10 diagram cards with a 30-line scene.
//
//   buildBoard({ cards, groups, connectors, seed }) -> a normalized board (throws if the model refuses one).
//   seedBatches(options)                            -> the same document as add operations in batches of
//                                                      at most 190 (the model allows 200 additions each), for a
//                                                      test that seeds a board through a service.

const model = require('../../services/boards/board-model');

const PROJECT_ID = 'project_general';
const BOARD_ID = 'board_00000000-0000-4000-8000-00000000b0a5';
const NOW = '2026-11-14T10:00:00.000Z';
const AREA = Object.freeze({ w: 12000, h: 9000 });
const CHUNK = 190;
const SIZES = Object.freeze({
  note: [240, 160], link: [260, 72], file: [260, 72], chat: [280, 140], image: [320, 240], diagram: [360, 260],
});
const NOTE_CHARS = 4000;
const WORDS = ['board', 'card', 'ship', 'risk', 'token', 'plan', 'review', 'engine', 'model', 'search', 'queue', 'layout', 'canvas', 'group', 'tidy'];

const uid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const groupId = (i) => uid('00000001', i);
const cardId = (i) => uid('00000002', i);
const connectorId = (i) => uid('00000003', i);

function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function words(random, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(WORDS[Math.floor(random() * WORDS.length)]);
  return out.join(' ');
}

function longNote(random) {
  const lines = [];
  let length = 0;
  while (length < NOTE_CHARS) {
    const line = words(random, 8);
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n').slice(0, NOTE_CHARS);
}

/** A 30-line sketch scene: a title, a direction, 14 steps and 14 arrows between them. */
function scene(n) {
  const lines = [`title Flow ${n}`, 'dir right'];
  for (let i = 1; i <= 14; i += 1) lines.push(`Step ${i}`);
  for (let i = 1; i < 15; i += 1) lines.push(`Step ${i} -> Step ${i + 1}`);
  return lines.join('\n');
}

/** The kind of every card, in a seeded order: 60% notes, 10 diagrams, 5 pictures, the rest links, files and chats. */
function kindList(count, random) {
  const notes = Math.round(count * 0.6);
  const diagrams = Math.min(10, count);
  const images = Math.min(5, Math.max(0, count - notes - diagrams));
  const rest = Math.max(0, count - notes - diagrams - images);
  const kinds = [];
  const push = (kind, n) => { for (let i = 0; i < n; i += 1) kinds.push(kind); };
  push('note', Math.min(notes, count));
  push('diagram', Math.min(diagrams, count - kinds.length));
  push('image', Math.min(images, count - kinds.length));
  const third = Math.floor(rest / 3);
  push('link', third);
  push('file', third);
  push('chat', count - kinds.length);
  for (let i = kinds.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  return kinds;
}

function dataFor(kind, n, random, noteIndex) {
  switch (kind) {
    case 'note':
      return { text: noteIndex % 10 === 0 ? longNote(random) : `${words(random, 6)}\n${words(random, 4)} ${n}`, tone: ['amber', 'blue', 'green', 'red', null][n % 5] };
    case 'link': return { url: `https://example.com/page/${n}`, title: `Page ${n} ${words(random, 2)}` };
    case 'file': return { path: `src/area${n % 17}/module-${n}.js`, title: `module-${n}.js` };
    case 'chat': return { session_id: `session_${n}`, message_id: null, title: `Chat ${n} ${words(random, 2)}`, excerpt: words(random, 12) };
    case 'image': return { asset: n.toString(16).padStart(64, 'a'), width: 800, height: 600, alt: `Picture ${n}` };
    default: return { scene: scene(n), title: `Diagram ${n}` };
  }
}

/** Where the groups go: a grid over the area, each box a little smaller than its cell. */
function groupBoxes(count) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * (AREA.w / AREA.h))));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = Math.floor(AREA.w / cols);
  const cellH = Math.floor(AREA.h / rows);
  const boxes = [];
  for (let i = 0; i < count; i += 1) {
    boxes.push({ x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH, w: cellW - 100, h: cellH - 100 });
  }
  return boxes;
}

function operations({ cards = 500, groups = 20, connectors = 600, seed = 1 } = {}) {
  const random = seededRandom(seed);
  const boxes = groupBoxes(groups);
  const ops = [];
  boxes.forEach((box, i) => {
    ops.push({ op: 'group.add', group: { id: groupId(i + 1), title: `Group ${i + 1}`, x: box.x, y: box.y, w: box.w, h: box.h } });
  });
  const kinds = kindList(cards, random);
  const grouped = groups > 0 ? Math.floor(cards * 0.8) : 0;
  const perGroup = groups > 0 ? Math.max(1, Math.ceil(grouped / groups)) : 1;
  let noteIndex = 0;
  const filled = new Array(groups).fill(0);
  kinds.forEach((kind, i) => {
    const n = i + 1;
    const [w, h] = SIZES[kind];
    const card = { id: cardId(n), kind, w, h, data: dataFor(kind, n, random, kind === 'note' ? (noteIndex += 1) : 1) };
    const g = Math.floor(i / perGroup);
    if (i < grouped && g < groups) {
      const box = boxes[g];
      const slot = filled[g]++;
      const cols = Math.max(1, Math.floor((box.w - 32) / 380));
      card.group_id = groupId(g + 1);
      card.x = box.x + 16 + (slot % cols) * 380;
      card.y = box.y + 40 + Math.floor(slot / cols) * 300;
    } else {
      card.x = Math.floor(random() * (AREA.w - w));
      card.y = Math.floor(random() * (AREA.h - h));
    }
    ops.push({ op: 'card.add', card });
  });
  const seen = new Set();
  for (let made = 0, tries = 0; made < connectors && cards > 1 && tries < connectors * 20; tries += 1) {
    const a = 1 + Math.floor(random() * cards);
    const b = 1 + Math.floor(random() * cards);
    const key = `${a}:${b}`;
    if (a === b || seen.has(key)) continue;
    seen.add(key);
    made += 1;
    ops.push({ op: 'connector.add', connector: { id: connectorId(made), from: cardId(a), to: cardId(b), label: made % 6 === 0 ? `link ${made}` : '', style: made % 5 === 0 ? 'dashed' : 'solid', ends: 'end' } });
  }
  return ops;
}

/** The fixture as add operations in batches of at most CHUNK: [[op, ...], ...]. */
function seedBatches(options) {
  const ops = operations(options);
  const out = [];
  for (let i = 0; i < ops.length; i += CHUNK) out.push(ops.slice(i, i + CHUNK));
  return out;
}

function buildBoard(options) {
  const made = model.createBoard({ id: BOARD_ID, project_id: PROJECT_ID, name: 'Five hundred', now: NOW });
  if (!made.ok) throw new Error(`fixture: createBoard refused: ${made.reason}`);
  let board = made.board;
  seedBatches(options).forEach((ops, i) => {
    const result = model.applyBatch(board, { batch_id: `fixture-${i}`, board_id: board.id, actor: 'owner', ops }, { now: NOW, authority: true });
    if (!result.ok) throw new Error(`fixture: batch ${i} refused: ${result.reason} ${result.detail || ''} at ${result.op_index}`);
    board = result.board;
  });
  const read = model.normalizeBoard(board);
  if (!read.ok) throw new Error(`fixture: normalizeBoard refused: ${read.reason} ${read.detail || ''}`);
  return read.board;
}

module.exports = { buildBoard, seedBatches, seededRandom, uid, cardId, groupId, connectorId, PROJECT_ID, BOARD_ID, NOW, AREA };
