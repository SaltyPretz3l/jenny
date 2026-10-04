const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDailyBriefingSnapshot,
} = require('../services/proactive/briefing');

// Personality v3 retired memory/YYYY-MM-DD.md. The briefing's memory slice is
// now a single MEMORY.md ("Long-term notes") line sourced from
// `getNotesSnapshot()`, and the unavailable branch has to survive a workspace
// that predates the method entirely.
function createWorkspace(snapshot) {
  return {
    async getResolvedTimeZone() { return 'America/Chicago'; },
    async getNotesSnapshot() {
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  };
}

const BASE = {
  now: new Date('2026-03-19T14:30:00.000Z'),
  workspaceRoot: '',
  workspaceRootStatus: { state: 'missing', message: 'No workspace root is configured.' },
  gitSnapshot: { available: false, summary: 'Git snapshot unavailable.', recentCommits: [] },
};

test('HOM-15 briefing Git deadline settles even when the executor never calls back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timeouts = [];
  const callbacks = [];
  let killed = false;
  const pending = require('../services/proactive/briefing').readGitSnapshot('repo', (_cmd, _args, opts, callback) => {
    timeouts.push(opts.timeout);
    callbacks.push(callback);
    return { kill: () => { killed = true; } };
  });
  assert.deepEqual(timeouts, [10000]);
  t.mock.timers.tick(4000);
  callbacks[0](null, 'main\n', '');
  await new Promise((resolve) => setImmediate(resolve));
  // The three reads share one deadline: the second gets what is left.
  assert.deepEqual(timeouts, [10000, 6000]);
  t.mock.timers.tick(6000);
  const snapshot = await pending;
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.retryable, true);
  assert.equal(killed, true);
});

test('the briefing renders one Notes line from the long-term notes snapshot', async () => {
  const snapshot = await buildDailyBriefingSnapshot({
    ...BASE,
    personalityWorkspace: createWorkspace({
      available: true,
      notes: 'Ship the thin companion slice.\nSecond line is dropped.',
    }),
  });

  assert.deepEqual(snapshot.memory, {
    available: true,
    notesSnippet: 'Ship the thin companion slice.',
  });
  assert.equal(snapshot.lines.includes('Notes: Ship the thin companion slice.'), true);
  assert.equal(snapshot.lines.some((line) => /Yesterday memory|Today memory/.test(line)), false);
  assert.equal(snapshot.timeZone, 'America/Chicago');
});

test('an empty, throwing, or pre-v3 notes source falls back to the unavailable branch', async () => {
  for (const workspace of [
    createWorkspace({ available: false, notes: '' }),
    createWorkspace(new Error('workspace unreadable')),
    { async getResolvedTimeZone() { return 'America/Chicago'; } },
    null,
  ]) {
    const snapshot = await buildDailyBriefingSnapshot({ ...BASE, personalityWorkspace: workspace });
    assert.deepEqual(snapshot.memory, { available: false, notesSnippet: 'No notes yet.' });
    assert.equal(snapshot.lines.includes('Personality memory notes were unavailable.'), true);
  }
});

test('a notes body of only headings clips to the no-notes placeholder', async () => {
  const snapshot = await buildDailyBriefingSnapshot({
    ...BASE,
    personalityWorkspace: createWorkspace({ available: true, notes: '# Long-term notes\n\n' }),
  });
  assert.equal(snapshot.memory.available, true);
  assert.equal(snapshot.memory.notesSnippet, 'No notes yet.');
});
