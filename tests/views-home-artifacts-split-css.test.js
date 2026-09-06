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

function selectorAtRuleStart(selector) {
  return new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

function assertMovedRuleStart({ focusedCss, parentCss, selector }) {
  const pattern = selectorAtRuleStart(selector);
  assert.match(focusedCss, pattern, `${selector} should live in the focused stylesheet`);
  assert.doesNotMatch(parentCss, pattern, `${selector} should not remain in views-home-artifacts.css`);
}

test('home and artifacts split CSS loads immediately after the base view stylesheet', () => {
  const imports = readImports();
  const viewIndex = imports.indexOf('./styles/views-home-artifacts.css');

  assert.notEqual(viewIndex, -1);
  assert.equal(imports[viewIndex + 1], './styles/views-surface-effects.css');
  assert.equal(imports[viewIndex + 2], './styles/views-home-board.css');
  assert.equal(imports[viewIndex + 3], './styles/views-home-dashboard.css');
  // W11 split the hero band out of the dashboard sheet; it loads immediately
  // after it so the two can never disagree about cascade order.
  assert.equal(imports[viewIndex + 4], './styles/views-home-hero.css');
  assert.equal(imports[viewIndex + 5], './styles/views-home-calendar.css');
  assert.equal(imports[viewIndex + 6], './styles/views-home-calendar-agenda.css');
  assert.equal(imports[viewIndex + 7], './styles/views-home-calendar-week.css');
  assert.equal(imports[viewIndex + 8], './styles/views-home-calendar-month.css');
  assert.equal(imports[viewIndex + 9], './styles/views-home-calendar-form.css');
  assert.equal(imports[viewIndex + 10], './styles/views-artifacts.css');
  assert.equal(imports[viewIndex + 11], './styles/views-home-setup.css');
  assert.equal(imports[viewIndex + 12], './styles/ide-view.css');
});

test('surface effect canvas selectors live in their focused stylesheet', () => {
  const focusedCss = readRepoFile('styles/views-surface-effects.css');
  const parentCss = readRepoFile('styles/views-home-artifacts.css');

  for (const selector of [
    '[data-widget-modifier~="reactive-grid"],',
    '[data-widget-modifier~="reactive-grid"] > :not(.widget-reactive-grid-canvas),',
    '.widget-circuit-trace-canvas {',
  ]) {
    assertMovedRuleStart({ focusedCss, parentCss, selector });
  }
});

test('home board and open-loop selectors live in their focused stylesheet', () => {
  const focusedCss = readRepoFile('styles/views-home-board.css');
  const parentCss = readRepoFile('styles/views-home-artifacts.css');

  for (const selector of [
    '.home-body {',
    '.home-summary-item {',
    '.home-inline-form {',
  ]) {
    assertMovedRuleStart({ focusedCss, parentCss, selector });
  }
});

// Home restyle (2026-08-19): the glass-card language was replaced by "open
// sections" — no card chrome at all, and a two-level depth budget where level 1
// is a SOLID one-step fill + 1px hairline + 8px corners on zoned/interactive
// surfaces only. These assertions replace the former translucent-scrim contract.
test('Home sections carry no card chrome and the depth budget stays at two levels', () => {
  const boardCss = readRepoFile('styles/views-home-board.css');
  const dashboardCss = readRepoFile('styles/views-home-dashboard.css');

  const cardRule = dashboardCss.match(/\n\.dashboard-card \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(cardRule, '.dashboard-card should still be styled');
  for (const property of ['border:', 'background:', 'box-shadow:', 'min-height:', 'border-radius:']) {
    assert.equal(cardRule.includes(property), false,
      `.dashboard-card should not declare ${property} — sections have no chrome`);
  }
  assert.match(cardRule, /padding:\s*0;/, 'the grid gap owns section spacing');
  // Focus mode still scopes a `.dashboard-card:hover` un-dim rule; what must be
  // gone is the top-level hover-elevation rule.
  assert.doesNotMatch(dashboardCss, /(^|\n)\.dashboard-card:hover/,
    'sections have no hover elevation');

  const panelRule = boardCss.match(/\n\.home-panel \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(panelRule, /background:\s*none;/, '.home-panel carries no fill of its own');

  // Depth level 1: the full-width Open Loops zone.
  const boardPanelRule = boardCss.match(/\n\.home-panel--board \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(boardPanelRule, /background:\s*var\(--bg-surface\);/, 'level-1 fill is solid');
  assert.match(boardPanelRule, /border:\s*1px solid var\(--border-default\);/);
  assert.match(boardPanelRule, /border-radius:\s*var\(--radius-base\);/);
  assert.equal(boardPanelRule.includes('box-shadow'), false);
});

test('no gradients, elevation shadows, or side accent bars survive on Home', () => {
  for (const relativePath of [
    'styles/views-home-dashboard.css',
    'styles/views-home-hero.css',
    'styles/views-home-board.css',
    'styles/views-home-artifacts.css',
  ]) {
    const css = readRepoFile(relativePath);
    assert.equal(css.includes('linear-gradient'), false, `${relativePath} still has a gradient`);
    assert.equal(css.includes('var(--shadow-'), false, `${relativePath} still has an elevation shadow`);
    assert.doesNotMatch(css, /border-left:\s*3px/, `${relativePath} still has a side accent bar`);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, `${relativePath} has a raw hex color`);
    assert.doesNotMatch(css, /\brgba?\(/i, `${relativePath} has a raw rgb color`);
    // The support accent is retired from ambient chrome across Home.
    assert.equal(css.includes('var(--home-support-accent)'), false,
      `${relativePath} still paints ambient chrome with the support accent`);
  }
});

test('Home runs one heading system: uppercase tracked eyebrow plus a hairline rule', () => {
  const dashboardCss = readRepoFile('styles/views-home-dashboard.css');
  const boardCss = readRepoFile('styles/views-home-board.css');
  const quietEyebrow = /color-mix\(in srgb, var\(--text-secondary\) 75%, var\(--text-primary\)\)/;

  const titleRule = dashboardCss.match(/\n\.dashboard-card__title \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(titleRule, quietEyebrow);
  assert.match(titleRule, /font-size:\s*var\(--font-size-lg\);/);
  assert.match(titleRule, /letter-spacing:\s*var\(--tracking-kicker-lg\);/);
  assert.match(titleRule, /text-transform:\s*uppercase;/);

  const ruleAfter = dashboardCss.match(/\n\.dashboard-card__header::after \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(ruleAfter, /flex:\s*1 1 auto;/);
  assert.match(ruleAfter, /height:\s*1px;/);
  assert.match(ruleAfter, /background:\s*color-mix\(in srgb, var\(--border-default\) 70%, transparent\);/);

  const h3Rule = boardCss.match(/\n\.home-panel--board h3 \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(h3Rule, quietEyebrow, 'board headings conform to the eyebrow style');
  assert.match(h3Rule, /font-size:\s*var\(--font-size-lg\);/);
  assert.match(h3Rule, /text-transform:\s*uppercase;/);
});

test('retired Home pill chrome and orphaned base-less rules stay deleted', () => {
  const boardCss = readRepoFile('styles/views-home-board.css');
  const artifactsCss = readRepoFile('styles/views-home-artifacts.css');

  const eyebrowRule = boardCss.match(/\n\.home-card-eyebrow \{[\s\S]*?\n\}/)?.[0] || '';
  assert.equal(eyebrowRule.includes('border-radius'), false, '.home-card-eyebrow is plain text now');
  assert.equal(eyebrowRule.includes('background'), false);

  const badgeRule = boardCss.match(/\n\.home-loop-badge \{[\s\S]*?\n\}/)?.[0] || '';
  assert.equal(badgeRule.includes('border-radius'), false, '.home-loop-badge is a plain count now');
  assert.match(badgeRule, /color:\s*var\(--text-secondary\);/);

  assert.equal(boardCss.includes('.home-summary-item.memory-commitment-item--first {'), false,
    'the first open-loop special case is deleted');
  assert.equal(artifactsCss.includes('.home-body::before'), false,
    'the orphaned .home-body::before overrides have no base rule and are deleted');
});

/* W8-1: the hero ask pill was a full-width band. It now shares the hero row with
 * the repainted chrome, capped narrow and right-aligned, wearing the SAME
 * resting chrome as the titlebar "Go anywhere" palette pill. */
test('the hero ask block is width-capped, right-aligned, and draws ONE rule', () => {
  const heroCss = readRepoFile('styles/views-home-hero.css');

  const stripRule = heroCss.match(/\n\.home-info-strip \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(stripRule, /display:\s*flex;/, 'chrome and ask share one wrapping row');
  assert.match(stripRule, /flex-wrap:\s*wrap;/);

  const askRule = heroCss.match(/\n\.home-info-strip__ask \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(askRule, /margin-left:\s*auto;/, 'the block sits at the right of the hero band');
  assert.match(askRule, /max-width:\s*clamp\(380px, 32vw, 520px\);/, 'compact, not a band');
  assert.match(askRule, /position:\s*relative;/);
  assert.match(askRule, /display:\s*flex;/, 'the ask region is the cluster\'s one flex line');
  // flex-START, not center: the field grows DOWNWARD once it is multiline, and
  // centering would drag the page-menu trigger down with it instead of keeping
  // it on the field's first line.
  assert.match(askRule, /align-items:\s*flex-start;/);
  const menuRule = heroCss.match(/\n\.home-page-menu \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(menuRule, /min-height:\s*32px;/,
    'the trigger holds the first line\'s centerline against a growing field');

  /* RULES OVER BOXES. The capsule is gone: no border, no radius, and no accent
   * wash around the field. The single hairline lives on the field ROW, so it
   * spans the whole block including the send lane rather than tracking the
   * control's own box. */
  const rowRule = heroCss.match(/\n\.home-ask__field-row \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(rowRule, 'the field row exists');
  assert.match(rowRule, /border-bottom:\s*1px solid var\(--border-subtle\);/, 'exactly one rule');
  assert.doesNotMatch(rowRule, /border-radius:/, 'a rule is not a capsule');

  const controlRule = heroCss
    .match(/\n\.home-info-strip__ask \.inv-text-field--multiline \.inv-text-field-control \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(controlRule, 'the control rule is scoped to the multiline field');
  assert.match(controlRule, /border:\s*0;/, 'the control draws no box of its own');
  assert.match(controlRule, /background:\s*transparent;/, 'and no fill at rest');
  // F6: the old field was <input> at --font-size-base (12px) against the chat
  // composer's 16px. One step below the composer, not four.
  assert.match(controlRule, /font-size:\s*var\(--font-size-lg\);/);

  // F7: the chip lane is gone with the chip. Nothing reserves a quarter of the
  // typing width any more, and the tokens that declared it are deleted.
  assert.doesNotMatch(controlRule, /padding-right:/, 'no reserved lane');
  assert.equal(heroCss.includes('--home-ask-chip-max'), false, 'the chip lane token is gone');
  assert.equal(heroCss.includes('--home-ask-chip-inset'), false);

  // Under a narrow shell it stacks instead of crowding the clock.
  assert.match(heroCss, /@media \(max-width: 720px\) \{\n\s*\.home-info-strip__ask \{/);
});

/* F10 - a LOAD-ORDER TRAP that would have shipped as a live bug.
 * styles/views-home-setup.css ships an UNSCOPED
 * `.inv-text-field--multiline .inv-text-field-control { min-height: 64px;
 * resize: vertical; }` and loads AFTER this sheet at the SAME (0,2,0)
 * specificity. The moment the ask field became multiline, a two-class hero
 * rule would lose the tiebreak and the ask block would render as a 64px
 * user-resizable box. Every hero rule touching this control must be (0,3,0)
 * or higher AND restate the properties it is outranking. */
test('every hero rule on the multiline control outranks the unscoped setup rule', () => {
  const heroCss = readRepoFile('styles/views-home-hero.css');
  const setupCss = readRepoFile('styles/views-home-setup.css');

  // The rule being outranked still exists; if it is ever scoped or removed,
  // revisit this guard rather than letting it drift into passing vacuously.
  const setupRule = setupCss
    .match(/\n\.inv-text-field--multiline \.inv-text-field-control \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(setupRule, 'the unscoped multiline rule is still the thing being outranked');
  assert.match(setupRule, /min-height:\s*64px;/);
  assert.match(setupRule, /resize:\s*vertical;/);

  // Every hero selector that reaches .inv-text-field-control carries at least
  // three classes. Counting is what makes this non-vacuous: delete one class
  // from the base selector and this fires.
  const selectors = [...heroCss.matchAll(/^([^\n{}]*\.inv-text-field-control[^\n{}]*)(?:,|\s*\{)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  assert.ok(selectors.length >= 3, 'the hero styles the control at all');
  for (const selector of selectors) {
    const classCount = (selector.match(/\.[A-Za-z_-][\w-]*/g) || []).length;
    assert.ok(
      classCount >= 3,
      `"${selector}" is (0,${classCount},0) - it loses the load-order tiebreak to views-home-setup.css`
    );
  }

  // And it restates what it is outranking, explicitly.
  const controlRule = heroCss
    .match(/\n\.home-info-strip__ask \.inv-text-field--multiline \.inv-text-field-control \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(controlRule, /min-height:\s*22px;/, 'not the setup sheet\'s 64px');
  assert.match(controlRule, /resize:\s*none;/, 'not a user-resizable box in the hero band');
  // The 4-line ceiling, past which the field scrolls internally. Nothing is
  // truncated - that was the whole point of dropping maxLength.
  assert.match(controlRule, /max-height:\s*calc\(\(1\.5em \* 4\) \+ 4px\);/);
  assert.match(controlRule, /overflow-y:\s*auto;/);
});

/* The rule IS the focus signal - the field carries no outline ring, so if the
 * focused hairline is not legible there is no focus indication at all. A bare
 * --accent-a-30 hairline measures under 3:1 on the light palettes, so the
 * accent is BLENDED toward --text-primary (the repo's palette-contrast fix)
 * rather than run at a higher alpha. */
test('the focused ask rule is the focus signal and is blended for contrast', () => {
  const heroCss = readRepoFile('styles/views-home-hero.css');

  const focusRule = heroCss
    .match(/\n\.home-info-strip__ask:focus-within \.home-ask__field-row \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(focusRule, 'focus-within on the region is what steps the rule');
  assert.match(
    focusRule,
    /border-bottom-color:\s*color-mix\(in srgb, var\(--accent\) 55%, var\(--text-primary\)\);/,
    'blended toward --text-primary, not a bare low-alpha accent'
  );

  const controlFocusRule = heroCss.match(
    /\n\.home-info-strip__ask \.inv-text-field--multiline \.inv-text-field-control:focus,\n\.home-info-strip__ask \.inv-text-field--multiline \.inv-text-field-control:focus-visible \{[\s\S]*?\n\}/
  )?.[0] || '';
  assert.ok(controlFocusRule, 'the focused control has one rule covering :focus AND :focus-visible');
  assert.match(controlFocusRule, /outline:\s*none;/, 'no ring - the rule under the text does the job');
  assert.match(controlFocusRule, /background:\s*transparent;/, 'and focus adds no wash');

  // The unscoped :focus rule this has to outrank still exists.
  const setupCss = readRepoFile('styles/views-home-setup.css');
  assert.match(setupCss, /\n\.inv-text-field-control:focus,/, 'the unscoped focus rule is still there');
});

/* W13 - the model trigger stops being a chip parked inside the input and
 * becomes plain text on a meta row, and the settings panel becomes the ONE box
 * in the feature. Nothing inside it is boxed or divided by a rule. */
test('the model trigger is plain text on the meta row and the panel is the one box', () => {
  const heroCss = readRepoFile('styles/views-home-hero.css');

  const metaRule = heroCss.match(/\n\.home-ask__meta \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(metaRule, 'the meta row exists');
  // Reserved at every state, so revealing the hint or the send never shifts Home.
  assert.match(metaRule, /min-height:\s*20px;/);
  assert.match(metaRule, /position:\s*relative;/, 'it anchors the absolutely placed hint');

  const triggerRule = heroCss.match(/\n\.home-ask__model \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(triggerRule, /border:\s*0;/, 'no capsule around the model name');
  assert.match(triggerRule, /background:\s*transparent;/, 'and no fill at rest - fills are reserved');
  assert.match(triggerRule, /color:\s*var\(--text-muted\);/, 'information, legible at rest');

  const labelRule = heroCss.match(/\n\.home-ask__model-label \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(labelRule, /text-overflow:\s*ellipsis;/, 'a long model tag truncates, it does not stretch the row');

  /* W11.1 owner live regression, RE-POINTED. A `transform` on the panel's
   * ANCHOR makes it a stacking context, which TRAPS the panel's own z-index at
   * the host's auto level - the sticky rail then painted its scratchpad card
   * straight through the open panel. The redesign centers with flex instead, so
   * the guard is now that there is NO transform here at all; the conditional is
   * kept as the second arm so a future transform still has to pay for itself. */
  const hostRule = heroCss.match(/\n\.home-ask-config \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(hostRule, 'the panel anchor has a rule');
  assert.match(hostRule, /position:\s*relative;/, 'it is the panel\'s containing block');
  assert.match(hostRule, /align-items:\s*center;/, 'centered with flex, not with a transform');
  assert.equal(/transform:/.test(hostRule), false,
    'a transformed anchor traps the panel z-index; center with flex instead');
  if (/transform:/.test(hostRule)) {
    assert.match(
      hostRule,
      /z-index:\s*var\(--z-popover\);/,
      'a transformed anchor must lift itself to the popover layer or the rail paints over the open panel'
    );
  }

  const panelRule = heroCss.match(/\n\.home-ask__panel \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(panelRule, /top:\s*calc\(100% \+ var\(--space-3\)\);/, 'it hangs below the trigger');
  assert.match(panelRule, /left:\s*0;/, 'left-aligned to a trigger that now sits at the block\'s left');
  // The trigger anchors it at the LEFT edge now, so the narrow-shell override
  // that once pulled it back on-screen is deliberately still absent.
  const narrowBlock = heroCss.match(/@media \(max-width: 720px\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(narrowBlock, /\.home-info-strip__ask \{/, 'the narrow-shell block still exists');
  assert.equal(narrowBlock.includes('.home-ask__panel'), false);

  // Home bans gradients; the panel inherits the popover primitive's solid fill.
  const askConfigCss = heroCss.match(/\n\.home-ask-config[\s\S]*$/)?.[0] || '';
  assert.doesNotMatch(askConfigCss, /gradient\(/, 'Home bans gradients');
});

/* Information is always visible; controls appear on demand. The hint applies
 * only while the field has focus and only until there is something to send;
 * the send button is the reverse. Neither may reserve width at rest - that was
 * the config chip's mistake. */
test('the hint and the send button swap in the same slot without reserving a lane', () => {
  const heroCss = readRepoFile('styles/views-home-hero.css');

  const hintRule = heroCss.match(/\n\.home-ask__hint \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(hintRule, 'the hint still has a base rule');
  assert.match(hintRule, /position:\s*absolute;/, 'the resting state costs no width on the row');
  assert.match(hintRule, /opacity:\s*0;/, 'hidden at rest');
  assert.match(hintRule, /visibility:\s*hidden;/);
  assert.match(hintRule, /pointer-events:\s*none;/);

  const revealRule = heroCss
    .match(/\n\.home-info-strip__ask:focus-within \.home-ask__hint \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(revealRule, 'focus-within is what reveals it');
  assert.match(revealRule, /opacity:\s*1;/);
  assert.match(revealRule, /visibility:\s*visible;/);

  // Once there is text the hint gives the slot up to the send button.
  const filledHintRule = heroCss
    .match(/\n\.home-info-strip__ask\[data-ask-filled="1"\] \.home-ask__hint \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(filledHintRule, /visibility:\s*hidden;/);

  const sendRule = heroCss.match(/\n\.home-ask__send \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(sendRule, 'F5 - there is a pointer path to submit');
  assert.match(sendRule, /border-radius:\s*var\(--radius-pill\);/);
  assert.match(
    sendRule,
    /background:\s*color-mix\(in srgb, var\(--accent\) 55%, var\(--text-primary\)\);/,
    'blended toward --text-primary: a bare accent fill drops under 4.5:1 on the light palettes'
  );
  assert.match(sendRule, /visibility:\s*hidden;/, 'hidden until it applies');
  assert.match(sendRule, /pointer-events:\s*none;/, 'and unclickable while hidden');

  const filledSendRule = heroCss
    .match(/\n\.home-info-strip__ask\[data-ask-filled="1"\] \.home-ask__send \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(filledSendRule, /visibility:\s*visible;/);
  assert.match(filledSendRule, /pointer-events:\s*auto;/);

  // Busy: the send reads as occupied and stops taking clicks, matching the
  // keydown path's in-flight latch.
  const busyRule = heroCss
    .match(/\n\.home-info-strip__ask\[data-ask-busy="1"\] \.home-ask__send \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(busyRule, /pointer-events:\s*none;/);

  // Reduced motion opts out of the fades rather than out of the reveals.
  assert.match(
    heroCss,
    /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.home-ask__hint \{\n\s*transition:\s*none;/
  );
});

/* The page menu replaces the two chrome-hosted toggles: one [⋯] trigger in
 * the ask pill's family (same 32px hairline/pill/wash idiom) with flat menu
 * rows, and an active step PAST hover while a mode is on. */
test('the page-menu trigger wears the pill idiom and its rows stay flat', () => {
  const heroCss = readRepoFile('styles/views-home-hero.css');

  const triggerRule = heroCss.match(/\n\.home-page-menu__trigger \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(triggerRule, /--btn-min-height:\s*32px;/, 'same height as the pill');
  assert.match(triggerRule, /min-width:\s*32px;/);
  assert.match(triggerRule, /border-radius:\s*var\(--radius-pill\);/, 'the pill radius, not a soft rect');
  assert.match(triggerRule, /border:\s*1px solid var\(--border-default\);/, 'a hairline at REST, like the pill');
  assert.match(
    triggerRule,
    /background:\s*color-mix\(in srgb, var\(--accent\) 4%, transparent\);/,
    'the same 4% accent wash the pill and palette pill rest on'
  );

  const hoverRule = heroCss
    .match(/\n\.home-page-menu__trigger:hover,\n\.home-page-menu__trigger\[aria-expanded="true"\] \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(hoverRule, /border-color:\s*var\(--accent-a-30\);/);
  assert.match(hoverRule, /background:\s*var\(--accent-a-12\);/);

  // Active must step PAST hover — the resting pill beside it carries a border
  // and a wash of its own, so a subtler tint would read as no state.
  const activeRule = heroCss.match(/\n\.home-page-menu__trigger--active \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(activeRule, /border-color:\s*var\(--accent-a-50\);/);
  assert.match(activeRule, /background:\s*var\(--accent-a-20\);/);

  // The menu host anchors its popover WITHOUT a transform, so it must never
  // need the W11.1 z-index lift; if a transform ever lands here the host has
  // to carry the popover layer itself (same bug class as the config chip).
  const hostRule = heroCss.match(/\n\.home-page-menu \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(hostRule, /position:\s*relative;/);
  if (/transform:/.test(hostRule)) {
    assert.match(hostRule, /z-index:\s*var\(--z-popover\);/,
      'a transformed popover anchor must lift itself to the popover layer');
  }

  // Rows are flat: no borders/boxes, a soft neutral hover wash only.
  const itemRule = heroCss.match(/\n\.home-page-menu__item \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(itemRule, /border:\s*0;/, 'menu rows are flat, not boxed');
  assert.match(itemRule, /background:\s*transparent;/);
  const itemHoverRule = heroCss.match(/\n\.home-page-menu__item:hover \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(
    itemHoverRule,
    /background:\s*color-mix\(in srgb, var\(--text-primary\) 7%, transparent\);/
  );

  // And the cluster's own gaps survive the move.
  const stripRule = heroCss.match(/\n\.home-info-strip \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(stripRule, /gap:\s*var\(--space-5\);/, 'one gap value across the hero row');
  const askRule = heroCss.match(/\n\.home-info-strip__ask \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(askRule, /gap:\s*var\(--space-4\);/, 'pill-to-trigger matches the old toggle scale');
});

/* Ask menu interior: flat label-left / control-right rows. The generic field
 * chrome (border + fill box) comes from UNSCOPED setup-wizard rules in
 * views-home-setup.css — the panel restates it away at higher specificity,
 * which is what killed the "card in a card" look. ONE container only: no
 * hairline over the tools group, none over the footer — space separates them. */
test('the ask panel flattens its fields and draws no internal dividers', () => {
  const heroCss = readRepoFile('styles/views-home-hero.css');

  const fieldRule = heroCss
    .match(/\n\.home-ask__panel \.inv-select-field-control \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(fieldRule, 'the panel scopes its own select-control look');
  assert.match(fieldRule, /border:\s*1px solid transparent;/, 'no field box inside the boxed panel');
  assert.match(fieldRule, /background:\s*transparent;/);
  assert.match(fieldRule, /text-align:\s*right;/, 'the value reads against its left label');

  const labelRule = heroCss
    .match(/\n\.home-ask__panel \.inv-select-field-label \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(labelRule, /text-transform:\s*none;/, 'no uppercase micro-label in the menu');
  assert.match(labelRule, /color:\s*var\(--text-secondary\);/);

  // Toggle rows flip to label-left / switch-right off the primitive's
  // track-first markup, keeping the whole panel one column of quiet rows.
  const toggleRule = heroCss.match(/\n\.home-ask-config__toggle \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(toggleRule, /flex-direction:\s*row-reverse;/);
  assert.match(toggleRule, /justify-content:\s*space-between;/);

  // ONE container only: the internal hairlines are GONE, and space does the
  // separating. The primitive ships a border-top on .inv-popover-footer, so the
  // panel has to restate it away rather than simply omitting a rule.
  const toolsRule = heroCss.match(/\n\.home-ask-config__tools \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(toolsRule, /border-top:/, 'nothing is boxed or ruled inside the one box');
  assert.match(toolsRule, /margin-top:\s*var\(--space-5\);/, 'space separates the groups');
  const footerRule = heroCss
    .match(/\n\.home-ask__panel \.inv-popover-footer \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(footerRule, /border-top:\s*0;/, 'the primitive\'s hairline is restated away');
  assert.match(footerRule, /line-height:\s*1\.5;/, 'the caption breathes instead of cramming');

  // The popover primitive's open animation honors reduced motion (systemic:
  // every .inv-popover consumer, not just Home).
  const invCss = readRepoFile('renderer/inventory/inventory-chip-popover.css');
  assert.match(
    invCss,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.inv-popover \{\n\s*animation:\s*none;/,
    'the popover open animation is disabled under prefers-reduced-motion'
  );
});

/* A native <select> is intrinsically as wide as its WIDEST option - here full
 * model ids plus an unbounded "(unavailable: reason)" tail - and grid/flex items
 * floor at min-content. With an indefinite panel width that floor won: max-width
 * clamped only the PAINTED box, so the Model and Reasoning-effort controls drew
 * OUTSIDE the panel's own border, both right-aligned to the same over-wide
 * track. The fix is a definite width plus a min-width: 0 chain all the way down
 * to the control, which is also what finally arms its text-overflow. */
test('the ask panel caps its own width and its selects ellipsize inside it', () => {
  const heroCss = readRepoFile('styles/views-home-hero.css');

  const panelRule = heroCss.match(/\n\.home-ask__panel \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(panelRule, 'the panel has a rule');
  assert.match(panelRule, /\n\s*width:\s*320px;/, 'a DEFINITE width - a min/max pair leaves it indefinite');
  assert.doesNotMatch(panelRule, /\n\s*min-width:/, 'the old min/max pair is gone');

  const rowRule = heroCss.match(/\n\.home-ask-config__row \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(rowRule, /grid-template-columns:\s*minmax\(0, 1fr\);/,
    'a bare auto track floors at the widest option and overflows the panel');

  const toolsRule = heroCss.match(/\n\.home-ask-config__tools \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(toolsRule, /grid-template-columns:\s*minmax\(0, 1fr\);/);

  const effortRule = heroCss.match(/\n\.home-ask-config__effort \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(effortRule, /min-width:\s*0;/, 'the effort host is a grid item too');

  const fieldRule = heroCss.match(/\n\.home-ask__panel \.inv-select-field \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fieldRule, /min-width:\s*0;/, 'the row must be allowed to shrink');

  const controlRule = heroCss
    .match(/\n\.home-ask__panel \.inv-select-field-control \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(controlRule, /min-width:\s*0;/, 'max-width alone is not a floor release');
  assert.match(controlRule, /overflow:\s*hidden;/, 'text-overflow is inert without it');
  assert.match(controlRule, /white-space:\s*nowrap;/);
  assert.match(controlRule, /text-overflow:\s*ellipsis;/, 'a long model id truncates, it does not spill');

  /* Systemic, not Home-only: every popover-hosted select rides the same trap,
   * so the floor is released on the unscoped primitive as well. */
  const setupCss = readRepoFile('styles/views-home-setup.css');
  const primitiveRule = setupCss
    .match(/\n\.inv-select-field,\n\.inv-select-field-control \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(primitiveRule, 'the select primitive releases its min-width floor');
  assert.match(primitiveRule, /min-width:\s*0;/);
});

/* W8-2: the rail pad auto-grows. The widget writes the height; the stylesheet
 * owns the ceiling and the scroll-again behaviour past it. */
test('the scratchpad field declares an auto-grow ceiling and scrolls past it', () => {
  const dashboardCss = readRepoFile('styles/views-home-dashboard.css');
  const fieldRule = dashboardCss
    .match(/\n\.dashboard-scratchpad \.inv-text-field-control \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(fieldRule, /max-height:\s*var\(--home-scratchpad-max-height, 46vh\);/);
  assert.match(fieldRule, /overflow-y:\s*auto;/, 'past the cap the field scrolls internally');
  assert.match(fieldRule, /min-height:\s*96px;/, 'the resting floor is unchanged');
});

test('artifact review selectors live in their focused stylesheet', () => {
  const focusedCss = readRepoFile('styles/views-artifacts.css');
  const parentCss = readRepoFile('styles/views-home-artifacts.css');

  for (const selector of [
    '.artifacts-detail-panel {',
    '.artifact-editor-shell,',
    '.artifact-preview-mermaid-host {',
  ]) {
    assertMovedRuleStart({ focusedCss, parentCss, selector });
  }
});

test('home setup and inventory primitive selectors live in their focused stylesheet', () => {
  const focusedCss = readRepoFile('styles/views-home-setup.css');
  const parentCss = readRepoFile('styles/views-home-artifacts.css');

  for (const selector of [
    '.setup-scene-body {',
    '.setup-cap-body {',
  ]) {
    assertMovedRuleStart({ focusedCss, parentCss, selector });
  }

  // The Home setup CARD selectors went with the card itself; only the wizard's
  // focused SCENE chrome remains in this stylesheet.
  assert.doesNotMatch(focusedCss, /\.home-setup-tile/, 'the retired card selectors stay deleted');
  assert.doesNotMatch(parentCss, /\.home-setup-tile/);
});
