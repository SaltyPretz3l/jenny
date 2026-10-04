// CMC-008: the summary-source omission count rides the live context_compacted
// stream event onto the pending message's compaction entry.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-stream-handler-harness');

const SESSION = 'session-cmc8';
const STREAM = 'stream-cmc8';

test('live: summarySourceDroppedMessages lands on the pending message compaction entry', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: SESSION, streamId: STREAM });
  await harness.emit({
    type: 'context_compacted', sessionId: SESSION, streamId: STREAM, strategy: 'full',
    tokensBefore: 9000, tokensAfter: 3000, compactionPhase: 'preflight', summaryStatus: 'created',
    inputComplete: true, summarySourceDroppedMessages: 12,
  });
  await harness.emit({
    type: 'context_compacted', sessionId: SESSION, streamId: STREAM, strategy: 'full',
    tokensBefore: 8000, tokensAfter: 2900, compactionPhase: 'tool_loop', summaryStatus: 'created',
  });

  const message = harness.state.messagesBySession.get(SESSION).find((entry) => entry.streamId === STREAM);
  assert.equal(message.context_compactions[0].summarySourceDroppedMessages, 12);
  assert.equal(message.context_compactions[0].inputComplete, true);
  assert.equal(message.context_compactions[1].summarySourceDroppedMessages, 0);
});
