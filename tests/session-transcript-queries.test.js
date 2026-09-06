const test = require('node:test');
const assert = require('node:assert/strict');

const {
  firstSentence,
  resolveSessionTranscriptAnswer,
} = require('../services/backend/session-transcript-queries');

test('resolveSessionTranscriptAnswer returns the first assistant sentence from question batch intro text', () => {
  const answer = resolveSessionTranscriptAnswer({
    prompt: 'Could you tell me the first sentence you sent to me this session?',
    messages: [
      { role: 'user', content: 'Please inspect your available tools.' },
      {
        role: 'assistant',
        kind: 'question_batch',
        content: [
          'Jenny asked follow-up questions:',
          "I'd love to show you what I can do!",
          '',
          '1. Which tool should I demonstrate?',
          'Options: Search / File',
        ].join('\n'),
        interactive_batch: {
          intro_text: "I'd love to show you what I can do!",
          questions: [],
        },
      },
      {
        role: 'assistant',
        content: 'Since I do not have a menu, I can inspect the harness.',
      },
      {
        role: 'user',
        content: 'Could you tell me the first sentence you sent to me this session?',
      },
    ],
  });

  assert.equal(
    answer,
    'The first sentence I sent to you this session was: "I\'d love to show you what I can do!"'
  );
});

test('resolveSessionTranscriptAnswer ignores broad non-transcript prompts', () => {
  const answer = resolveSessionTranscriptAnswer({
    prompt: 'Can you summarize what we discussed?',
    messages: [
      { role: 'assistant', content: 'Hello there. Second sentence.' },
    ],
  });

  assert.equal(answer, null);
});

test('quoted terminal punctuation ends the first sentence without malformed answer quoting', () => {
  const content = 'She said "Hello." Goodbye.';
  assert.equal(firstSentence(content), 'She said "Hello."');
  assert.equal(resolveSessionTranscriptAnswer({
    prompt: 'What was the first sentence you said in this session?',
    messages: [{ role: 'assistant', content }],
  }), 'The first sentence I sent to you this session was: "She said \\"Hello.\\""');
});
