'use strict';

// new-test-file: a new lane (row 151 hardening, P5-A): the cost of a full 500-card team board on a member's Jenny and on the page.
// Each case prints `perf <name> <ms>` (best of 5 after one warm-up) and asserts a ceiling at ten times what was measured on the
// development machine, rounded up, never under 50 ms: the full suite runs many jsdom files at once on throttled cores, so the
// ceilings catch a quadratic regression and are not a benchmark. The host's side is in tests/server/team-board-perf-500.test.js.
//
// The host is scripted here: it keeps the document and the journal with the real board model (so every applied batch is what a
// host would write) and answers the client's `send` and `readSnapshot`; the client is the real services/team/board-client.js.
// The page's two team paths are the real renderer/features/board/board-team-presence.js over jsdom and the real
// board-source-team.js over a scripted `team` bridge.

const assert = require('node:assert/strict');
const test = require('node:test');
const { performance } = require('node:perf_hooks');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createBoardClient } = require('../services/team/board-client');
const { createTeamPresence } = require('../renderer/features/board/board-team-presence');
const { createTeamBoardSource } = require('../renderer/features/board/board-source-team');
const fixture = require('./helpers/board-fixture-500');

const { buildBoard, cardId, PROJECT_ID, NOW } = fixture;

// Milliseconds: ten times the best measured, rounded up, never under 50.
const CEILING = {
  'client open the 500-card board': 50,
  'client replay 100 pushed one-op batches in order': 300,
  'client replay 1000 pushed one-op batches in order': 2840,
  'client catch-up over 100 batches, the first event lost': 290,
  'client catch-up over 100 batches, events in reverse order': 290,
  'client one local card.place until the host confirmed it': 50,
  'client one local card.place, optimistic answer': 50,
  'page 7 other members pointers, 100 moves each (700 draws)': 130,
  'page a held note label shown and removed 100 times': 55,
  'source list 20 boards': 50,
  'source get the 500-card board': 50,
  'source apply one card.place': 50,
};
const ceilingOf = (name) => {
  assert.ok(Object.hasOwn(CEILING, name), `no ceiling for ${name}`);
  return CEILING[name];
};

async function bestOfAsync(run, prepare) {
  if (prepare) await prepare();
  await run();
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    if (prepare) await prepare();
    const from = performance.now();
    await run();
    best = Math.min(best, performance.now() - from);
  }
  return best;
}
function report(t, name, value) {
  t.diagnostic(`perf ${name} ${value.toFixed(1)}`);
  const ceiling = ceilingOf(name);
  assert.ok(value <= ceiling, `${name} took ${value.toFixed(1)} ms, ceiling ${ceiling} ms`);
}
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

let shared = null;
const base = () => { shared ??= buildBoard(); return shared; };
const SELF = 'member_self';
const OTHER = 'member_ann';

// The host: the document at `head`, the journal `items` ({ rev, batch_id, actor, at, applied }), the wire answers.
function scriptedHost(count = 0) {
  const start = base();
  const host = { head: start, items: [], start, events: [] };
  host.commit = (batch, actor = OTHER) => {
    const done = model.applyBatch(host.head, { batch_id: batch.batch_id, board_id: start.id, actor, ops: batch.ops }, { now: NOW, authority: true });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 200));
    host.head = done.board;
    const item = { rev: done.board.rev, batch_id: batch.batch_id, actor, at: NOW, applied: done.applied };
    host.items.push(item);
    return item;
  };
  for (let i = 0; i < count; i += 1) {
    host.commit({ batch_id: `host-${i}`, ops: [{ op: 'card.place', id: cardId(1 + (i % 500)), x: 40 + i, y: 80 }] });
  }
  host.event = (item) => ({ event_type: 'team_board_changed', project_id: PROJECT_ID, board_id: start.id, rev: item.rev, batch: structuredClone(item) });
  // The snapshot of the board as the host's route sends it: JSON text, read by the member's Jenny. Always the starting document.
  const text = JSON.stringify({ ok: true, board: start, rev: start.rev, read_only: false });
  host.readSnapshot = async () => JSON.parse(text);
  host.send = async (operation, params) => {
    if (operation === 'team.board.sync') {
      const batches = host.items.filter((item) => item.rev > params.after_rev);
      return structuredClone({ ok: true, rev: host.head.rev, batches, more: false });
    }
    assert.equal(operation, 'team.board.apply');
    const item = host.commit(params.batch, SELF);
    host.events.push(item);
    return { ok: true, rev: item.rev, applied: structuredClone(item.applied), duplicate: false };
  };
  return host;
}

// A client on the host, not opened; its pushes are counted. The timers never fire: a retry or a grace wait is not what is timed.
function memberOn(host) {
  const pushes = [];
  const client = createBoardClient({ projectId: PROJECT_ID, boardId: host.start.id, self: () => SELF, send: host.send,
    readSnapshot: host.readSnapshot, push: (payload) => pushes.push(payload), timers: { setTimeout: () => ({}), clearTimeout() {} } });
  return { client, pushes };
}
async function converged(client, rev) {
  for (let tries = 0; tries < 20000; tries += 1) {
    if ((await client.open()).rev === rev) return;
    await tick();
  }
  assert.fail(`the client never reached rev ${rev}`);
}

test('client: opens the 500-card team board from a snapshot', async (t) => {
  const host = scriptedHost();
  let member = null;
  report(t, 'client open the 500-card board', await bestOfAsync(async () => {
    const opened = await member.client.open();
    assert.deepEqual([opened.ok, opened.read_only, opened.rev, Object.keys(opened.board.cards).length], [true, false, host.start.rev, 500]);
    assert.deepEqual(opened.board, host.start);
  }, () => { member = memberOn(host); }));
});

test('client: replays pushed batches in order, and catches up over a lost or reordered event', async (t) => {
  for (const count of [100, 1000]) {
    const host = scriptedHost(count);
    let member = null;
    const fresh = async () => { member = memberOn(host); await member.client.open(); };
    const finish = async () => {
      await converged(member.client, host.head.rev);
      assert.deepEqual((await member.client.open()).board, host.head);
    };
    report(t, `client replay ${count} pushed one-op batches in order`, await bestOfAsync(async () => {
      for (const item of host.items) member.client.onEvent(host.event(item));
      await finish();
      assert.equal(member.pushes.filter((push) => push.kind === 'applied').length, count);
    }, fresh));
    if (count !== 100) continue;
    // The first event is lost: the second shows the gap and the client reads what is missing from the host.
    report(t, 'client catch-up over 100 batches, the first event lost', await bestOfAsync(async () => {
      for (const item of host.items.slice(1)) member.client.onEvent(host.event(item));
      await finish();
    }, fresh));
    report(t, 'client catch-up over 100 batches, events in reverse order', await bestOfAsync(async () => {
      for (const item of [...host.items].reverse()) member.client.onEvent(host.event(item));
      await finish();
    }, fresh));
  }
});

test('client: applies one local card.place, optimistic and then confirmed by the host', async (t) => {
  const host = scriptedHost();
  const member = memberOn(host);
  await member.client.open();
  let counter = 0;
  let params = null;
  let optimistic = Infinity;
  const settle = async () => {
    for (let tries = 0; tries < 20000 && member.client.resources().pending > 0; tries += 1) {
      while (host.events.length) member.client.onEvent(host.event(host.events.shift()));
      await tick();
    }
    assert.equal(member.client.resources().pending, 0);
  };
  const prepare = () => { counter += 1; params = { batch_id: `local-${counter}`, ops: [{ op: 'card.place', id: cardId(1 + (counter % 500)), x: 500 + counter, y: 60 }] }; };
  report(t, 'client one local card.place until the host confirmed it', await bestOfAsync(async () => {
    const from = performance.now();
    const answer = member.client.apply(params);
    optimistic = Math.min(optimistic, performance.now() - from);
    assert.deepEqual([answer.ok, answer.pending, answer.board.cards[params.ops[0].id].x], [true, 1, 500 + counter]);
    await settle();
  }, prepare));
  report(t, 'client one local card.place, optimistic answer', optimistic);
  const state = await member.client.open();
  assert.deepEqual(state.board, host.head);
  assert.equal(state.board.cards[params.ops[0].id].x, 500 + counter);
});

// The surface of the canvas the presence part draws into: 500 card elements and the layer they share with it.
function mountCanvas(t) {
  const dom = new JSDOM('<!doctype html><body><div id="surface"><div id="layer"></div></div></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const layer = doc.getElementById('layer');
  const board = base();
  for (const card of Object.values(board.cards)) {
    const el = doc.createElement('div');
    el.className = 'board-card';
    el.setAttribute('data-card-id', card.id);
    el.style.left = `${card.x}px`;
    el.style.top = `${card.y}px`;
    el.textContent = card.kind === 'note' ? card.data.text.slice(0, 40) : card.kind;
    layer.appendChild(el);
  }
  return { dom, doc, layer, board, surface: doc.getElementById('surface') };
}

test('page: other members\' pointers and the "is typing" label touch no card element', async (t) => {
  const m = mountCanvas(t);
  const names = { member_ann: 'Ann', member_bo: 'Bo', member_cy: 'Cy', member_di: 'Di', member_ed: 'Ed', member_flo: 'Flo', member_gus: 'Gus', member_hal: 'Hal' };
  const watchers = new Set();
  const live = { state: { viewers: [], cursors: [], locks: [] } };
  const source = { scope: { teamId: 'team_one' }, presence: { get: () => live.state, cursor() {},
    subscribe: (fn) => { watchers.add(fn); return () => watchers.delete(fn); } } };
  const show = (next) => { live.state = { viewers: [], cursors: [], locks: [], ...next }; for (const fn of [...watchers]) fn(live.state); };
  const ctx = { document: m.doc, canvas: { surface: { layer: m.layer, element: m.surface, toBoard: (x, y) => ({ x, y }) } },
    editor: { getBoard: () => m.board, getSelection: () => [], onChange: () => () => {} }, getTeamSource: () => source, getOpenBoardId: () => m.board.id };
  const jt = (_key, fallback, params) => String(fallback).replace('{name}', params.name);
  const part = createTeamPresence({ ctx, windowRef: m.dom.window, jt, data: { selfId: () => SELF, nameOrFormer: (id) => names[id] || id, iso: (name) => name } });
  part.sync();
  t.after(() => part.dispose());
  const cards = [...m.layer.querySelectorAll('.board-card')];
  assert.equal(cards.length, 500);
  // jsdom hands the records to the callback at the next microtask, so the callback keeps them.
  const seen = [];
  const observer = new m.dom.window.MutationObserver((records) => { seen.push(...records); });
  observer.observe(m.layer, { subtree: true, childList: true, attributes: true, characterData: true });
  const others = Object.keys(names).slice(0, 7);
  // Only the presence part's own nodes may change: a record on the layer is the part adding or removing its holder.
  // A node the part has since removed still names its own class, so the chain is read from the node up.
  const mine = (node) => { for (let at = node; at; at = at.parentNode) if (/board-team-(presence|cursor|hold)/u.test(at.className || '')) return true; return false; };
  const onlyPresence = (records) => records.every((record) => (record.target === m.layer
    ? [...record.addedNodes, ...record.removedNodes].every(mine) : mine(record.target)));
  const settled = () => {
    const records = seen.splice(0).concat(observer.takeRecords());
    assert.ok(onlyPresence(records), 'a node outside the presence part changed');
    assert.deepEqual([...m.layer.querySelectorAll('.board-card')], cards, 'a card element was replaced');
    return records.length;
  };
  let round = 0;
  const burst = () => {
    round += 1;
    for (let move = 0; move < 100; move += 1) {
      for (const [k, memberId] of others.entries()) {
        show({ cursors: others.map((id, j) => ({ member_id: id, x: 100 * j + (id === memberId ? move + round : 0), y: 40 * j + move })) });
        if (k === 6 && move === 99) assert.equal(m.layer.querySelectorAll('.board-team-cursor').length, 7);
      }
    }
  };
  report(t, 'page 7 other members pointers, 100 moves each (700 draws)', await bestOfAsync(async () => { burst(); }, () => { settled(); }));
  const changes = settled();
  assert.ok(changes > 0);
  assert.deepEqual(cards.map((el) => el.style.left), Object.values(m.board.cards).map((card) => `${card.x}px`));
  const note = Object.values(m.board.cards).find((card) => card.kind === 'note');
  show({});
  settled();
  report(t, 'page a held note label shown and removed 100 times', await bestOfAsync(async () => {
    for (let i = 0; i < 100; i += 1) {
      show({ locks: [{ card_id: note.id, member_id: 'member_bo' }] });
      if (i === 99) assert.equal(m.layer.querySelector('.board-team-hold').textContent, 'Bo is typing');
      show({});
    }
    assert.equal(m.layer.querySelector('.board-team-hold'), null);
  }, () => { settled(); }));
  assert.ok(settled() > 0);
});

test('page: the team source lists, opens and applies on the 500-card board', async (t) => {
  const board = base();
  const calls = [];
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `board_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Board ${i}`, rev: 1,
    created_at: NOW, updated_at: NOW, created_by: OTHER }));
  const answers = {
    boardList: { ok: true, boards: rows },
    boardOpen: { ok: true, board, rev: board.rev, read_only: false, pending: 0, presence: { viewers: [OTHER], cursors: [], locks: [] } },
    boardApply: { ok: true, board, rev: board.rev + 1, pending: 1, applied: null, duplicate: false },
  };
  const bridge = new Proxy({}, { get: (_target, name) => {
    if (name === 'onBoard') return () => () => {};
    return async (payload) => { calls.push(name); return answers[name] ?? { ok: true }; };
  } });
  const source = createTeamBoardSource({ bridge, teamId: 'team_one', projectId: PROJECT_ID, role: () => 'writer' });
  t.after(() => source.dispose());
  report(t, 'source list 20 boards', await bestOfAsync(async () => {
    const listed = await source.list({});
    assert.deepEqual([listed.ok, listed.boards.length], [true, 20]);
  }));
  report(t, 'source get the 500-card board', await bestOfAsync(async () => {
    const opened = await source.get({ boardId: board.id });
    assert.deepEqual([opened.ok, Object.keys(opened.board.cards).length, opened.viewOnly], [true, 500, false]);
  }));
  let counter = 0;
  report(t, 'source apply one card.place', await bestOfAsync(async () => {
    counter += 1;
    const batch = { batch_id: `page-${counter}`, ops: [{ op: 'card.place', id: cardId(1), x: counter, y: 5 }] };
    const done = await source.apply({ boardId: board.id, batch });
    assert.deepEqual([done.ok, done.duplicate, Object.keys(done.board.cards).length], [true, false, 500]);
  }));
  assert.deepEqual([...new Set(calls)].sort(), ['boardApply', 'boardList', 'boardOpen']);
});
