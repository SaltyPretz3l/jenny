const inspector = require('node:inspector');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendPersistedReasoningEntry,
  sanitizePersistedReasoningText,
} = require('../services/backend/chat-stream-reasoning');
const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
} = require('./helpers/managed-runtime-notification-harness');

function postInspector(session, method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function countSanitizerCalls(run) {
  const session = new inspector.Session();
  session.connect();
  try {
    await postInspector(session, 'Profiler.enable');
    await postInspector(session, 'Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true,
    });
    run();
    const { result } = await postInspector(session, 'Profiler.takePreciseCoverage');
    const script = result.find((entry) => entry.url.endsWith('/chat-stream-reasoning-sanitize.js'));
    const sanitizer = script?.functions.find(
      (entry) => entry.functionName === 'sanitizePersistedReasoningText'
    );
    return sanitizer?.ranges[0]?.count || 0;
  } finally {
    session.disconnect();
  }
}

function chunkFixture(seed, fixture) {
  const chunks = [];
  let offset = 0;
  let state = seed >>> 0;
  while (offset < fixture.length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const chunkLength = 1 + (state % 13);
    chunks.push(fixture.slice(offset, offset + chunkLength));
    offset += chunkLength;
  }
  return chunks;
}

test('incremental reasoning sanitize matches whole-text sanitize across random chunkings', () => {
  const fixture = [
    'Preface <think>Plan\r\n',
    'alpha  \n\n\n\nbeta\t \n',
    'gamma</think>\n',
    '_thought: finish cleanly',
  ].join('');

  for (let seed = 1; seed <= 50; seed += 1) {
    let entries = [];
    let rawTailText = '';
    let sanitizedTailText = '';
    let accumulated = '';
    for (const chunk of chunkFixture(seed, fixture)) {
      accumulated += chunk;
      const result = appendPersistedReasoningEntry(entries, chunk, '2026-08-31T00:00:00.000Z', {
        coalesceTail: true,
        rawTailText,
        sanitizedTailText,
      });
      entries = result.entries;
      rawTailText = result.rawText;
      sanitizedTailText = result.sanitizedTailText;
      assert.equal(entries.at(-1)?.text || '', sanitizePersistedReasoningText(accumulated).text);
    }
  }
});

test('post-cap reasoning deltas do not call the sanitizer', async () => {
  let result = appendPersistedReasoningEntry([], 'x'.repeat(50_000), 't0', {
    coalesceTail: true,
  });

  const sanitizerCallCount = await countSanitizerCalls(() => {
    for (let index = 0; index < 400; index += 1) {
      result = appendPersistedReasoningEntry(result.entries, 'y', `t${index + 1}`, {
        coalesceTail: true,
        rawTailText: result.rawText,
        sanitizedTailText: result.sanitizedTailText,
      });
    }
  });

  assert.equal(sanitizerCallCount, 0);
});

test('post-cap early-out honors prior entries: a saturated multi-entry turn stops sanitizing and stops churning', async () => {
  const maxTotalChars = 65_536;
  const priorEntry = { id: 'phase_0', text: 'p'.repeat(30_000), timestamp: 't0', thinkingId: 'phase_0' };
  // A phase break appends the new tail as its own entry (non-coalesced), then
  // later deltas coalesce into it - the checkpoint-continuation shape.
  // Saturate the tail's SHARE of the budget (cap - prior), not the whole cap.
  let result = appendPersistedReasoningEntry([priorEntry], 'x'.repeat(maxTotalChars - 30_000 + 500), 't1', {
    maxTotalChars,
    thinkingId: 'phase_1',
  });
  assert.equal(result.entries.length, 2, 'prior phase entry is preserved');
  assert.equal(result.truncated, true, 'tail share is saturated');
  const settledTailText = result.entries.at(-1).text;

  const sanitizerCallCount = await countSanitizerCalls(() => {
    for (let index = 0; index < 200; index += 1) {
      result = appendPersistedReasoningEntry(result.entries, 'y', `t${index + 2}`, {
        coalesceTail: true,
        maxTotalChars,
        rawTailText: result.rawText,
        sanitizedTailText: result.sanitizedTailText,
      });
    }
  });

  assert.equal(sanitizerCallCount, 0, 'no sanitize passes once the tail share is exhausted');
  assert.equal(result.entries.at(-1).text, settledTailText, 'the truncation marker stops churning');
  assert.equal(result.entry, null, 'no per-delta entry emission after saturation');
});

test('fresh-entry dedup compares the final truncated text', () => {
  const filler = { id: 'filler', text: 'f'.repeat(24_000), timestamp: 't0' };
  const first = appendPersistedReasoningEntry(
    [filler],
    'z'.repeat(25_000),
    't1',
    { coalesceTail: false }
  );
  const duplicate = appendPersistedReasoningEntry(
    [{ ...first.entry, id: 'existing-truncated' }],
    'z'.repeat(25_000),
    't2',
    { coalesceTail: false }
  );

  assert.equal(first.truncated, true);
  assert.equal(duplicate.truncated, true);
  assert.equal(duplicate.entry, null);
});

test('reasoning truncation warns once, reaches IPC once, and emits nothing post-cap', () => {
  const ctx = makeCtx();
  const dependencies = {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  };
  handleNotification(ctx, {
    method: 'chat.thinking',
    params: { kind: 'reasoning', delta: 'x'.repeat(50_000), thinking_id: 'think-cap' },
  }, dependencies);

  const initialEmitCount = callsOf(ctx, 'emitChatStream').length;
  for (let index = 0; index < 400; index += 1) {
    handleNotification(ctx, {
      method: 'chat.thinking',
      params: { kind: 'reasoning', delta: 'y', thinking_id: 'think-cap' },
    }, dependencies);
  }

  const warnings = callsOf(ctx, 'serviceLog').filter(
    (entry) => entry.code === 'chat.reasoning_truncated'
  );
  assert.equal(warnings.length, 1);
  assert.equal(initialEmitCount, 1);
  assert.equal(callsOf(ctx, 'emitChatStream').length, initialEmitCount);
  assert.equal(callsOf(ctx, 'emitChatStream')[0].payload.reasoning.truncated, true);
});
