const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranscriptActionRenderer } = require('../renderer/chat/renderer-transcript-actions');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHoverActionModel(overrides) {
  return {
    showHoverRow: true,
    showMeta: false,
    actions: {
      branch: { visible: true, enabled: true },
      regenerate: { visible: true, enabled: true },
      copy: { visible: true, enabled: true },
      elaborate: { visible: true, enabled: true },
    },
    ...overrides,
  };
}

function createRenderer(overrides) {
  return createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel(overrides),
  });
}

test('hover-action buttons carry descriptive aria-labels (E2)', () => {
  const renderer = createRenderer();
  const html = renderer.renderMessageHoverRow({ id: 'assistant_1' }, {}, '');
  // E2: aria-label is now descriptive, not just the capitalized action name.
  assert.match(html, /aria-label="Regenerate this response"/);
  assert.match(html, /aria-label="Branch from here"/);
  assert.match(html, /aria-label="Copy message to clipboard"/);
  assert.match(html, /aria-label="Ask Jenny to elaborate"/);
});

test('hover-action SVG icons carry aria-hidden so labels are the only announced text (E2)', () => {
  const renderer = createRenderer();
  const html = renderer.renderMessageHoverRow({ id: 'assistant_2' }, {}, '');
  // Four SVG icons, each aria-hidden so screen readers don't double-announce
  // a decoration alongside the button label.
  const ariaHiddenSvgMatches = html.match(/<svg[^>]*aria-hidden="true"/g) || [];
  assert.equal(ariaHiddenSvgMatches.length, 4, 'expected four aria-hidden SVG icons');
});

test('disabled hover-action labels are extended with the disabled reason (E2)', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      actions: {
        branch: { visible: true, enabled: true },
        regenerate: { visible: true, enabled: false, reason: 'still streaming' },
        copy: { visible: true, enabled: true },
        elaborate: { visible: true, enabled: true },
      },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'assistant_3' }, {}, '');
  assert.match(html, /aria-label="Regenerate this response \(still streaming\)"/);
  assert.match(html, /disabled aria-disabled="true"/);
});

test('renders one button per visible action (E2)', () => {
  const renderer = createRenderer();
  const html = renderer.renderMessageHoverRow({ id: 'assistant_4' }, {}, '');
  const buttonMatches = html.match(/class="chat-hover-action"/g) || [];
  assert.equal(buttonMatches.length, 4, 'expected four hover-action buttons');
});

test('omits hidden actions (E2)', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      actions: {
        branch: { visible: false, enabled: true },
        regenerate: { visible: false, enabled: true },
        copy: { visible: true, enabled: true },
        elaborate: { visible: false, enabled: true },
      },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'assistant_5' }, {}, '');
  assert.doesNotMatch(html, /data-message-action="regenerate"/);
  assert.doesNotMatch(html, /data-message-action="branch"/);
  assert.doesNotMatch(html, /data-message-action="elaborate"/);
  assert.match(html, /data-message-action="copy"/);
});

test('F3: renders branch button between edit and regenerate when visible', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      actions: {
        edit: { visible: true, enabled: true },
        branch: { visible: true, enabled: true },
        regenerate: { visible: true, enabled: true },
        copy: { visible: true, enabled: true },
        elaborate: { visible: false, enabled: false },
      },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'user_1' }, {}, '');
  assert.match(html, /data-message-action="branch"/);
  assert.match(html, /aria-label="Branch from here"/);
  assert.match(html, /title="Branch from here \(Ctrl\+Shift\+B\)"/);
  const editIdx = html.indexOf('data-message-action="edit"');
  const branchIdx = html.indexOf('data-message-action="branch"');
  const regenerateIdx = html.indexOf('data-message-action="regenerate"');
  assert.ok(editIdx >= 0 && branchIdx > editIdx && regenerateIdx > branchIdx);
});

// F2 — edit button rendering

test('F2: renders the edit button on user-row hover with aria-label + edit tooltip', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      actions: {
        edit: { visible: true, enabled: true },
        branch: { visible: true, enabled: true },
        regenerate: { visible: false, enabled: false },
        copy: { visible: true, enabled: true },
        elaborate: { visible: false, enabled: false },
      },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'user_1' }, {}, '');
  assert.match(html, /data-message-action="edit"/);
  assert.match(html, /aria-label="Edit your message"/);
  assert.match(html, /title="Edit and resend \(Enter\)"/);
  // Edit is the first action — sits before copy in the rendered order.
  const editIdx = html.indexOf('data-message-action="edit"');
  const copyIdx = html.indexOf('data-message-action="copy"');
  assert.ok(editIdx >= 0 && copyIdx > editIdx, 'edit must render before copy on user rows');
});

test('F2: edit button is omitted for assistant rows', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      actions: {
        edit: { visible: false, enabled: false },
        branch: { visible: true, enabled: true },
        regenerate: { visible: true, enabled: true },
        copy: { visible: true, enabled: true },
        elaborate: { visible: true, enabled: true },
      },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'assistant_6' }, {}, '');
  assert.doesNotMatch(html, /data-message-action="edit"/);
});

test('F2: disabled edit button surfaces the reason in its aria-label', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      actions: {
        edit: { visible: true, enabled: false, reason: 'Finish the current edit first.' },
        branch: { visible: true, enabled: true },
        regenerate: { visible: false, enabled: false },
        copy: { visible: true, enabled: true },
        elaborate: { visible: false, enabled: false },
      },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'user_7' }, {}, '');
  assert.match(html, /aria-label="Edit your message \(Finish the current edit first.\)"/);
  assert.match(html, /title="Finish the current edit first\."/);
});

test('F2: edit button SVG icon is aria-hidden so the descriptive label is the only announced text', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      actions: {
        edit: { visible: true, enabled: true },
        branch: { visible: false, enabled: false },
        regenerate: { visible: false, enabled: false },
        copy: { visible: false, enabled: false },
        elaborate: { visible: false, enabled: false },
      },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'user_8' }, {}, '');
  const ariaHiddenSvgMatches = html.match(/<svg[^>]*aria-hidden="true"/g) || [];
  assert.equal(ariaHiddenSvgMatches.length, 1, 'edit button should render one aria-hidden SVG');
});

test('F8: supplied hover meta renders even when the action model hides default meta', () => {
  const renderer = createRenderer({ showMeta: false });
  const html = renderer.renderMessageHoverRow(
    { id: 'user_token_meta' },
    {},
    '~2 tokens est. · ~2 cumulative'
  );

  assert.match(html, /<div class="chat-hover-meta">~2 tokens est\. · ~2 cumulative<\/div>/);
  assert.doesNotMatch(html, /chat-hover-meta-empty/);
});

test('F8: empty supplied hover meta stays hidden when the action model hides meta', () => {
  const renderer = createRenderer({ showMeta: false });
  const html = renderer.renderMessageHoverRow({ id: 'user_empty_meta' }, {}, '');

  assert.match(html, /chat-hover-meta chat-hover-meta-empty/);
});

test('SP-19: complete unsaved replies render a persistent text badge and three native actions', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      unsavedReply: { visible: true, artifactId: 'repair_7' },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'assistant_unsaved' }, {}, '');

  assert.match(html, />Unsaved<\/span>/);
  assert.match(html, /Not yet saved to chat history\./);
  assert.match(html, /<button[^>]+data-unsaved-reply-action="retry"[^>]*>Retry save<\/button>/);
  assert.match(html, /<button[^>]+data-unsaved-reply-action="copy"[^>]*>Copy<\/button>/);
  assert.match(html, /<button[^>]+data-unsaved-reply-action="discard"[^>]*>Discard<\/button>/);
});

test('SP-19: missing repair identity keeps Copy available and disables recovery actions with a reason', () => {
  const renderer = createTranscriptActionRenderer({
    escapeHtml,
    buildMessageActionModel: () => buildHoverActionModel({
      unsavedReply: { visible: true, artifactId: '' },
    }),
  });
  const html = renderer.renderMessageHoverRow({ id: 'assistant_transient' }, {}, '');
  const copyButton = html.match(/<button[^>]+data-unsaved-reply-action="copy"[^>]*>/)?.[0] || '';

  assert.match(html, /<button[^>]+disabled[^>]+data-unsaved-reply-action="retry"/);
  assert.match(html, /<button[^>]+disabled[^>]+data-unsaved-reply-action="discard"/);
  assert.match(html, /repair record could not be saved/);
  assert.doesNotMatch(copyButton, / disabled/);
});
