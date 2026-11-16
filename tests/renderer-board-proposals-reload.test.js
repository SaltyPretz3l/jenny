'use strict';

// new-test-file: tests/renderer-board-proposals-view.test.js is at the 600-line cap. This file holds one rule of the same view
// (row 151, final review): how often the proposal list is read again while batches are applied. On a team board each read is a
// call to the host that counts against the member's reads, so a burst of applied batches may not become a burst of reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const { createProposalsView } = require('../renderer/features/board/board-proposals-view');

const BOARD = 'board_00000000-0000-4000-8000-000000000001';
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const OPEN = { id: 'p1', sessionId: 's1', messageId: 'p1', state: 'pending', open: true, createdAt: '2026-11-13T10:00:00.000Z', madeAgainstRev: 1, overflow: 0, preview: null,
  counts: { total: 1, pending: 1, additions: 1, edits: 0, removals: 0, applied: 0, refused: 0, skipped: 0, rejected: 0 },
  changes: [{ n: 1, line: 'note line 1', type: 'note', class: 'addition', state: 'pending', reason: '', summary: { text: 'A', group: '' } }] };

// The view over a scripted source; the one timer the view sets (the wait after an applied batch) is held and fired by the test.
function harness(t, proposals) {
  const { window } = new JSDOM('<!doctype html><body><div class="centre"><div class="canvas"><div class="layer"></div></div></div><div id="host"></div></body>', { url: 'https://jenny.invalid/' });
  const doc = window.document;
  const waits = [];
  window.setTimeout = (fn, ms) => { const entry = { fn, ms, live: true }; waits.push(entry); return entry; };
  window.clearTimeout = (entry) => { if (entry && typeof entry === 'object') entry.live = false; };
  const listeners = new Set();
  const source = {
    reads: 0,
    async listProposals() { source.reads += 1; return { ok: true, proposals }; },
    async decideProposal() { return { ok: true }; },
    onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(event) { listeners.forEach((fn) => fn(event)); },
  };
  const part = createProposalsView({
    document: doc, windowRef: window, source, notify: () => {}, log: () => {}, actionButton,
    editor: { getBoard: () => ({ id: BOARD }), onChange: () => () => {} },
    surface: { element: doc.querySelector('.canvas'), layer: doc.querySelector('.layer') },
    context: { getChangesHost: () => doc.getElementById('host'), revealChanges: () => true },
  });
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; part.dispose(); } };
  t.after(() => { dispose(); window.close(); });
  const live = () => waits.filter((entry) => entry.live);
  return { source, dispose, live, fire: () => live().forEach((entry) => { entry.live = false; entry.fn(); }), applied: () => source.emit({ boardId: BOARD, kind: 'applied' }) };
}

test('a burst of applied batches reads the open proposal once at its start and once after the wait, and a proposals event reads at once', async (t) => {
  const h = harness(t, [OPEN]);
  await flush();
  assert.equal(h.source.reads, 1, 'the first read, on mount');
  h.applied();
  await flush();
  assert.deepEqual([h.source.reads, h.live().map((entry) => entry.ms)], [2, [2000]], 'the first applied batch reads at once and starts the wait');
  for (let i = 0; i < 20; i += 1) h.applied();
  await flush();
  assert.equal(h.source.reads, 2, 'twenty more inside the wait read nothing');
  h.fire();
  await flush();
  assert.deepEqual([h.source.reads, h.live().length], [3, 1], 'one read for all of them when the wait ends, and the next wait starts');
  h.fire();
  await flush();
  assert.deepEqual([h.source.reads, h.live().length], [3, 0], 'a wait nothing arrived in reads nothing and starts no other');
  h.applied();
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await flush();
  assert.equal(h.source.reads, 6, 'a change to the proposals themselves is never held back');
  h.applied();
  h.dispose();
  assert.equal(h.live().length, 0, 'the wait ends with the view');
  h.fire();
  await flush();
  assert.equal(h.source.reads, 6);
});

test('with no proposal open an applied batch reads nothing and starts no wait', async (t) => {
  const h = harness(t, []);
  await flush();
  h.applied();
  h.applied();
  await flush();
  assert.deepEqual([h.source.reads, h.live().length], [1, 0]);
});
