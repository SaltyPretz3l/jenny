const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertOmits(relativePath, selectors) {
  const css = readRepoFile(relativePath);
  for (const selector of selectors) {
    assert.equal(css.includes(selector), false, `${relativePath} still contains ${selector}`);
  }
}

test('timeline keyframes have one owner and retired motion files stay removed', () => {
  const cssFiles = fs.readdirSync(path.join(repoRoot, 'styles'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.css'))
    .map((entry) => path.join('styles', String(entry)));
  cssFiles.push(...fs.readdirSync(path.join(repoRoot, 'renderer', 'inventory'))
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => path.join('renderer', 'inventory', entry)));
  const css = cssFiles.map(readRepoFile).join('\n');
  for (const name of [
    'status-dot-pulse', 'tool-call-running-breathe', 'shimmer-text',
    'hero-exit', 'thread-enter', 'thread-entry-item', 'chat-copy-chip-fade',
    'assistant-stream-pulse', 'turn-activity-fold-left', 'turn-activity-fold-right',
    'turn-activity-checklist-draw',
  ]) {
    assert.equal(Array.from(css.matchAll(new RegExp(`@keyframes\\s+${name}\\s*\\{`, 'g'))).length, 1, name);
  }
  const imports = readRepoFile('styles.css');
  for (const name of ['chat-animations.css', 'chat-send-lifecycle-v2.css']) {
    assert.equal(fs.existsSync(path.join(repoRoot, 'styles', name)), false, `${name} is retired`);
    assert.equal(imports.includes(name), false, `${name} must not be imported`);
  }
});

test('timeline paint skipping uses the shared class and Mermaid height changes are instant', () => {
  assert.doesNotMatch(readRepoFile('styles/chat-thread.css'), /#chatTimeline/);
  const iframe = readRepoFile('styles/chat-tools.css').match(/\.tool-mermaid-preview iframe\s*\{[^}]*\}/)?.[0];
  assert.ok(iframe, 'the Mermaid iframe rule remains styled');
  assert.doesNotMatch(iframe, /\btransition\s*:/);
});

test('timeline typography and bubble radius use the --tl-* token contract', () => {
  const heroSelectors = [
    '.hero-avatar', '.hero-title', '.hero-subtitle', '.hero-runtime-hint',
  ];
  // No timeline aliases match the 20px plan title or 14px approval prompt.
  // The brand glyph retains the explicitly excluded heading-size treatment.
  // Remove only these exact declarations, leaving every other use guarded.
  const preservedSizes = {
    'styles/chat-machinery.css': [
      /^(\.plan-document__title\s*\{[^}]*?)font-size:\s*var\(--font-size-title\);/m,
    ],
    'styles/chat-tools.css': [
      /^(\.tool-approval-prompt\s*\{[^}]*?)font-size:\s*var\(--font-size-body\);/m,
    ],
    'styles/chat-thread.css': [
      /^(\.chat-assistant-sprite-glyph\s*\{[^}]*?)font-size:\s*var\(--font-size-heading\);/m,
    ],
  };
  for (const relativePath of [
    'styles/chat-machinery.css',
    'styles/chat-tools.css',
    'styles/chat-tool-block-v2.css',
    'styles/chat-thread.css',
  ]) {
    let css = readRepoFile(relativePath);
    if (relativePath === 'styles/chat-thread.css') {
      // Only these landing hero rules are outside the timeline type contract.
      for (const selector of heroSelectors) {
        const escaped = selector.replaceAll('.', '\\.');
        const rule = new RegExp(`^${escaped}\\s*\\{[^}]*\\}`, 'm');
        assert.match(css, rule, `expected the explicit hero exception ${selector}`);
        css = css.replace(rule, '');
      }
    }
    for (const declaration of preservedSizes[relativePath] || []) {
      assert.match(css, declaration, `${relativePath} retains its unmatched size`);
      css = css.replace(declaration, '$1');
    }
    assert.doesNotMatch(css, /var\(\s*--font-size-/, `${relativePath} bypasses timeline font tokens`);
    assert.doesNotMatch(css, /\bfont-weight:\s*500\b/, `${relativePath} bypasses timeline label weight`);
    if (relativePath !== 'styles/chat-thread.css') {
      // chat-thread.css keeps base radii on its non-timeline rules (sprites, hero).
      assert.doesNotMatch(css, /var\(\s*--radius-(?:sm|base|md|pill)\b/, `${relativePath} bypasses timeline radius tokens`);
      assert.doesNotMatch(css, /border-radius:\s*999px/, `${relativePath} bypasses the chip radius token`);
    }
  }
  assert.match(
    readRepoFile('styles/chat-timeline-tokens.css'),
    /--tl-radius-bubble:\s*var\(--radius-md\);/,
    'the bubble radius aliases the existing medium radius'
  );
});

test('retired artifact shelf stubs are deleted', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'styles', 'artifact-shelf.css')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'styles', 'artifact-shelf-v2.css')), false);
});

test('timeline diff CSS is flat while the legacy artifact hunk layout stays scoped', () => {
  const diffCss = readRepoFile('styles/chat-tool-diff.css');
  const artifactCss = readRepoFile('styles/artifact-panel.css');
  const toolCss = readRepoFile('styles/chat-tools.css');
  assert.match(diffCss, /\.file-diff-body[\s\S]*?min-width:\s*4ch/);
  assert.match(diffCss, /\.file-diff-body \.diff-gap/);
  assert.equal(diffCss.includes('.diff-hunk-header'), false);
  assert.equal(diffCss.includes('.turn-diff-'), false);
  assert.match(artifactCss, /\.artifact-output-body \.diff-hunk-header/);
  const detailsRule = toolCss.match(/\.tool-call-details\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.equal(detailsRule.includes('border-left'), false);
});

test('broken CSS token references use canonical foundation tokens', () => {
  const repairs = {
    'styles/chat-composer-meta-affordances.css': [
      ['var(--accent-pink)', 'var(--accent)'],
      ['var(--accent-green)', 'var(--state-success)'],
    ],
    'styles/chat-interactive.css': [['var(--font-mono)', 'var(--font-family-mono)']],
    'styles/ide-explode-view.css': [['var(--font-mono)', 'var(--font-family-mono)']],
    'styles/data-lifecycle.css': [
      ['var(--font-family-ui)', 'var(--font-family-body)'],
      ['var(--text-strong)', 'var(--text-primary)'],
    ],
    'styles/chat-thread-rail.css': [
      ['var(--text-strong)', 'var(--text-primary)'],
      ['var(--text-base)', 'var(--text-primary)'],
    ],
    'styles/ide-diff-toolbar.css': [['var(--bg-surface-1)', 'var(--bg-surface)']],
    'styles/ide-file-map.css': [['var(--warning, var(--state-warning))', 'var(--state-warning)']],
    'styles/surface-states.css': [['var(--widget-badge-danger-background)', 'var(--state-danger)']],
    'renderer/inventory/inventory-drawer.css': [
      ['var(--bg-app)', 'var(--bg-base)'],
      ['var(--shadow-elevation-4)', 'var(--shadow-float)'],
      ['var(--bg-surface-hover)', 'var(--text-primary)'],
    ],
  };

  for (const [relativePath, pairs] of Object.entries(repairs)) {
    const css = readRepoFile(relativePath);
    for (const [stale, canonical] of pairs) {
      assert.equal(css.includes(stale), false, `${relativePath} still contains ${stale}`);
      assert.equal(css.includes(canonical), true, `${relativePath} is missing ${canonical}`);
    }
  }
});

test('retired feature and dead utility selectors stay removed', () => {
  const removedByFile = {
    'styles/views-home-setup.css': ['.chatgpt-connect-'],
    // Open Loops rows carry status in the meta line; the edge-to-edge row tints
    // and the vestigial first-row / details-disclosure hooks are gone.
    'styles/views-home-board.css': [
      '[data-loop-due="true"]',
      '.memory-commitment-item',
      '.home-loop-history-toggle',
      '.home-loop-meta-block',
    ],
    // Subagent Monitor v2: the master/detail split and the stage-grid host are gone.
    'styles/chat-subagent-monitor.css': [
      '.subagent-monitor-master',
      '.subagent-monitor-detail-pane',
      '.subagent-monitor-tree-pane',
      '.subagent-monitor-kicker',
      '.subagent-monitor-parent-state',
      '.subagent-tool-list',
      '.subagent-tool-row',
      '.subagent-monitor-open',
      '.is-compact',
      '.is-hidden-compact',
    ],
    'styles/chat-composer-v2.css': [
      '.composer-popover-trigger',
      '.composer-slash-launcher',
      '.composer-mic-button',
      '.composer-signal-group',
    ],
    'styles/chat-composer.css': [
      '.composer-icon-tools',
      '.composer-mic-button',
      '.composer-mode-button',
      '.attachment-chip-retry:focus-visible',
      '@keyframes mic-hot-',
    ],
    'styles/chat-composer-meta-affordances.css': [
      '.composer-signal-group',
      '.composer-meta-signal',
    ],
    'styles/views-artifacts.css': [
      '.artifacts-shell',
      '.artifacts-page-header',
      '.artifacts-toolbar',
      '.artifacts-filter-',
      '.artifacts-list',
    ],
    'styles/artifacts-studio.css': [
      '.artifacts-workspace',
      '.artifacts-catalog',
      '.artifacts-editor-pane',
      '.artifacts-meta-pane',
      '.artifacts-pane-header',
      '.artifacts-meta-scroll',
    ],
    'styles/views-home-artifacts.css': [
      '.page-header',
      '.home-hero',
      '.home-presence-',
      '.home-next-move-',
    ],
    'styles/settings-mcp-servers.css': [
      '.mcp-servers-header-actions',
      '.mcp-servers-row-main',
      '.mcp-servers-row-meta',
      '.mcp-servers-note--warn',
      '.mcp-servers-note-code',
      '.mcp-servers-auth-editor',
      '.mcp-servers-auth-editor-header',
      '.mcp-servers-auth-kind-chip',
      '.mcp-servers-auth-input',
      '.mcp-servers-clear-btn',
      '.mcp-servers-gate-footer',
    ],
    'styles/settings-plugins.css': [
      '.plugins-settings-eligibility',
      '.plugins-settings-row-id',
      '.plugins-install-slot',
      '.plugins-privileged-status',
      '.plugins-contribution-list',
      '.plugin-manager-heading',
      '.plugin-manager-overflow',
    ],
    'styles/foundation.css': ['.brand-icon', '.brand-icon-core', '.brand-name', '.titlebar-divider'],
    // Legacy static artifact header (V3 replaces the markup via innerHTML) and
    // the dead V2 header/toolbar/footer chrome.
    'styles/context-panel.css': [
      '.artifact-review-header',
      '.artifact-review-heading',
      '.artifact-review-kicker',
      '.artifact-review-status',
      '.artifact-review-actions',
      '.artifact-review-action',
      '--artifact-dossier-pane-bg',
      '--mat-live-bg',
    ],
    'styles/artifact-panel.css': [
      '.artifact-panel-v2-header',
      '.artifact-panel-v2-title',
      '.artifact-panel-v2-toolbar',
      '.artifact-panel-v2-text-btn',
      '.artifact-panel-v2-save-',
      '.artifact-panel-v2-delete-btn',
      '.artifact-panel-v2-footer {',
      '.artifact-panel-v2-footer-meta',
    ],
    'styles/shell-chrome.css': ['.status-strip', '.backend-banner', '.workspace.sidebar-inactive'],
    'styles/workspace-rail.css': ['.workspace-rail-tooltip', '.workspace.sidebar-inactive'],
    'renderer/inventory/inventory.css': [
      '.inv-tool-group',
      '.inv-tool-group-header',
      '.inv-tool-group-body',
      '.inv-error-recovery-header',
      '.inv-error-recovery-message',
      '.inv-error-recovery-hint',
      '.inv-error-recovery-actions',
    ],
    'styles/motion.css': ['.anim-fade-up', '.anim-slide-in-up', '.anim-loop-fade-out'],
    'styles/chat-selection-v2.css': ['[data-selection-mode="true"]'],
  };

  for (const [relativePath, selectors] of Object.entries(removedByFile)) {
    assertOmits(relativePath, selectors);
  }
});

test('dynamic state and live combined-selector members remain styled', () => {
  const retainedByFile = {
    'styles/views-home-board.css': [
      '[data-loop-status="resolved"]',
      '[data-loop-status="archived"]',
      '[data-loop-resolving="true"]',
    ],
    'styles/views-home-dashboard.css': [
      '[data-focus-mode="on"]',
      '[data-widget-state="error"]',
    ],
    'styles/activity.css': [
      '[data-activity-emphasis="subtle"]',
      '[data-activity-emphasis="visible"]',
      '[data-activity-emphasis="strong"]',
    ],
    'styles/chat-selection-v2.css': ['.chat-entry[data-selected]'],
    'styles/foundation.css': ['.stat-divider'],
    'renderer/inventory/inventory.css': ['.inv-error-action'],
    'styles/views-home-artifacts.css': ['@keyframes homeSurfaceSettle'],
  };

  for (const [relativePath, selectors] of Object.entries(retainedByFile)) {
    const css = readRepoFile(relativePath);
    for (const selector of selectors) {
      assert.equal(css.includes(selector), true, `${relativePath} is missing ${selector}`);
    }
  }
});

test('webkit line clamps retain the complete Chromium truncation trio', () => {
  // chat-thread.css left this list when scroll-W4a removed its only clamp rule
  // (.chat-pin-bubble-text died with the pin overlay branch).
  for (const relativePath of [
    'styles/artifacts-studio.css',
    'styles/views-artifacts.css',
  ]) {
    const css = readRepoFile(relativePath);
    const clampedRules = Array.from(css.matchAll(/[^{}]+\{[^{}]*-webkit-box-orient:\s*vertical;[^{}]*\}/g), (match) => match[0]);

    assert.ok(clampedRules.length > 0, `${relativePath} should retain at least one line-clamp rule`);
    for (const rule of clampedRules) {
      assert.match(rule, /display:\s*-webkit-box;/);
      assert.match(rule, /-webkit-line-clamp:\s*\d+;/);
    }
  }
});

test('every --font-* custom property referenced in styles/ is defined in styles/', () => {
  // `var(--font-mono)` was repaired in two files once already (see the
  // canonical-token test above) and then regressed into twelve more, because
  // an undefined custom property is not a parse error - the browser silently
  // takes the inline fallback. Collect definitions across the WHOLE tree
  // before judging any reference: foundation.css defines, everyone else uses.
  const cssFiles = fs.readdirSync(path.join(repoRoot, 'styles'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.css'))
    .map((entry) => path.join('styles', String(entry)).split(path.sep).join('/'));
  assert.ok(cssFiles.length > 50, `expected the full styles/ tree, got ${cssFiles.length} files`);

  const defined = new Set();
  const used = [];
  for (const relativePath of cssFiles) {
    const css = readRepoFile(relativePath);
    for (const match of css.matchAll(/(--font-[A-Za-z0-9-]+)\s*:/g)) {
      defined.add(match[1]);
    }
    for (const match of css.matchAll(/var\(\s*(--font-[A-Za-z0-9-]+)/g)) {
      used.push({ name: match[1], relativePath });
    }
  }

  // Guard the guard: if the regexes ever stop matching, the loop above would
  // pass vacuously with two empty sets.
  assert.ok(defined.has('--font-family-mono'), 'expected --font-family-mono to be collected as defined');
  assert.ok(used.some((entry) => entry.name === '--font-family-mono'), 'expected --font-family-mono uses to be collected');

  const undefinedRefs = used.filter((entry) => !defined.has(entry.name));
  assert.deepEqual(
    undefinedRefs.map((entry) => `${entry.relativePath} -> ${entry.name}`),
    [],
    'undefined --font-* references silently fall back instead of using the token'
  );
});

test('no `font:` shorthand omits the mandatory font-family', () => {
  // font-family is REQUIRED by the `font` shorthand grammar, so
  // `font: var(--tl-font-meta);` is invalid at computed-value time and resets
  // every font longhand to unset (= inherit). It reads like a font-size
  // assignment and does the opposite. Six shipped in artifact-panel.css.
  const cssFiles = fs.readdirSync(path.join(repoRoot, 'styles'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.css'))
    .map((entry) => path.join('styles', String(entry)).split(path.sep).join('/'));

  const offenders = [];
  for (const relativePath of cssFiles) {
    for (const match of readRepoFile(relativePath).matchAll(/font:\s*var\([^)]*\)\s*;/g)) {
      offenders.push(`${relativePath} -> ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'family-less `font:` shorthands are dropped by the browser');

  // The well-formed shorthands in the same file must survive the sweep - a fix
  // that deleted them wholesale would also pass the assertion above.
  const artifactCss = readRepoFile('styles/artifact-panel.css');
  assert.match(artifactCss, /font:\s*var\(--tl-font-ui\)\/1\.4 var\(--font-family-mono\);/);
  assert.match(artifactCss, /font-size:\s*var\(--tl-font-meta\);/);
});

test('code surfaces declare mono locally because styles/ has no global pre/code reset', () => {
  const cssFiles = fs.readdirSync(path.join(repoRoot, 'styles'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.css'))
    .map((entry) => path.join('styles', String(entry)).split(path.sep).join('/'));

  // The premise: nothing resets bare pre/code. chat-machinery.css claimed
  // otherwise in a comment for long enough that its <pre> blocks rendered in
  // the UA fixed font. If a global reset is ever added, this assertion fires
  // and the per-component declarations below need revisiting.
  const globalResets = cssFiles.filter((relativePath) => (
    /^[ \t]*(?:pre|code|kbd|samp)\s*(?:,\s*(?:pre|code|kbd|samp)\s*)*\{[^}]*font-family/m
      .test(readRepoFile(relativePath))
  ));
  assert.deepEqual(globalResets, [], 'a global pre/code font reset would make per-component mono ambiguous');

  const machineryCss = readRepoFile('styles/chat-machinery.css');
  const liveOutputRule = machineryCss.match(/\.tool-live-output-text,\n\.tool-live-output-partial \{[\s\S]*?\}/)?.[0] || '';
  assert.notEqual(liveOutputRule, '', 'expected the .tool-live-output-* rule to still exist');
  assert.match(liveOutputRule, /font-family:\s*var\(--font-family-mono\);/);
  assert.equal(
    machineryCss.includes('Monospace comes from the global <pre> treatment'),
    false,
    'the stale comment asserted a global pre rule that does not exist'
  );
});

test('the typography preference remaps the mono face, not just body and display', () => {
  const foundationCss = readRepoFile('styles/foundation.css');
  for (const preset of ['editorial', 'technical']) {
    const rule = foundationCss.match(
      new RegExp(`:root\\[data-typography="${preset}"\\] \\{[\\s\\S]*?\\}`)
    )?.[0] || '';
    assert.notEqual(rule, '', `expected a :root[data-typography="${preset}"] block`);
    assert.match(rule, /--font-family-body:/);
    assert.match(rule, /--font-family-mono:/);
  }
  // JetBrains Mono is not bundled and is absent on a stock Windows install, so
  // the base stack must name a real fallback before the generic keyword.
  assert.match(foundationCss, /--font-family-mono:[^;]*ui-monospace,\s*Consolas,\s*monospace;/);
});

test('right-rail panels share one flat --side-panel-bg and gutter token, with no gradient', () => {
  const foundationCss = readRepoFile('styles/foundation.css');
  const contextCss = readRepoFile('styles/context-panel.css');
  const bg = foundationCss.match(/--side-panel-bg:\s*([^;]+);/);
  assert.ok(bg, 'foundation defines --side-panel-bg');
  assert.doesNotMatch(bg[1], /gradient/);
  assert.match(foundationCss, /--side-panel-gutter:\s*16px;/);
  const rule = (selector) => {
    const start = contextCss.indexOf(selector + ' {');
    assert.notEqual(start, -1, selector);
    return contextCss.slice(start, contextCss.indexOf('}', start));
  };
  assert.match(rule('.chat-context-panel'), /background: var\(--side-panel-bg\);/);
  assert.match(rule('.artifact-review-panel'), /background: var\(--side-panel-bg\);/);
  assert.match(rule('.artifact-review-panel.artifact-review-overlay'), /background: var\(--side-panel-bg\);/);
  assert.equal(/artifact-review-header[^{]*\{[^}]*gradient/.test(contextCss), false, 'legacy header gradient is gone');
});
