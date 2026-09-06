const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TIME_DIVIDER_GAP_MS,
  buildTimeDividerMap,
  buildTimeDividerMarkup,
  buildTimelineDividerInputSignature,
  deriveTimelineTimeDividers,
} = require('../renderer/chat/renderer-chat-timeline-orientation-utils');

function node(id, role, timestamp, children = [], kind = '') {
  return {
    id,
    role,
    kind,
    message: {
      id,
      role,
      kind,
      timestamp,
      content: id,
    },
    children,
  };
}

test('F7: derives dividers from visible thread-tree order at the five-minute threshold', () => {
  const tree = {
    roots: [
      node('u1', 'user', '2026-05-12T10:00:00.000Z', [
        node('a1', 'assistant', '2026-05-12T10:03:00.000Z'),
      ]),
      node('u2', 'user', '2026-05-12T10:08:00.000Z'),
      node('a2', 'assistant', '2026-05-12T12:15:00.000Z'),
    ],
  };

  const dividers = deriveTimelineTimeDividers(tree);

  assert.equal(DEFAULT_TIME_DIVIDER_GAP_MS, 5 * 60 * 1000);
  assert.deepEqual(dividers.map((divider) => ({
    beforeMessageId: divider.beforeMessageId,
    previousMessageId: divider.previousMessageId,
    label: divider.label,
    ariaLabel: divider.ariaLabel,
  })), [
    {
      beforeMessageId: 'u2',
      previousMessageId: 'a1',
      label: '5 min later',
      ariaLabel: '5 minutes later',
    },
    {
      beforeMessageId: 'a2',
      previousMessageId: 'u2',
      label: '2 hr later',
      ariaLabel: '2 hours later',
    },
  ]);
});

test('F7: malformed, missing, and backward timestamps reset adjacency', () => {
  const tree = {
    roots: [
      node('u1', 'user', '2026-05-12T10:00:00.000Z'),
      node('a1', 'assistant', 'not-a-date'),
      node('u2', 'user', '2026-05-12T10:20:00.000Z'),
      node('a2', 'assistant', '2026-05-12T10:10:00.000Z'),
      node('u3', 'user', '2026-05-12T10:40:00.000Z'),
      node('a3', 'assistant', ''),
      node('u4', 'user', '2026-05-12T11:10:00.000Z'),
    ],
  };

  const dividers = deriveTimelineTimeDividers(tree);

  assert.deepEqual(dividers.map((divider) => divider.beforeMessageId), []);
});

test('F7: skips special non-chat rows and maps dividers by target message id', () => {
  const tree = {
    roots: [
      node('u1', 'user', '2026-05-12T10:00:00.000Z'),
      node('batch1', 'assistant', '2026-05-12T11:00:00.000Z', [], 'question_batch'),
      node('a1', 'assistant', '2026-05-12T11:05:00.000Z'),
    ],
  };

  const dividers = deriveTimelineTimeDividers(tree);
  const dividerMap = buildTimeDividerMap(dividers);

  assert.deepEqual(dividers.map((divider) => divider.beforeMessageId), ['a1']);
  assert.equal(dividerMap.get('a1').label, '1 hr later');
});

test('F7: hidden collapsed descendants do not reset visible adjacency', () => {
  const tree = {
    roots: [
      node('u1', 'user', '2026-05-12T10:00:00.000Z', [
        node('hidden1', 'assistant', 'not-a-date'),
      ]),
      node('u2', 'user', '2026-05-12T10:10:00.000Z'),
    ],
  };

  const dividers = deriveTimelineTimeDividers(tree, {
    includeChildren(currentNode) {
      return currentNode.id !== 'u1';
    },
  });

  assert.deepEqual(dividers.map((divider) => divider.beforeMessageId), ['u2']);
});

test('F7: input signature tracks timestamp changes without deriving labels', () => {
  assert.equal(
    buildTimelineDividerInputSignature([
      { timestamp: '2026-05-12T10:00:00.000Z' },
      { timestamp: 'not-a-date' },
      { timestamp: '2026-05-12T10:05:00.000Z' },
    ]),
    '1778580000000\u001f\u001f1778580300000'
  );
});

test('F7: divider markup is non-message, search-skipped, and screen-reader labeled', () => {
  const html = buildTimeDividerMarkup({
    beforeMessageId: 'a"1',
    label: '1 day later',
    ariaLabel: '1 day later',
  }, {
    escapeHtml(value) {
      return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    },
  });

  assert.match(html, /role="separator"/);
  assert.match(html, /data-timeline-divider="time-gap"/);
  assert.match(html, /data-before-message-id="a&quot;1"/);
  assert.match(html, /data-search-skip="true"/);
  assert.match(html, /aria-label="1 day later"/);
  assert.equal(html.includes('chat-entry'), false);
});
