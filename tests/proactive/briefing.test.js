'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readGitSnapshot } = require('../../services/proactive/briefing');

test('git snapshot distinguishes staged, unstaged, mixed, and untracked porcelain rows', async () => {
  const execFileImpl = (_command, args, _options, callback) => {
    const operation = args[2];
    const stdout = operation === 'rev-parse'
      ? 'main\n'
      : operation === 'status'
        ? 'M  staged.js\n M unstaged.js\nMM mixed.js\n?? untracked.js\n'
        : '';
    callback(null, stdout, '');
  };

  const snapshot = await readGitSnapshot('repo', execFileImpl);

  assert.equal(snapshot.summary, 'Git: branch main; 4 changed, 2 staged, 1 untracked.');
});
