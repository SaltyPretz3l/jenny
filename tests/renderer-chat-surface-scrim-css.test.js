const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const chatThreadCss = fs.readFileSync(path.join(rootDir, 'styles', 'chat-thread.css'), 'utf8');
const chatMediaQueriesCss = fs.readFileSync(
  path.join(rootDir, 'styles', 'chat-media-queries.css'), 'utf8'
);

function readCssRuleBlock(css, selector) {
  const escapedSelector = String(selector).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `expected ${selector} CSS rule`);
  return match[1];
}

test('threaded and new-session chat share the masked center-lane scrim', () => {
  // :where() is pinned because the no-blur fallback cascade relies on source order.
  const sharedRule = readCssRuleBlock(
    chatThreadCss,
    ':where(.chat-view.chat-empty:has(.chat-surface-effect-gutter[data-widget-modifier]:not([data-widget-modifier="none"]))) .hero-stage::before'
  );
  const emptySizingRule = readCssRuleBlock(chatThreadCss, '.chat-view.chat-empty .hero-stage::before');

  assert.match(
    chatThreadCss,
    /:where\(\.chat-view:has\(\.chat-surface-effect-gutter\[data-widget-modifier\]:not\(\[data-widget-modifier="none"\]\)\)\)\s+\.chat-thread-column::before,\s*:where\(\.chat-view\.chat-empty:has\(\.chat-surface-effect-gutter\[data-widget-modifier\]:not\(\[data-widget-modifier="none"\]\)\)\)\s+\.hero-stage::before\s*\{/
  );
  assert.match(
    sharedRule,
    /pointer-events:\s*none;[\s\S]*?var\(--bg-base\)\s*76%[\s\S]*?backdrop-filter:\s*blur\(6px\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(6px\);/
  );
  assert.match(
    sharedRule,
    /mask-image:\s*linear-gradient\([\s\S]*?#000\s*24%[\s\S]*?#000\s*76%[\s\S]*?-webkit-mask-image:\s*linear-gradient\(/
  );
  assert.doesNotMatch(sharedRule, /var\(--surface-body-background\)/);
  assert.match(
    emptySizingRule,
    /top:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?left:\s*max\([\s\S]*?width:\s*calc\(var\(--_thread-col-content\)\s*\+\s*var\(--chat-sprite-rail-offset\)\);/
  );
});

test('new-session scrim retains narrow and no-blur fallbacks', () => {
  assert.match(
    chatMediaQueriesCss,
    /\.chat-view\.chat-empty\s+\.hero-stage::before\s*\{[\s\S]*?calc\(100vw\s*-\s*48px\)/
  );
  assert.match(
    chatMediaQueriesCss,
    /@supports not \(backdrop-filter:\s*blur\(1px\)\)[\s\S]*?\.chat-thread-column::before,\s*\.chat-view\.chat-empty\s+\.hero-stage::before\s*\{[\s\S]*?var\(--bg-base\)\s*84%[\s\S]*?backdrop-filter:\s*none;[\s\S]*?-webkit-backdrop-filter:\s*none;/
  );
  assert.match(
    chatMediaQueriesCss,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.chat-view\.chat-empty\s+\.hero-stage::before,[\s\S]*?backdrop-filter:\s*none;/
  );
});
