const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createWorkspaceChromeController } = require('../renderer/shell/renderer-workspace-chrome-utils');

// A background stream repaints chrome up to ~20 Hz. Its runtime-only sidebar
// badge pass must touch only rows whose runtime facts changed, and must still
// repaint a row the chats panel rebuilt since its last paint.

function setup(t, count) {
  const dom = new JSDOM('<!doctype html><html><body><div id="rail"></div><ul id="conversationGroups"></ul></body></html>');
  t.after(() => { dom.window.document.body.replaceChildren(); });
  const doc = dom.window.document;
  const list = doc.getElementById('conversationGroups');
  for (let index = 1; index <= count; index += 1) list.insertAdjacentHTML('beforeend', rowMarkup(`s${index}`, `Chat ${index}`));
  return { doc, rows: () => doc.querySelectorAll('#conversationGroups [data-session-id]') };
}

function rowMarkup(id, title) {
  return `<li class="conversation-item" data-session-id="${id}" data-session-pinned="false" data-session-type="chat">`
    + `<button data-session-open="${id}"><span class="session-row__dot"></span>`
    + `<span class="conversation-title"><span class="session-row__title-text">${title}</span></span></button></li>`;
}

function countRowQueries(rows) {
  const counter = { count: 0 };
  Array.from(rows).forEach((row) => {
    const original = row.querySelector.bind(row);
    row.querySelector = (selector) => { counter.count += 1; return original(selector); };
  });
  return counter;
}

const label = (doc, id) => doc.querySelector(`[data-session-open="${id}"]`).getAttribute('aria-label');

test('a runtime-only pass skips rows whose runtime facts did not change', (t) => {
  const { doc, rows } = setup(t, 4);
  const controller = createWorkspaceChromeController({ containerEl: doc.getElementById('rail') });
  controller.renderSidebarBadges(rows(), ['s1'], ['s1'], [], {});
  assert.equal(label(doc, 's2'), 'Open session Chat 2');
  const queries = countRowQueries(rows());
  controller.renderSidebarBadges(rows(), ['s1'], ['s1'], [], {}, undefined, null, { runtimeOnly: true });
  assert.equal(queries.count, 0, 'no row with unchanged facts is read');

  controller.renderSidebarBadges(rows(), ['s1'], ['s1', 's3'], [], {}, undefined, null, { runtimeOnly: true });
  assert.ok(queries.count > 0, 'the row that started streaming is repainted');
  assert.equal(label(doc, 's3'), 'Open session Chat 3. Status: Streaming');
  assert.equal(doc.querySelector('[data-session-id="s3"]').dataset.sessionDominantState, 'streaming');
  assert.equal(label(doc, 's1'), 'Open session Chat 1. Status: Streaming');
});

test('a runtime-only pass repaints each kind of runtime fact', (t) => {
  const { doc, rows } = setup(t, 3);
  const controller = createWorkspaceChromeController({ containerEl: doc.getElementById('rail') });
  controller.renderSidebarBadges(rows(), [], [], [], {}, new Map(), null);
  controller.renderSidebarBadges(rows(), [], [], [], { s1: 2 }, new Map([['s2', 'input_needed']]), { s3: 'failed' }, { runtimeOnly: true });
  assert.equal(label(doc, 's1'), 'Open session Chat 1. Status: Linked 2');
  assert.equal(label(doc, 's2'), 'Open session Chat 2. Status: Input needed');
  assert.equal(doc.querySelector('[data-session-id="s3"]').dataset.sessionLastOutcome, 'failed');
  controller.renderSidebarBadges(rows(), ['s1'], [], [], { s1: 2 }, new Map(), { s3: 'failed' }, { runtimeOnly: true });
  assert.equal(label(doc, 's1'), 'Open session Chat 1. Status: Open, Linked 2');
  assert.equal(label(doc, 's2'), 'Open session Chat 2');
});

test('a runtime-only pass repaints a row the panel rebuilt since its last paint', (t) => {
  const { doc, rows } = setup(t, 2);
  const controller = createWorkspaceChromeController({ containerEl: doc.getElementById('rail') });
  controller.renderSidebarBadges(rows(), ['s1'], ['s1'], [], {});
  const row = doc.querySelector('[data-session-id="s1"]');
  // The panel keeps the row element and replaces its contents.
  row.innerHTML = '<button data-session-open="s1"><span class="session-row__dot"></span>'
    + '<span class="conversation-title"><span class="session-row__title-text">Renamed</span></span></button>';
  controller.renderSidebarBadges(rows(), ['s1'], ['s1'], [], {}, undefined, null, { runtimeOnly: true });
  assert.equal(label(doc, 's1'), 'Open session Renamed. Status: Streaming');
  assert.equal(doc.querySelector('[data-session-id="s1"] .session-row__dot').getAttribute('title'), 'Streaming');
});

test('a structural pass repaints a rebuilt row and skips the unchanged ones', (t) => {
  const { doc, rows } = setup(t, 2);
  const controller = createWorkspaceChromeController({ containerEl: doc.getElementById('rail') });
  controller.renderSidebarBadges(rows(), [], [], [], {});
  // Pinning changes the row's signature, so the panel sets the flag and rebuilds its contents.
  const row = doc.querySelector('[data-session-id="s2"]');
  row.dataset.sessionPinned = 'true';
  row.replaceChildren(...Array.from(row.childNodes, (node) => node.cloneNode(true)));
  const queries = countRowQueries([doc.querySelector('[data-session-id="s1"]')]);
  controller.renderSidebarBadges(rows(), [], [], [], {});
  assert.equal(label(doc, 's2'), 'Open session Chat 2. Status: Pinned');
  assert.equal(queries.count, 0, 'an unchanged row is skipped by a structural pass too');
});

test('a locale change repaints rows whose facts are unchanged', (t) => {
  const { doc, rows } = setup(t, 1);
  const controller = createWorkspaceChromeController({ containerEl: doc.getElementById('rail') });
  let tag = 'en';
  const previous = globalThis.jennyI18n;
  globalThis.jennyI18n = { ...(previous || {}), tag: () => tag };
  t.after(() => { globalThis.jennyI18n = previous; });
  controller.renderSidebarBadges(rows(), [], [], [], {});
  const queries = countRowQueries(rows());
  controller.renderSidebarBadges(rows(), [], [], [], {});
  assert.equal(queries.count, 0);
  tag = 'fr';
  controller.renderSidebarBadges(rows(), [], [], [], {});
  assert.ok(queries.count > 0);
});

test('runtime-only passes paint exactly what full passes paint across a fact sequence', (t) => {
  const left = setup(t, 6);
  const right = setup(t, 6);
  const full = createWorkspaceChromeController({ containerEl: left.doc.getElementById('rail') });
  const runtime = createWorkspaceChromeController({ containerEl: right.doc.getElementById('rail') });
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const states = ['approval', 'plan_review', 'input_needed', undefined];
  const outcomes = ['failed', 'completed', 'cancelled', undefined];
  let seed = 7;
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pick = () => ids.filter(() => next(3) === 0);
  full.renderSidebarBadges(left.rows(), [], [], [], {});
  runtime.renderSidebarBadges(right.rows(), [], [], [], {});
  for (let step = 0; step < 60; step += 1) {
    const attention = next(4) === 0 ? undefined : new Map(pick().map((id) => [id, states[next(states.length)]]));
    const linked = Object.fromEntries(pick().map((id) => [id, next(4)]));
    const outcome = Object.fromEntries(pick().map((id) => [id, outcomes[next(outcomes.length)]]));
    const args = [pick(), pick(), pick(), linked, attention, outcome];
    full.renderSidebarBadges(left.rows(), ...args);
    runtime.renderSidebarBadges(right.rows(), ...args, { runtimeOnly: true });
    for (const id of ids) {
      const a = left.doc.querySelector(`[data-session-id="${id}"]`);
      const b = right.doc.querySelector(`[data-session-id="${id}"]`);
      assert.equal(label(right.doc, id), label(left.doc, id), `step ${step} ${id} label`);
      assert.deepEqual({ ...b.dataset }, { ...a.dataset }, `step ${step} ${id} data`);
      assert.equal(b.querySelector('.session-row__dot').getAttribute('title'), a.querySelector('.session-row__dot').getAttribute('title'));
    }
  }
});
