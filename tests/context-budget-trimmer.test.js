'use strict';

// Deterministic coverage for the context-budget trimmer
// (services/backend/context-budget-trimmer.js): given oversized blocks and a
// small effective budget, the lowest-priority blocks are dropped / the
// highest-priority shrinkable block is shrunk so the kept set fits — with zero
// model calls. On an unknown/large budget the trim is inert.

const test = require('node:test');
const assert = require('node:assert/strict');

const parityFixture = require('./fixtures/context-budget-parity.json');

const {
  CHARS_PER_TOKEN,
  DEFAULT_SYSTEM_RESERVE_TOKENS,
  estimateTokensFromChars,
  estimateMessagesTokens,
  computeEffectiveContextBudget,
  closeDanglingFence,
  shrinkBlockContent,
  trimContextBlocks,
} = require('../services/backend/context-budget-trimmer');

const MESSAGE_OVERHEAD = 4; // per-message framing in estimateMessagesTokens

function blockOf(kind, priority, chars, shrinkable) {
  return { kind, priority, shrinkable, content: 'X'.repeat(chars) };
}

function totalKeptTokens(kept) {
  let total = 0;
  for (const entry of kept.values()) {
    total += entry.tokens;
  }
  return total;
}

test('estimateTokensFromChars uses the ~4-chars/token heuristic', () => {
  assert.equal(estimateTokensFromChars(''), 0);
  assert.equal(estimateTokensFromChars('abcd'), 1);
  assert.equal(estimateTokensFromChars('abcde'), 2); // ceil(5/4)
  assert.equal(estimateTokensFromChars('X'.repeat(4000)), 1000);
});

test('estimateMessagesTokens mirrors content/4 plus per-message overhead', () => {
  // two messages: 8 chars => 2 tokens content, + 4 overhead each = 10
  const tokens = estimateMessagesTokens([
    { role: 'user', content: 'abcdefgh' },
    { role: 'assistant', content: '' },
  ]);
  assert.equal(tokens, 2 + 4 + 0 + 4);
});

test('computeEffectiveContextBudget matches the shared sidecar parity fixture', () => {
  // The answer and the compaction summary are separate requests, so only the
  // larger reservation is held back. The Python twin asserts the same file.
  assert.ok(parityFixture.cases.length > 0);
  for (const { context_window: window, effective_context: expected } of parityFixture.cases) {
    assert.equal(computeEffectiveContextBudget(window), expected, `window ${window}`);
  }
});

test('a small active-file block survives an 8192 window with 2800 history tokens', () => {
  // Same arithmetic as chat-stream-context-assembly.js availableForBlocks.
  const history = [{ role: 'user', content: 'h'.repeat((2800 - MESSAGE_OVERHEAD) * CHARS_PER_TOKEN) }];
  const consumed = estimateMessagesTokens(history);
  assert.equal(consumed, 2800);
  const effective = computeEffectiveContextBudget(8192);
  const available = Math.max(0, effective - consumed - DEFAULT_SYSTEM_RESERVE_TOKENS);
  assert.equal(available, 1844);
  const block = blockOf('active_file', 100, 250 * CHARS_PER_TOKEN, true); // 250 tokens
  const { kept } = trimContextBlocks([block], available);
  assert.ok(kept.has('active_file'), 'active_file block kept');
  assert.equal(kept.get('active_file').content, block.content);
});

test('computeEffectiveContextBudget returns null for unknown/invalid windows', () => {
  assert.equal(computeEffectiveContextBudget(0), null);
  assert.equal(computeEffectiveContextBudget(undefined), null);
  assert.equal(computeEffectiveContextBudget('nope'), null);
  assert.equal(computeEffectiveContextBudget(-5), null);
});

test('trim is inert when the budget is unknown (every block kept unchanged)', () => {
  const blocks = [
    blockOf('active_file', 100, 40000, true),
    blockOf('git', 80, 40000, true),
  ];
  const { kept, decisions } = trimContextBlocks(blocks, null);
  assert.equal(kept.size, 2);
  assert.ok(kept.get('active_file'));
  assert.ok(kept.get('git'));
  assert.ok(decisions.every((d) => d.action === 'keep'));
  // "unchanged" is the whole claim, and size/truthiness do not test it: the
  // trimmer could rewrite every block's body and still pass the three above.
  assert.equal(kept.get('active_file').content, blocks[0].content);
  assert.equal(kept.get('git').content, blocks[1].content);
});

test('drops the lowest-priority blocks first to fit a small budget', () => {
  // Budget 1000 tokens (4000 chars). Each block is 1000 tokens.
  const blocks = [
    blockOf('active_file', 100, 4000, true),
    blockOf('git', 80, 4000, true),
    blockOf('codebase', 60, 4000, true),
    blockOf('linked_session', 50, 4000, true),
  ];
  const { kept } = trimContextBlocks(blocks, 1000);
  // Only the single highest-priority block fits whole.
  assert.ok(kept.has('active_file'));
  assert.ok(!kept.has('git'));
  assert.ok(!kept.has('codebase'));
  assert.ok(!kept.has('linked_session'));
  assert.ok(totalKeptTokens(kept) <= 1000);
});

test('shrinks the highest-priority shrinkable block when it alone overflows', () => {
  const blocks = [blockOf('active_file', 100, 40000, true)]; // 10000 tokens
  const { kept, decisions } = trimContextBlocks(blocks, 500);
  const entry = kept.get('active_file');
  assert.ok(entry);
  assert.equal(entry.shrunk, true);
  assert.ok(entry.tokens <= 500);
  assert.ok(entry.content.includes('trimmed to fit'));
  assert.equal(decisions.find((d) => d.kind === 'active_file').action, 'shrink');
});

test('atomic (non-shrinkable) blocks are dropped rather than truncated', () => {
  const atomic = { kind: 'policy_block', priority: 90, shrinkable: false, content: 'R'.repeat(4000) };
  const tiny = { kind: 'linked_session', priority: 50, shrinkable: true, content: 'L'.repeat(40) };
  // Budget too small for the atomic block (1000 tokens) but big enough for tiny (10).
  const { kept } = trimContextBlocks([atomic, tiny], 100);
  assert.ok(!kept.has('policy_block')); // dropped whole, never truncated
  assert.ok(kept.has('linked_session')); // slipped into the leftover space
});

test('keeps everything that fits and never exceeds the budget', () => {
  const blocks = [
    blockOf('active_file', 100, 800, true), // 200 tokens
    blockOf('git', 80, 800, true), // 200 tokens
    blockOf('codebase', 60, 4000, true), // 1000 tokens -> shrinks to remaining
  ];
  const { kept } = trimContextBlocks(blocks, 500);
  assert.ok(kept.has('active_file'));
  assert.ok(kept.has('git'));
  // 500 - 200 - 200 = 100 left; codebase shrinks to ~100 tokens. The comment said
  // so but nothing required it: dropping codebase entirely also satisfies the
  // budget assertion below, which is the cheapest way to "fit".
  assert.ok(kept.has('codebase'), 'codebase must survive by shrinking, not by being dropped');
  assert.equal(kept.get('codebase').shrunk, true);
  assert.ok(kept.get('codebase').tokens > 0);
  assert.ok(totalKeptTokens(kept) <= 500);
});

test('shrinkBlockContent preserves the header once and marks the truncation', () => {
  const content = '[Active editor context]\n' + 'line\n'.repeat(1000);
  const shrunk = shrinkBlockContent(content, 50);
  assert.ok(shrunk.startsWith('[Active editor context]'));
  assert.ok(shrunk.includes('trimmed to fit'));
  assert.ok(shrunk.length <= 50 * CHARS_PER_TOKEN);
  // The header must appear exactly once (the body is sliced AFTER it, not from 0).
  assert.equal(shrunk.split('[Active editor context]').length - 1, 1, 'header not duplicated');
});

test('shrinkBlockContent closes a code fence opened in the kept body', () => {
  const content = '[Active editor context]\nFile: x.js\n```javascript\n'
    + 'doThing();\n'.repeat(1000) + '```';
  const shrunk = shrinkBlockContent(content, 40);
  const fenceLines = shrunk.split('\n').filter((line) => /^`{3,}/.test(line));
  assert.equal(fenceLines.length % 2, 0, 'fences are balanced (open + injected close)');
  assert.ok(shrunk.includes('trimmed to fit'));
});

test('shrinkBlockContent reserves the actual delimiter length for long fences', () => {
  for (const fenceLength of [12, 100]) {
    const fence = '`'.repeat(fenceLength);
    const content = `[Active editor context]\n${fence}javascript\n${'x'.repeat(1000)}`;
    const shrunk = shrinkBlockContent(content, 50);
    const fenceLines = shrunk.split('\n').filter((line) => /^`{3,}/.test(line));
    assert.ok(shrunk.length <= 50 * CHARS_PER_TOKEN);
    assert.equal(fenceLines.length % 2, 0, `fence length ${fenceLength} must remain balanced`);
    assert.ok(shrunk.includes('trimmed to fit'));
  }
});

test('closeDanglingFence balances an open fence and leaves closed text alone', () => {
  assert.equal(closeDanglingFence('```\ncode'), '```\ncode\n```');
  assert.equal(closeDanglingFence('```\ncode\n```'), '```\ncode\n```');
  assert.equal(closeDanglingFence('no fence here'), 'no fence here');
  assert.equal(closeDanglingFence('````\ncode'), '````\ncode\n````'); // longer delimiter
});

test('trim ordering is deterministic regardless of input order', () => {
  const a = [
    blockOf('linked_session', 50, 4000, true),
    blockOf('active_file', 100, 4000, true),
    blockOf('git', 80, 4000, true),
  ];
  const b = [
    blockOf('git', 80, 4000, true),
    blockOf('active_file', 100, 4000, true),
    blockOf('linked_session', 50, 4000, true),
  ];
  const keptA = trimContextBlocks(a, 1000).kept;
  const keptB = trimContextBlocks(b, 1000).kept;
  assert.deepEqual([...keptA.keys()].sort(), [...keptB.keys()].sort());
  assert.ok(keptA.has('active_file') && keptB.has('active_file'));
});
