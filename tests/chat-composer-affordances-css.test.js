const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readImports() {
  return readRepoFile('styles.css')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('@import'))
    .map((line) => line.match(/url\("([^"]+)"\)/)?.[1])
    .filter(Boolean);
}

function selectorBlockPattern(selector) {
  return new RegExp(`(^|\\n)${selector.replaceAll('.', '\\.')}\\s*(?:\\{|,)`);
}

test('chat composer affordance CSS loads after the base composer stylesheet', () => {
  const imports = readImports();
  const composerIndex = imports.indexOf('./styles/chat-composer.css');

  assert.notEqual(composerIndex, -1);
  assert.equal(imports[composerIndex + 1], './styles/chat-composer-meta-affordances.css');
  assert.equal(imports[composerIndex + 2], './styles/chat-composer-v2-affordances.css');
  assert.equal(imports[composerIndex + 3], './styles/chat-composer-v2.css');
  assert.equal(imports[composerIndex + 4], './styles/chat-composer-shell-v2.css');
});

test('chat composer meta and wayfinder selectors live in their focused stylesheet', () => {
  const affordanceCss = readRepoFile('styles/chat-composer-meta-affordances.css');
  const composerCss = readRepoFile('styles/chat-composer.css');

  for (const selector of [
    '.composer-meta',
    '.composer-wayfinder-host',
  ]) {
    assert.match(affordanceCss, selectorBlockPattern(selector));
    assert.doesNotMatch(composerCss, selectorBlockPattern(selector));
  }
});

test('chat composer V2 status and chip selectors live in their focused stylesheet', () => {
  const affordanceCss = readRepoFile('styles/chat-composer-v2-affordances.css');
  const composerCss = readRepoFile('styles/chat-composer.css');

  for (const selector of [
    '.composer-failed-send-notice',
    '.attachment-preview-pill',
  ]) {
    assert.match(affordanceCss, selectorBlockPattern(selector));
    assert.doesNotMatch(composerCss, selectorBlockPattern(selector));
  }
});

test('failed-send label is a markup chip, not ::after pseudo-content (EH-W6)', () => {
  const affordanceCss = readRepoFile('styles/chat-composer-v2-affordances.css');

  assert.match(affordanceCss, selectorBlockPattern('.chat-bubble-send-status'), 'chip selector present');
  assert.ok(
    affordanceCss.includes('.chat-bubble[data-send-state="failed"]'),
    'builder-emitted send-state attribute styled'
  );
  assert.ok(
    affordanceCss.includes('.chat-bubble[data-message-state="failed"]'),
    'legacy V2 mount tag kept as alias for one wave'
  );
  assert.ok(
    !affordanceCss.includes('content: "Failed to send"'),
    '::after pseudo-content removed'
  );
});

test('context ring CSS keeps its 18px size override, eased thresholds, and reduced-motion guard', () => {
  const ringCss = readRepoFile('styles/chat-composer-shell-v2.css');
  const affordanceCss = readRepoFile('styles/chat-composer-meta-affordances.css');

  assert.match(
    affordanceCss,
    /\.composer-context-usage-slot\s*\{[^}]*position:\s*relative/,
    'context slot anchors viewport-clamped popover coordinates'
  );
  assert.match(
    affordanceCss,
    /\.inv-context-details-popover\s*\{[^}]*overscroll-behavior:\s*contain/,
    'constrained context details scroll internally'
  );

  // 18px must be applied via a selector specific enough (0,2,1) to beat the
  // generic `.inv-chip-icon svg { width:14px }` (0,1,1) in the chip stylesheet —
  // this is the guard that would have caught the silent 14px undersize.
  assert.match(
    ringCss,
    /\.inv-chip-icon\s+svg\.inv-context-ring-svg\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px/,
    'ring-specific 18px rule with winning specificity present'
  );

  // The 1.5->2.5 weight + accent->warning/danger color jump is transitioned.
  assert.match(
    ringCss,
    /\.inv-context-ring-track,\s*\.inv-context-ring-arc\s*\{[^}]*transition:[\s\S]*?stroke-width/,
    'threshold escalation is eased, not a hard pop'
  );

  // The 80% warning gets its own subtler one-shot cue.
  assert.match(ringCss, /inv-context-ring--warn-pulse/, 'warning entrance cue class present');

  // Reduced-motion nulls both the pulse animations and the threshold transition.
  const reducedMotion = ringCss.slice(ringCss.indexOf('@media (prefers-reduced-motion'));
  assert.match(reducedMotion, /inv-context-ring--warn-pulse[\s\S]*?animation:\s*none/, 'warn cue suppressed under reduced-motion');
  assert.match(reducedMotion, /transition:\s*none/, 'threshold transition suppressed under reduced-motion');
});

test('the legacy .token-pill rule was removed but its live .kbd tokens were kept', () => {
  const affordanceCss = readRepoFile('styles/chat-composer-meta-affordances.css');
  assert.doesNotMatch(affordanceCss, selectorBlockPattern('.token-pill'), 'dead .token-pill rule removed');

  // --widget-token-pill-bg/-color stay: they are read by the live .kbd primitive.
  const foundation = readRepoFile('styles/foundation.css');
  assert.ok(foundation.includes('var(--widget-token-pill-bg)'), '.kbd still consumes the bg token');
  assert.ok(foundation.includes('var(--widget-token-pill-color)'), '.kbd still consumes the color token');

  // The genuinely-orphaned border token is gone everywhere.
  const widgetTokens = readRepoFile('styles/foundation-widget-tokens.css');
  assert.ok(!widgetTokens.includes('--widget-token-pill-border'), 'unused border token removed');
});

test('the retired mode-chip CSS and its collapse guard stay gone (run-mode rail chip owns the surface)', () => {
  const affordanceCss = readRepoFile('styles/chat-composer-v2-affordances.css');
  const composerCss = readRepoFile('styles/chat-composer.css');
  const metaRowBlock = affordanceCss.match(/\.composer-mode-chips\s*\{([^}]*)\}/)?.[1] || '';
  const hintBlock = composerCss.match(/\.composer-run-mode-hint\s*\{([^}]*)\}/)?.[1] || '';

  assert.doesNotMatch(affordanceCss, /\.composer-mode-chip\b/);
  assert.doesNotMatch(affordanceCss, /:not\(:has\(\.composer-mode-chip\)\)/);
  assert.doesNotMatch(affordanceCss, /\.composer-mode-chips\[data-composer-v2="on"\]/);
  assert.doesNotMatch(metaRowBlock, /margin-bottom\s*:/);
  assert.match(metaRowBlock, /margin:\s*var\(--space-2\)\s+0\s+0\s*;/, 'meta row has a top margin and no bottom offset');
  assert.doesNotMatch(hintBlock, /width:\s*100%/);
});
