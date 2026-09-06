'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');
const chatThreadCss = fs.readFileSync(path.join(rootDir, 'styles', 'chat-thread.css'), 'utf8');
const chatMediaQueriesCss = fs.readFileSync(
  path.join(rootDir, 'styles', 'chat-media-queries.css'),
  'utf8'
);
// :where() is pinned because the no-blur fallback cascade relies on source order.
const gatedScrimSelector = String.raw`:where\(\.chat-view:has\(\.chat-surface-effect-gutter\[data-widget-modifier\]:not\(\[data-widget-modifier="none"\]\)\)\)\s+\.chat-thread-column::before,\s*:where\(\.chat-view\.chat-empty:has\(\.chat-surface-effect-gutter\[data-widget-modifier\]:not\(\[data-widget-modifier="none"\]\)\)\)\s+\.hero-stage::before`;
const fallbackScrimSelector = String.raw`\.chat-thread-column::before(?:,\s*\.chat-view\.chat-empty\s+\.hero-stage::before)?`;

test('chat thread scrim feathers its palette wash and blur without intercepting input', () => {
  assert.ok(
    new RegExp(`${gatedScrimSelector}\\s*\\{[\\s\\S]*?pointer-events:\\s*none;[\\s\\S]*?background:\\s*color-mix\\(in srgb,\\s*var\\(--bg-base\\)\\s*76%,\\s*transparent\\);[\\s\\S]*?backdrop-filter:\\s*blur\\(6px\\);[\\s\\S]*?-webkit-backdrop-filter:\\s*blur\\(6px\\);`).test(chatThreadCss),
    'expected the active-effect-gated scrim rule with its wash, blur, and input contract'
  );
  assert.match(
    chatThreadCss,
    new RegExp(`${gatedScrimSelector}\\s*\\{[\\s\\S]*?mask-image:\\s*linear-gradient\\([\\s\\S]*?transparent\\s*0%[\\s\\S]*?#000\\s*24%[\\s\\S]*?#000\\s*76%[\\s\\S]*?transparent\\s*100%[\\s\\S]*?-webkit-mask-image:\\s*linear-gradient\\(`)
  );
  assert.doesNotMatch(
    chatThreadCss,
    new RegExp(`${gatedScrimSelector}\\s*\\{[^}]*color-mix\\([^)]*var\\(--surface-body-background\\)`)
  );
});

test('chat thread scrim generation requires an active background surface effect', () => {
  let threadArmAssertions = 0;
  let heroArmAssertions = 0;
  for (const match of chatThreadCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = match;
    if (!/(?:^|;)\s*content\s*:/.test(body)) {
      continue;
    }
    for (const complexSelector of selector.split(',')) {
      if (/\.chat-thread-column::before/.test(complexSelector)) {
        threadArmAssertions += 1;
        assert.ok(
          /:where\(\.chat-view:has\(\.chat-surface-effect-gutter\[data-widget-modifier\]:not\(\[data-widget-modifier="none"\]\)\)\)\s+\.chat-thread-column::before/.test(complexSelector),
          'chat thread scrim content must be gated on an active background surface effect'
        );
      }
      if (/\.hero-stage::before/.test(complexSelector)) {
        heroArmAssertions += 1;
        assert.ok(
          /:where\(\.chat-view\.chat-empty:has\(\.chat-surface-effect-gutter\[data-widget-modifier\]:not\(\[data-widget-modifier="none"\]\)\)\)\s+\.hero-stage::before/.test(complexSelector),
          'empty-chat scrim content must be gated on an active background surface effect'
        );
      }
    }
  }
  assert.equal(threadArmAssertions, 1, 'thread gated-arm assertion executed exactly once');
  assert.equal(heroArmAssertions, 1, 'hero gated-arm assertion executed exactly once');
});

test('chat thread scrim degrades to a stronger no-blur wash', () => {
  assert.match(
    chatMediaQueriesCss,
    new RegExp(`@supports not \\(backdrop-filter:\\s*blur\\(1px\\)\\)[\\s\\S]*?${fallbackScrimSelector}\\s*\\{[\\s\\S]*?var\\(--bg-base\\)\\s*84%[\\s\\S]*?backdrop-filter:\\s*none;[\\s\\S]*?-webkit-backdrop-filter:\\s*none;`)
  );
  assert.match(
    chatMediaQueriesCss,
    new RegExp(`@media \\(prefers-reduced-motion:\\s*reduce\\)[\\s\\S]*?\\.chat-thread-column::before,[\\s\\S]*?backdrop-filter:\\s*none;[\\s\\S]*?${fallbackScrimSelector}\\s*\\{[\\s\\S]*?var\\(--bg-base\\)\\s*84%`)
  );
});
