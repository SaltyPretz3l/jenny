const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLinkedSessionContext } = require('../services/backend/linked-session-recall');

function createSessionStore(sessions, messagesBySession = {}) {
  return {
    getSession(sessionId) {
      return sessions[sessionId] || null;
    },
    getSessionMessages(sessionId) {
      return messagesBySession[sessionId] || [];
    },
  };
}

test('linked session recall returns null when the active session has no links', () => {
  const store = createSessionStore({
    active: { id: 'active', linked_session_ids: [] },
  });
  assert.equal(buildLinkedSessionContext(store, 'active', 'plan this', []), null);
});

test('linked session recall excludes tool kinds and combines adjacent user assistant turns', () => {
  const store = createSessionStore(
    {
      active: { id: 'active', linked_session_ids: ['linked'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked: { id: 'linked', title: 'Linked Notes', updated_at: '2026-03-19T09:00:00.000Z' },
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
      active: { id: 'active', linked_session_ids: ['linked'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked: { id: 'linked', title: 'Interactive Notes', updated_at: '2026-03-19T09:00:00.000Z' },
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
      active: { id: 'active', linked_session_ids: ['linked'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked: { id: 'linked', title: 'Ranking', updated_at: '2026-03-19T09:00:00.000Z' },
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
      active: { id: 'active', linked_session_ids: ['linked_a', 'linked_b'], updated_at: '2026-03-19T10:00:00.000Z' },
      linked_a: { id: 'linked_a', title: 'Long A', updated_at: '2026-03-19T09:00:00.000Z' },
      linked_b: { id: 'linked_b', title: 'Long B', updated_at: '2026-03-19T08:00:00.000Z' },
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
