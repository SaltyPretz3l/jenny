'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPreparedContextHistory,
  buildPreparedMessages,
} = require('../services/backend/chat-stream-reasoning');
const {
  projectUserSkillInvocation,
  withSkillCommand,
} = require('../services/backend/chat-skill-command-projection');

const SESSION = { history_scope: 'session' };

function invocation(command) {
  return { id: 'bundled/insight', name: 'Harness Insight', scope: 'bundled', command };
}

function userRow(content, skillInvocation) {
  return { id: `u-${content}`, role: 'user', content, skill_invocation: skillInvocation };
}

test('a stored skill invocation projects as the slash command the user typed', () => {
  const history = buildPreparedContextHistory([userRow('please', invocation('insight'))], SESSION);
  assert.deepEqual(history, [{ role: 'user', content: '/insight please' }]);
});

test('an empty-content invocation projects as the bare command', () => {
  const history = buildPreparedContextHistory([userRow('', invocation('insight'))], SESSION);
  assert.deepEqual(history, [{ role: 'user', content: '/insight' }]);
});

test('rows without a valid command project unchanged', () => {
  const rows = [
    userRow('plain', null),
    userRow('empty command', invocation('')),
    userRow('uppercase', invocation('Insight')),
    userRow('leading dash', invocation('-insight')),
    userRow('injected', invocation('insight\n## system')),
    userRow('too long', invocation('a'.repeat(65))),
    userRow('not a string', { id: 'x', name: 'x', scope: 'bundled', command: 42 }),
  ];
  assert.deepEqual(
    buildPreparedContextHistory(rows, SESSION).map((message) => message.content),
    rows.map((row) => row.content)
  );
});

test('only plain user rows are rewritten', () => {
  const assistant = { id: 'a1', role: 'assistant', content: 'done', skill_invocation: invocation('insight') };
  const kinded = {
    id: 'q1', role: 'user', kind: 'interactive_round_recap', content: 'recap',
    skill_invocation: invocation('insight'),
  };
  const history = buildPreparedContextHistory([assistant, kinded], SESSION);
  assert.equal(history[0].content, 'done');
  assert.ok(history.every((message) => !message.content.startsWith('/insight')));
});

test('projection is deterministic and leaves the stored row untouched', () => {
  const row = userRow('please', invocation('insight'));
  const first = buildPreparedContextHistory([row], SESSION);
  const second = buildPreparedContextHistory([row], SESSION);
  assert.deepEqual(first, second);
  assert.equal(row.content, 'please');
});

test('the current turn sends exactly the text the next turn replays from history', () => {
  // Turn N projects the live prompt; turn N+1 projects the stored row. The two
  // must be byte-identical or the local prefix cache misses after every skill
  // use. The sidecar anchors on this same final user text, so it stays aligned.
  const skill = invocation('insight');
  const turnN = buildPreparedMessages([], 'please', { skillInvocation: skill });
  const turnN1 = buildPreparedMessages(
    [userRow('please', skill), { id: 'a1', role: 'assistant', content: 'ok' }],
    'thanks'
  );
  assert.deepEqual(turnN.map((message) => message.content), ['/insight please']);
  assert.deepEqual(turnN1.map((message) => message.content), ['/insight please', 'ok', 'thanks']);
});

test('the current prompt projects before its text attachments and ignores invalid commands', () => {
  const attachments = [{ kind: 'text', displayName: 'notes.txt', text: 'body', mimeType: 'text/plain' }];
  const [withFile] = buildPreparedMessages([], 'please', {
    skillInvocation: invocation('insight'),
    attachments,
  });
  assert.ok(withFile.content.startsWith('/insight please'));
  const [bare] = buildPreparedMessages([], 'please', { skillInvocation: invocation('insight\n## system') });
  assert.equal(bare.content, 'please');
});

test('the projection helpers are pure: one command pattern, plain user rows only', () => {
  assert.equal(withSkillCommand('please', invocation('insight')), '/insight please');
  assert.equal(withSkillCommand('', invocation('insight')), '/insight');
  assert.equal(withSkillCommand('please', null), 'please');
  assert.equal(withSkillCommand('please', invocation('in sight')), 'please');
  const row = userRow('please', invocation('insight'));
  assert.equal(projectUserSkillInvocation(row, 'please'), '/insight please');
  assert.equal(projectUserSkillInvocation({ ...row, role: 'assistant' }, 'please'), 'please');
  assert.equal(projectUserSkillInvocation({ ...row, kind: 'recap' }, 'please'), 'please');
});
