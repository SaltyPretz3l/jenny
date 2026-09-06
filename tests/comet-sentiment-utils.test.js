const test = require('node:test');
const assert = require('node:assert/strict');

const cometSentimentUtils = require('../comet/sentiment-utils');

test('inferSentimentFromText detects positive, negative, and clarifying tones', () => {
  assert.deepEqual(
    cometSentimentUtils.inferSentimentFromText('Glad to help. I fixed that for you.'),
    { sentiment: 'positive', expression: 'warm' }
  );
  assert.deepEqual(
    cometSentimentUtils.inferSentimentFromText('Sorry, I cannot complete that because the command failed.'),
    { sentiment: 'negative', expression: 'concerned' }
  );
  assert.deepEqual(
    cometSentimentUtils.inferSentimentFromText('Could you clarify which file you want me to edit?'),
    { sentiment: 'neutral', expression: 'confused' }
  );
});

test('inferSentimentFromText falls back to a neutral idle expression', () => {
  assert.deepEqual(
    cometSentimentUtils.inferSentimentFromText(''),
    { sentiment: 'neutral', expression: 'idle' }
  );
  assert.deepEqual(
    cometSentimentUtils.inferSentimentFromText('The file has three columns.'),
    { sentiment: 'neutral', expression: 'idle' }
  );
});
