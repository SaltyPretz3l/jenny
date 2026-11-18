const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

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

test('Branch and Elaborate show words beside their icons', (t) => {
  const actions = Object.fromEntries(['edit', 'branch', 'regenerate', 'copy', 'elaborate']
    .map((action) => [action, { visible: true, enabled: true }]));
  const html = createRenderer({ actions }).renderMessageHoverRow({ id: 'all_actions' }, {}, '');
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  for (const [action, word] of [['branch', 'Branch'], ['elaborate', 'Elaborate']]) {
    assert.equal(dom.window.document.querySelector(`[data-message-action="${action}"] .chat-hover-action-word`).textContent, word);
  }
  for (const action of ['edit', 'regenerate', 'copy']) {
    assert.equal(dom.window.document.querySelector(`[data-message-action="${action}"] .chat-hover-action-word`), null);
  }
});

test('hover meta shows the short label as its name and keeps the full label as the tooltip', (t) => {
  const full = 'Completed 3:41 PM · m · ~412 tokens est. · ~2.6k cumulative text tokens est.';
  const short = '3:41 PM · m · 412 tokens';
  const html = createRenderer({ showMeta: true }).renderMessageHoverRow({ id: 'short_meta' }, {}, full, short);
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const meta = dom.window.document.querySelector('.chat-hover-meta');
  assert.equal(meta.textContent, short);
  assert.equal(meta.getAttribute('title'), full);
  // Label-in-name: no aria-label, so the visible text is the accessible name.
  assert.equal(meta.hasAttribute('aria-label'), false);
  // No short label: the full label stays visible (callers that predate the argument).
  const legacy = new JSDOM(createRenderer({ showMeta: true }).renderMessageHoverRow({ id: 'full_only' }, {}, full));
  t.after(() => legacy.window.close());
  assert.equal(legacy.window.document.querySelector('.chat-hover-meta').textContent, full);
  // Only a short label: it is also the tooltip.
  const onlyShort = new JSDOM(createRenderer({ showMeta: true }).renderMessageHoverRow({ id: 'short_only' }, {}, '', short));
  t.after(() => onlyShort.window.close());
  const onlyMeta = onlyShort.window.document.querySelector('.chat-hover-meta');
  assert.equal(onlyMeta.textContent, short);
  assert.equal(onlyMeta.getAttribute('title'), short);
});

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
  const buttonMatches = html.match(/data-message-action="[^"]+"/g) || [];
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

  assert.match(html, /<div class="chat-hover-meta" tabindex="0" title="[^"]+">~2 tokens est\. · ~2 cumulative<\/div>/);
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

// Pin to board (row 150 slice C5): the hover row asks the chat's one pin entry whether the flag is on.
test('Pin to board: with the flag off the row is byte-identical and the model gets the options untouched', (t) => {
  const seen = [];
  const build = (_message, given) => { seen.push(given); return buildHoverActionModel({}); };
  const options = { latestReplyAssistantMessageId: 'a' };
  const before = createTranscriptActionRenderer({ escapeHtml, buildMessageActionModel: build }).renderMessageHoverRow({ id: 'm1' }, options, '');
  globalThis.rendererChatMessageActionBindings = { pinEnabled: () => false };
  t.after(() => { delete globalThis.rendererChatMessageActionBindings; });
  const after = createTranscriptActionRenderer({ escapeHtml, buildMessageActionModel: build }).renderMessageHoverRow({ id: 'm1' }, options, '');
  assert.equal(after, before);
  assert.deepEqual(seen, [options, options]);
  assert.equal(seen[1], options, 'the same object: nothing was added');
  assert.doesNotMatch(after, /data-message-action="pin"/);
});

test('Pin to board: with the flag on the model is told, and one pin button sits after copy, icon only, labelled and titled', (t) => {
  globalThis.rendererChatMessageActionBindings = { pinEnabled: () => true };
  t.after(() => { delete globalThis.rendererChatMessageActionBindings; });
  const seen = [];
  const actions = Object.fromEntries(['edit', 'branch', 'regenerate', 'copy', 'pin', 'elaborate'].map((name) => [name, { visible: true, enabled: true }]));
  const renderer = createTranscriptActionRenderer({ escapeHtml, buildMessageActionModel: (_message, options) => { seen.push(options); return buildHoverActionModel({ actions }); } });
  const html = renderer.renderMessageHoverRow({ id: 'm2' }, { followUpActionsBusy: false }, '');
  assert.deepEqual(seen, [{ followUpActionsBusy: false, pinToBoard: true }]);
  const order = [...html.matchAll(/data-message-action="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['edit', 'branch', 'regenerate', 'copy', 'pin', 'elaborate']);
  const button = html.match(/<button[^>]+data-message-action="pin"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.match(button, /aria-label="Pin to board"/);
  assert.match(button, /title="Pin to board"/);
  assert.match(button, /data-message-id="m2"/);
  assert.match(button, /<svg[^>]+aria-hidden="true"/);
  assert.doesNotMatch(button, /chat-hover-action--labeled/);
  assert.doesNotMatch(button.replace(/<svg[\s\S]*?<\/svg>/, ''), /Pin to board\s*<\/button>/, 'no visible word');
  // A model that does not list pin (a row it does not apply to) draws none.
  const without = createTranscriptActionRenderer({ escapeHtml, buildMessageActionModel: () => buildHoverActionModel({}) }).renderMessageHoverRow({ id: 'm3' }, {}, '');
  assert.doesNotMatch(without, /data-message-action="pin"/);
});

// Post to Team (row 175 D5): one more hover action on a local Jenny answer, after Pin; greyed with the module's reason, never hidden.
test('Post to Team hover action on a local answer', (t) => {
  const asked = [];
  globalThis.rendererChatMessageActionBindings = { pinEnabled: () => true, postToTeamState: (message) => { asked.push(message.id); return { visible: true, enabled: true, reason: '' }; } };
  t.after(() => { delete globalThis.rendererChatMessageActionBindings; });
  const actions = Object.fromEntries(['edit', 'branch', 'regenerate', 'copy', 'pin', 'elaborate'].map((name) => [name, { visible: true, enabled: true }]));
  const renderer = createTranscriptActionRenderer({ escapeHtml, buildMessageActionModel: () => buildHoverActionModel({ actions }) });
  const html = renderer.renderMessageHoverRow({ id: 'a1', role: 'assistant', content: 'Hello' }, {}, '');
  const order = [...html.matchAll(/data-message-action="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['edit', 'branch', 'regenerate', 'copy', 'pin', 'post-to-team', 'elaborate']);
  const button = html.match(/<button[^>]+data-message-action="post-to-team"[^>]*>/)[0];
  assert.match(button, /aria-label="Post to Team…"/);
  assert.match(button, /data-message-id="a1"/);
  assert.doesNotMatch(button, /disabled/);
  // A user message is not a Jenny answer: the hook is not asked and no button is drawn.
  const user = renderer.renderMessageHoverRow({ id: 'u1', role: 'user', content: 'Hi' }, {}, '');
  assert.doesNotMatch(user, /post-to-team/);
  assert.deepEqual(asked, ['a1']);
});

test('Post to Team hover action is greyed with its reason, and absent while the hook has none (Team off)', (t) => {
  let answer = { visible: true, enabled: false, reason: 'Join a team to post there.' };
  globalThis.rendererChatMessageActionBindings = { postToTeamState: () => answer };
  t.after(() => { delete globalThis.rendererChatMessageActionBindings; });
  const renderer = createTranscriptActionRenderer({ escapeHtml, buildMessageActionModel: () => buildHoverActionModel({}) });
  const message = { id: 'a2', role: 'assistant', content: 'Hello' };
  const grey = renderer.renderMessageHoverRow(message, {}, '').match(/<button[^>]+data-message-action="post-to-team"[^>]*>/)[0];
  assert.match(grey, /disabled aria-disabled="true"/);
  assert.match(grey, /title="Join a team to post there\."/);
  assert.match(grey, /aria-label="Post to Team… \(Join a team to post there\.\)"/);
  answer = null;
  assert.doesNotMatch(renderer.renderMessageHoverRow(message, {}, ''), /post-to-team/);
});
