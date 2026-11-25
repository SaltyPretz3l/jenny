// UIUX-004 residual (Wave 2): pane collapse at compact desktop widths that
// W0-F's 640×560 window floor made reachable.
//
// The context panel yields to the artifact rail:
// `.chat-view.artifact-review-mode > .chat-context-panel { display: none }`
// in context-panel.css — pinned here so it can't silently regress.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const chatMediaQueriesCss = fs.readFileSync(
  path.join(rootDir, 'styles', 'chat-media-queries.css'),
  'utf8'
);
const contextPanelCss = fs.readFileSync(
  path.join(rootDir, 'styles', 'context-panel.css'),
  'utf8'
);

test('context panel yields whenever the artifact rail is open (priority 1)', () => {
  assert.match(
    contextPanelCss,
    /\.chat-view\.artifact-review-mode > \.chat-context-panel\s*\{\s*display:\s*none;/,
    'the artifact rail and context panel must never fight for the same band'
  );
});

test('compact desktop widths hide the context rail before it crushes the thread', () => {
  assert.match(
    chatMediaQueriesCss,
    /@media \(max-width:\s*1040px\)\s*\{[\s\S]*?--context-panel-width:\s*0px;[\s\S]*?\.chat-view > \.chat-context-panel\s*\{\s*display:\s*none;/,
    'an expanded sessions panel and context rail must not reduce the chat thread to an unusable sliver'
  );
});
