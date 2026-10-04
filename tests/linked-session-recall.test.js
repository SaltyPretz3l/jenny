const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLinkedSessionContext } = require('../services/backend/linked-session-recall');

function createSessionStore(sessions, messagesBySession = {}) {
  return {
    getSessionSummary(sessionId) {
      return sessions[sessionId] || null;
    },
    getSessionMessages(sessionId) {
      return messagesBySession[sessionId] || [];
    },
  };
}

test('linked session recall returns null when the active session has no links', () => {
  const store = createSessionStore({
    active: { id: 'active', project_id: 'project_general', linked_session_ids: [] },
  });
  assert.equal(buildLinkedSessionContext(store, 'active', 'plan this', []), null);
});

test('linked session recall excludes tool kinds and combines adjacent user assistant turns', () => {
  const store = createSessionStore(
    {
      active: { id: 'active', project_id: 'project_general', linked_session_ids: ['linked'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked: { id: 'linked', project_id: 'project_general', title: 'Linked Notes', updated_at: '2026-03-19T09:00:00.000Z' },
    },
    {
      linked: [
        { role: 'user', content: 'Draft the release plan.', timestamp: '2026-03-19T08:00:00.000Z' },
        { role: 'assistant', content: 'Release plan is ready.', timestamp: '2026-03-19T08:01:00.000Z' },
        { role: 'assistant', kind: 'tool_use', content: 'write_file notes.md', timestamp: '2026-03-19T08:02:00.000Z' },
        { role: 'assistant', kind: 'slash_command_output', content: 'Ignore this.', timestamp: '2026-03-19T08:03:00.000Z' },
      ],
    }
  );

  const message = buildLinkedSessionContext(store, 'active', 'Need the release plan', []);
  assert.ok(message);
  assert.match(message.content, /Linked Notes/);
  assert.match(message.content, /User: Draft the release plan\./);
  assert.match(message.content, /Assistant: Release plan is ready\./);
  assert.doesNotMatch(message.content, /write_file|Ignore this/);
});

test('linked session recall indexes interactive question batches and answer recaps', () => {
  const store = createSessionStore(
    {
      active: { id: 'active', project_id: 'project_general', linked_session_ids: ['linked'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked: { id: 'linked', project_id: 'project_general', title: 'Interactive Notes', updated_at: '2026-03-19T09:00:00.000Z' },
    },
    {
      linked: [
        { role: 'user', content: 'Help me plan the launch.', timestamp: '2026-03-19T08:00:00.000Z' },
        {
          role: 'assistant',
          kind: 'question_batch',
          content: 'A couple quick questions.',
          timestamp: '2026-03-19T08:01:00.000Z',
          interactive_batch: {
            batch_id: 'ib_launch',
            round_index: 1,
            intro_text: 'A couple quick questions.',
            questions: [
              {
                id: 'q1',
                prompt: 'What should I optimize for first?',
                options: [
                  { id: 'alignment', label: 'Stakeholder alignment' },
                  { id: 'speed', label: 'Speed' },
                ],
              },
            ],
          },
        },
        {
          role: 'assistant',
          kind: 'interactive_round_recap',
          content: 'Asked 1 question',
          timestamp: '2026-03-19T08:02:00.000Z',
          interactive_round_recap: {
            round_index: 1,
            answer_count: 1,
            items: [
              {
                question_id: 'q1',
                prompt: 'What should I optimize for first?',
                answer_label: 'Stakeholder alignment',
              },
            ],
          },
        },
      ],
    }
  );

  const message = buildLinkedSessionContext(store, 'active', 'stakeholder alignment', []);
  assert.ok(message);
  assert.match(message.content, /Interactive Notes/);
  assert.match(message.content, /What should I optimize for first\?/);
  assert.match(message.content, /Options: Stakeholder alignment \/ Speed/);
  assert.match(message.content, /User answered Jenny's follow-up questions/);
});

test('linked session recall ranks tied BM25 matches by newer timestamp deterministically', () => {
  const store = createSessionStore(
    {
      active: { id: 'active', project_id: 'project_general', linked_session_ids: ['linked'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked: { id: 'linked', project_id: 'project_general', title: 'Ranking', updated_at: '2026-03-19T09:00:00.000Z' },
    },
    {
      linked: [
        { role: 'assistant', content: 'apple zebra', timestamp: '2026-03-19T08:00:00.000Z' },
        { role: 'assistant', content: 'zebra apple', timestamp: '2026-03-19T09:00:00.000Z' },
      ],
    }
  );

  const first = buildLinkedSessionContext(store, 'active', 'apple zebra', []);
  const second = buildLinkedSessionContext(store, 'active', 'apple zebra', []);
  assert.ok(first);
  assert.equal(first.content, second.content);
  assert.ok(first.content.indexOf('Assistant: zebra apple') < first.content.indexOf('Assistant: apple zebra'));
});

test('linked session recall clips long excerpts and caps the formatted block at 1200 chars', () => {
  const longText = 'alpha beta gamma delta '.repeat(40);
  const store = createSessionStore(
    {
      active: { id: 'active', project_id: 'project_general', linked_session_ids: ['linked_a', 'linked_b'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked_a: { id: 'linked_a', project_id: 'project_general', title: 'Long A', updated_at: '2026-03-19T09:00:00.000Z' },
      linked_b: { id: 'linked_b', project_id: 'project_general', title: 'Long B', updated_at: '2026-03-19T08:00:00.000Z' },
    },
    {
      linked_a: [
        { role: 'assistant', content: longText, timestamp: '2026-03-19T08:00:00.000Z' },
        { role: 'assistant', content: longText, timestamp: '2026-03-19T08:01:00.000Z' },
      ],
      linked_b: [
        { role: 'assistant', content: longText, timestamp: '2026-03-19T07:00:00.000Z' },
        { role: 'assistant', content: longText, timestamp: '2026-03-19T07:01:00.000Z' },
      ],
    }
  );

  const message = buildLinkedSessionContext(store, 'active', 'alpha beta', []);
  assert.ok(message);
  assert.ok(message.content.length <= 1200);
  assert.match(message.content, /\.\.\./);
});

test('linked session recall rejects cross-project and unknown links before transcript reads', () => {
  const messageReads = [];
  const store = createSessionStore({
    active: {
      id: 'active', project_id: 'project_alpha', linked_session_ids: ['same', 'foreign', 'missing'],
    },
    same: { id: 'same', project_id: 'project_alpha', title: 'Same project' },
    foreign: { id: 'foreign', project_id: 'project_beta', title: 'Foreign project' },
  }, {
    same: [{ role: 'assistant', content: 'shared target', timestamp: '2026-09-09T00:00:00.000Z' }],
    foreign: [{ role: 'assistant', content: 'foreign target', timestamp: '2026-09-09T00:00:00.000Z' }],
  });
  const getMessages = store.getSessionMessages;
  store.getSessionMessages = (sessionId) => {
    messageReads.push(sessionId);
    return getMessages(sessionId);
  };

  const context = buildLinkedSessionContext(store, 'active', 'target', []);
  assert.match(context.content, /Same project/);
  assert.doesNotMatch(context.content, /Foreign project|foreign target/);
  assert.deepEqual(messageReads, ['same']);
  assert.equal(buildLinkedSessionContext(store, 'unknown', 'target', []), null);
});

// Review C-13: the link popover's "Used for recall" marks and this recall pick
// the same chats through one shared selection rule.
function recalledTitles(message) {
  return (message?.content || '').split('\n').filter((line) => line && !line.startsWith('-') && line !== 'Linked session context:');
}

test('linked session recall treats a missing project as the same "no project" and counts a link once', () => {
  const linked = (id, updatedAt, extra = {}) => ({ id, title: `Chat ${id}`, updated_at: updatedAt, ...extra });
  const store = createSessionStore(
    {
      active: { id: 'active', project_id: null, linked_session_ids: ['a', 'a', 'b', 'c', 'd'] },
      a: linked('a', '2026-03-19T09:00:00.000Z'),
      b: linked('b', '2026-03-19T08:00:00.000Z', { project_id: '' }),
      c: linked('c', '2026-03-19T07:00:00.000Z', { project_id: null }),
      d: linked('d', '2026-03-19T06:00:00.000Z'),
    },
    Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, [{ role: 'user', content: 'release plan notes', timestamp: '2026-03-19T05:00:00.000Z' }]]))
  );
  assert.deepEqual(recalledTitles(buildLinkedSessionContext(store, 'active', 'release plan', [])), ['Chat a', 'Chat b', 'Chat c']);
});

test('the shared recall selection is the rule the link popover marks', () => {
  const { selectLinkedRecallSessions } = require('../renderer/shared/string-utils');
  const sessions = {
    x: { id: 'x', project_id: 'p2', updated_at: '2026-09-29T09:00:00Z' },
    b: { id: 'b', project_id: 'p1', updated_at: '2026-09-29T08:00:00Z' },
    c: { id: 'c', project_id: 'p1', updated_at: '2026-09-28T08:00:00Z' },
    d: { id: 'd', project_id: 'p1', updated_at: '2026-09-27T08:00:00Z' },
    e: { id: 'e', project_id: 'p1', updated_at: '2026-09-26T08:00:00Z' },
  };
  const picked = selectLinkedRecallSessions({ project_id: 'p1' }, ['e', 'x', 'd', 'c', 'b'], (id) => sessions[id]);
  assert.deepEqual(picked.map((entry) => entry.id), ['b', 'c', 'd']);
});

// The single excerpt line of a one-unit block.
function excerptOf(message) {
  return message.content.split('\n').find((line) => line.startsWith('- ')).slice(2);
}

function recallStore(messages) {
  return createSessionStore(
    {
      active: { id: 'active', project_id: 'project_general', linked_session_ids: ['linked'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked: { id: 'linked', project_id: 'project_general', title: 'Long Notes', updated_at: '2026-03-19T09:00:00.000Z' },
    },
    { linked: messages }
  );
}

test('linked session recall finds an answer term behind a long user prompt', () => {
  const store = recallStore([
    { role: 'user', content: `${'please review the deployment checklist carefully '.repeat(5)}`.slice(0, 240), timestamp: '2026-03-19T08:00:00.000Z' },
    { role: 'assistant', content: 'The rollback uses the zyxquartz switch before cutover.', timestamp: '2026-03-19T08:01:00.000Z' },
  ]);
  const message = buildLinkedSessionContext(store, 'active', 'zyxquartz', []);
  assert.ok(message);
  assert.match(message.content, /zyxquartz/);
  assert.match(message.content, /Assistant: /);
});

test('linked session recall finds a match late in a long answer and shows it', () => {
  const answer = `${'filler sentence about nothing in particular. '.repeat(30)}Finally the quokkaflag setting decides it. ${'trailing words. '.repeat(30)}`;
  const store = recallStore([{ role: 'assistant', content: answer, timestamp: '2026-03-19T08:00:00.000Z' }]);
  const message = buildLinkedSessionContext(store, 'active', 'quokkaflag', []);
  assert.ok(message);
  assert.match(message.content, /quokkaflag setting decides it/);
  const excerpt = excerptOf(message);
  assert.ok(excerpt.length <= 220);
  assert.match(excerpt, /^Assistant: \.\.\./);
});

test('linked session recall keeps a matching part visible beside a long non-matching part', () => {
  const store = recallStore([
    { role: 'user', content: 'long preamble words '.repeat(30), timestamp: '2026-03-19T08:00:00.000Z' },
    { role: 'assistant', content: `${'filler '.repeat(60)}the wombatkey option is required`, timestamp: '2026-03-19T08:01:00.000Z' },
  ]);
  const message = buildLinkedSessionContext(store, 'active', 'wombatkey', []);
  assert.ok(message);
  assert.match(message.content, /User: long preamble/);
  assert.match(message.content, /wombatkey option is required/);
  const excerpt = excerptOf(message);
  assert.ok(excerpt.length <= 220);
});

test('linked session recall anchors the excerpt on the rarest prompt term, not a common word', () => {
  const answer = `The team met and the notes are in the wiki. ${'The plan is the same as the last one. '.repeat(20)}Set the pelicanvalve option to manual. ${'The rest is the usual. '.repeat(20)}`;
  const store = recallStore([
    // Short neighbours share only the common words, so "the" and "is" weigh little.
    { role: 'assistant', content: 'The build is green.', timestamp: '2026-03-19T07:58:00.000Z' },
    { role: 'assistant', content: 'The deploy is the next step.', timestamp: '2026-03-19T07:59:00.000Z' },
    { role: 'assistant', content: answer, timestamp: '2026-03-19T08:00:00.000Z' },
  ]);
  const message = buildLinkedSessionContext(store, 'active', 'what is the pelicanvalve setting', []);
  assert.ok(message);
  const excerpt = message.content.split('\n').find((line) => line.includes('pelicanvalve'));
  assert.ok(excerpt, `the decisive term is missing:\n${message.content}`);
  assert.ok(excerpt.length <= 222);
  assert.match(excerpt, /pelicanvalve option to manual/);
});

test('linked session recall renders short pairs exactly as before', () => {
  const store = recallStore([
    { role: 'user', content: 'Draft the release plan.', timestamp: '2026-03-19T08:00:00.000Z' },
    { role: 'assistant', content: 'Release plan is ready.', timestamp: '2026-03-19T08:01:00.000Z' },
  ]);
  const message = buildLinkedSessionContext(store, 'active', 'release plan', []);
  assert.equal(
    message.content,
    'Linked session context:\nLong Notes\n- User: Draft the release plan. Assistant: Release plan is ready.'
  );
});

test('linked session recall keeps the whole block within MAX_TOTAL_CHARS with match windows', () => {
  const sessions = { active: { id: 'active', project_id: 'p', linked_session_ids: ['a', 'b', 'c'] } };
  const messages = {};
  for (const id of ['a', 'b', 'c']) {
    sessions[id] = { id, project_id: 'p', title: `Session ${id}`, updated_at: '2026-03-19T09:00:00.000Z' };
    messages[id] = [
      { role: 'user', content: 'x '.repeat(300), timestamp: '2026-03-19T08:00:00.000Z' },
      { role: 'assistant', content: `${'pad '.repeat(100)}needleterm ${'tail '.repeat(100)}`, timestamp: '2026-03-19T08:01:00.000Z' },
      { role: 'assistant', content: `${'more '.repeat(100)}needleterm again ${'end '.repeat(100)}`, timestamp: '2026-03-19T08:02:00.000Z' },
    ];
  }
  const message = buildLinkedSessionContext(createSessionStore(sessions, messages), 'active', 'needleterm', []);
  assert.ok(message);
  assert.ok(message.content.length <= 1200);
  assert.match(message.content, /needleterm/);
});
