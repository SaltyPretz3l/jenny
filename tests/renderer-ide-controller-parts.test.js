'use strict';

/* The chat's Git links (row 40 W6 F8; createGitLinks in the wiring module) are covered after these.
 * The IDE controller hands its extracted wiring + lifecycle modules a lazy `parts` accessor.
 * A name those modules read that the controller does not expose would be a silent undefined, so
 * pin: every `p.<name>` (and every `const { ... } = p;` name) is a getter on `parts`. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createIdeViewLifecycle } = require('../renderer/features/renderer-ide-view-lifecycle.js');
const { createGitLinks } = require('../renderer/features/renderer-ide-controller-wiring.js');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', name), 'utf8');

test('a panel opened during the first load waits for the hydrate that restores the saved layout', async () => {
  let finishHydrate;
  const log = [];
  const parts = {
    hydratePersistedState: () => new Promise((resolve) => { finishHydrate = resolve; }),
    renderTabs: () => log.push('rendered'),
  };
  const lifecycle = createIdeViewLifecycle({
    getDom: () => ({}), registerCleanup: () => {}, appendClientLog: () => {}, getIde: () => ({}), parts,
  });
  const waited = lifecycle.whenActivated().then(() => log.push('activated'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, [], 'still hydrating');
  finishHydrate();
  await waited;
  assert.deepEqual(log, ['rendered', 'activated']);
  await lifecycle.whenActivated();
  assert.equal(log.length, 2, 'a later wait does not activate again');
});

test('every parts name the wiring and lifecycle modules read is exposed by the controller', () => {
  const controller = read('renderer-ide-controller.js');
  const block = controller.slice(controller.indexOf('const parts = {'), controller.indexOf('const lifecycle ='));
  const exposed = new Set([...block.matchAll(/get (\w+)\(\)/g)].map((match) => match[1]));
  assert.ok(exposed.size > 60, 'the parts block was found');
  for (const file of ['renderer-ide-controller-wiring.js', 'renderer-ide-view-lifecycle.js']) {
    const source = read(file);
    const used = new Set([...source.matchAll(/\bp\.(\w+)/g)].map((match) => match[1]));
    for (const match of source.matchAll(/const \{([^}]*)\} = p;/g)) {
      for (const name of match[1].split(',').map((entry) => entry.trim()).filter(Boolean)) used.add(name);
    }
    for (const name of used) assert.ok(exposed.has(name), `${file} reads parts.${name}, which the controller does not expose`);
  }
});

// ---- The chat's Git links (row 40 W6 F8): pane 0's ledger index, markers, Open in Git ----

function turn(turnId, files = []) {
  return { turnId, files, rootMessageIds: { assistant: `a-${turnId}` }, toolCalls: [] };
}

function linkRig(t, opts = {}) {
  const state = {
    currentSessionId: 's1',
    ui: { activeView: opts.activeView || 'ide' },
    features: { featureFlags: { ide_chat_dock: opts.flag !== false } },
    workspaceRoot: { rootId: 'ws' },
  };
  const turnsBySession = { s1: [turn('t1', ['a.js'])], p0: [], p1: [] };
  const ledgerCalls = [];
  const buildLedger = (vms, meta) => {
    ledgerCalls.push({ n: vms.length, meta });
    return { changes: vms.flatMap((vm) => vm.files.map((file) => ({ path: file, turnId: vm.turnId, fileKey: `ws:${file}` }))) };
  };
  const shown = [];
  const scrolled = [];
  const rows = ['a.js', 'b.js'].map((file) => ({
    getAttribute: () => file,
    scrollIntoView: (arg) => scrolled.push([file, arg]),
    querySelector: () => null,
  }));
  const wb = {
    showPanel: (id) => { shown.push(id); return true; },
    viewDeps: () => ({ getMountEl: () => ({ querySelectorAll: () => rows }) }),
  };
  const panes = { count: opts.panes || 1, sessions: ['p0', 'p1'], getPaneCount() { return this.count; }, getPaneSessionId(i) { return this.sessions[i] || ''; } };
  const git = {
    repo: true,
    changed: new Set(['a.js']),
    refreshes: 0,
    isRepo() { return this.repo; },
    getDecoration(file) { return this.changed.has(file) ? { badge: 'M' } : null; },
    subscribe: () => () => {},
    refreshJennyMarkers() { this.refreshes += 1; },
  };
  const timers = { next: 1, pending: new Map(), cleared: [] };
  const links = createGitLinks({
    state,
    getWorkbench: () => wb,
    getPaneComposition: () => (opts.noPanes ? null : panes),
    getTurnViewModels: (sid) => turnsBySession[sid] || [],
    getSessionMessages: () => [],
    buildLedger,
    getGitFeature: () => (opts.noGit ? null : git),
    viewDeps: opts.viewDeps || {},
    setTimeout: (fn) => { const id = timers.next++; timers.pending.set(id, fn); return id; },
    clearTimeout: (id) => { timers.cleared.push(id); timers.pending.delete(id); },
  });
  t.after(() => links.dispose());
  const fire = () => { const fns = Array.from(timers.pending.values()); timers.pending.clear(); fns.forEach((fn) => fn()); };
  return { state, links, git, panes, timers, fire, turnsBySession, ledgerCalls, shown, scrolled };
}

test('primarySessionId: current session with one pane, pane 0 with two even when the current is pane 1', (t) => {
  const f = linkRig(t);
  assert.equal(f.links.primarySessionId(), 's1');
  f.panes.count = 2;
  f.state.currentSessionId = 'p1';
  assert.equal(f.links.primarySessionId(), 'p0');
  assert.equal(f.links.viewDeps.getSessionId(), 'p0');
  assert.equal(linkRig(t, { noPanes: true }).links.primarySessionId(), 's1', 'no pane composition falls back to the current session');
});

test('jennyChangeFor maps paths to the latest turn and file key, and is null with the dock flag off', (t) => {
  const f = linkRig(t);
  f.turnsBySession.s1 = [turn('t1', ['a.js']), turn('t2', ['a.js', 'b.js'])];
  assert.deepEqual(f.links.jennyChangeFor('a.js'), { turnId: 't2', fileKey: 'ws:a.js' }, 'the later turn wins');
  assert.deepEqual(f.links.jennyChangeFor('b.js'), { turnId: 't2', fileKey: 'ws:b.js' });
  assert.equal(f.links.jennyChangeFor('zzz.js'), null);
  assert.deepEqual(f.ledgerCalls[0].meta, { sessionId: 's1', workspaceId: 'ws' });
  const off = linkRig(t, { flag: false });
  assert.equal(off.links.jennyChangeFor('a.js'), null);
  assert.equal(off.ledgerCalls.length, 0, 'the ledger is not even built without the dock');
});

test('jennyChangeFor rebuilds when a turn is pushed onto the same array, and re-keys on a session change', (t) => {
  const f = linkRig(t);
  assert.equal(f.links.jennyChangeFor('b.js'), null);
  assert.equal(f.links.jennyChangeFor('a.js').turnId, 't1');
  assert.equal(f.ledgerCalls.length, 1, 'unchanged turns reuse the index');
  f.turnsBySession.s1.push(turn('t2', ['b.js'])); // same array identity, grown in place
  assert.deepEqual(f.links.jennyChangeFor('b.js'), { turnId: 't2', fileKey: 'ws:b.js' });
  assert.equal(f.ledgerCalls.length, 2);
  f.links.jennyChangeFor('a.js');
  assert.equal(f.ledgerCalls.length, 2, 'stable again after the rebuild');
  f.state.currentSessionId = 's2';
  assert.equal(f.links.jennyChangeFor('a.js'), null, 's2 has no turns');
  assert.equal(f.ledgerCalls[2].meta.sessionId, 's2');
  f.state.currentSessionId = 's1';
  assert.equal(f.links.jennyChangeFor('a.js').turnId, 't1');
  assert.equal(f.ledgerCalls.length, 4, 'switching back rebuilds as well');
});

test('scheduleMarkerRefresh: one timer, refresh only when the path-to-change signature changed', (t) => {
  const f = linkRig(t);
  f.links.scheduleMarkerRefresh();
  f.links.scheduleMarkerRefresh();
  assert.equal(f.timers.pending.size, 1, 'one pending timer at a time');
  f.fire();
  assert.equal(f.git.refreshes, 1, 'first signature differs from the empty one');
  f.links.scheduleMarkerRefresh();
  assert.equal(f.timers.pending.size, 1, 'a fired timer frees the slot');
  f.fire();
  assert.equal(f.git.refreshes, 1, 'same signature: no repaint');
  f.turnsBySession.s1.push(turn('t2', ['b.js']));
  f.links.scheduleMarkerRefresh();
  f.fire();
  assert.equal(f.git.refreshes, 2, 'a new change repaints');
});

test('scheduleMarkerRefresh: no timer outside the Workspace, no refresh for an empty ledger, dispose clears it', (t) => {
  const out = linkRig(t, { activeView: 'chat' });
  out.links.scheduleMarkerRefresh();
  assert.equal(out.timers.pending.size, 0);
  const empty = linkRig(t);
  empty.turnsBySession.s1 = [];
  empty.links.scheduleMarkerRefresh();
  empty.fire();
  assert.equal(empty.git.refreshes, 0, 'nothing to mark, nothing to repaint');
  const f = linkRig(t);
  f.links.scheduleMarkerRefresh();
  assert.equal(f.timers.pending.size, 1);
  f.links.dispose();
  assert.equal(f.timers.pending.size, 0);
  assert.equal(f.timers.cleared.length, 1);
  f.links.scheduleMarkerRefresh();
  assert.equal(f.timers.pending.size, 0, 'nothing schedules after dispose');
  assert.equal(f.git.refreshes, 0);
});

test('openInGit shows Source Control and scrolls the matching row; an unknown path scrolls nothing', (t) => {
  const f = linkRig(t);
  f.links.openInGit('b.js');
  assert.deepEqual(f.shown, ['source-control']);
  assert.deepEqual(f.scrolled, [['b.js', { block: 'nearest' }]]);
  f.links.openInGit('nope.js');
  f.links.openInGit(undefined);
  assert.deepEqual(f.shown, ['source-control', 'source-control', 'source-control']);
  assert.equal(f.scrolled.length, 1, 'no row matched, no scroll');
});

test('getGitState: changed, clean, and null for a non-repo or a missing git feature', (t) => {
  const f = linkRig(t);
  assert.equal(f.links.viewDeps.getGitState('a.js'), 'changed');
  assert.equal(f.links.viewDeps.getGitState('b.js'), 'clean');
  f.git.repo = false;
  assert.equal(f.links.viewDeps.getGitState('a.js'), null);
  const none = linkRig(t, { noGit: true });
  assert.equal(none.links.viewDeps.getGitState('a.js'), null);
  assert.equal(none.links.viewDeps.subscribeGit(() => {}), null);
  assert.equal(typeof f.links.viewDeps.subscribeGit(() => {}), 'function');
});

test('the Changes view names pane 0 on the diffs it opens (W7c binding)', (t) => {
  const calls = [];
  const f = linkRig(t, {
    viewDeps: {
      openChangeDiff: (change, origin) => calls.push(['change', change.path, origin]),
      openSuggestionDiff: (sessionId, id, origin) => calls.push(['suggestion', id, origin]),
    },
  });
  f.links.viewDeps.openChangeDiff({ path: 'a.js' });
  f.links.viewDeps.openSuggestionDiff('s1', 'sg1');
  assert.deepEqual(calls, [['change', 'a.js', { pane: 0 }], ['suggestion', 'sg1', { pane: 0 }]]);
});
