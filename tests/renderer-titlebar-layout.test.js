const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

function readRepoFile(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

function extractScriptSources(html) {
  return [...html.matchAll(/<script\s+[^>]*src="([^"]+)"[^>]*><\/script>/gi)]
    .map((match) => match[1]);
}

test('one title-bar row: wordmark, view nav, drag gutter, right cluster, window controls', () => {
  const html = readRepoFile('index.html');
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const titlebar = doc.querySelector('.titlebar');
  assert.ok(titlebar, 'titlebar should exist');

  const directChildren = Array.from(titlebar.children).map((el) => el.classList[0]);
  assert.deepEqual(directChildren, [
    'titlebar-brand',
    'toprail',
    'titlebar-center',
    'titlebar-status',
    'window-controls',
  ]);

  // The view nav lives inside the title bar (the 48px rail row is retired).
  assert.equal(doc.getElementById('topRail').parentElement, titlebar);
  assert.ok(doc.getElementById('topRail').classList.contains('titlebar-nav-row'));
  assert.equal(doc.getElementById('topRailActions'), null, 'the dead #topRailActions mount is gone');
  const center = titlebar.querySelector(':scope > .titlebar-center');
  const status = titlebar.querySelector(':scope > .titlebar-status');
  // Pinned notes ride in the drag gutter; the retired turn pill stays gone.
  assert.equal(center.querySelector('#pinnedNoteTabs')?.parentElement, center);
  assert.equal(doc.getElementById('turnStatusPill'), null);
  // Right cluster: health dot first (it widens leftward without moving an icon), read-out, search glyph, gear.
  assert.deepEqual(
    Array.from(status.children).map((el) => el.id),
    ['workbenchHealthPillSlot', 'metricList', 'titlebarPalettePill', 'titlebarSettingsSlot'],
  );
  assert.equal(titlebar.querySelector('#titlebarThreadMapPill'), null);
});

test('the palette trigger is a search glyph; its label and keycap live in the tooltip', () => {
  const doc = new JSDOM(readRepoFile('index.html')).window.document;
  const pill = doc.getElementById('titlebarPalettePill');
  assert.equal(pill.querySelector('.palette-pill-label'), null);
  assert.equal(pill.querySelector('kbd'), null);
  assert.ok(pill.querySelector('svg.titlebar-icon circle'), 'search glyph');
  assert.equal(pill.getAttribute('data-i18n-title'), 'titlebar.commandPalette.openTitle');
  const css = readRepoFile('styles', 'foundation.css');
  assert.match(css, /\.kbd\s*\{[^}]*white-space:\s*nowrap;/, 'a keycap never wraps');
});

test('pinned-note titlebar tabs opt out of the draggable region', () => {
  const shellChromeCss = readRepoFile('styles', 'shell-chrome.css');
  assert.match(
    shellChromeCss,
    /\.pin-tabs\s*,\s*\.pin-tab\s*\{[\s\S]*-webkit-app-region:\s*no-drag;/,
    'pinned-note tabs must opt out of the draggable titlebar region so clicks select instead of drag'
  );
});

test('titlebar CSS: bounded tracks, a guaranteed drag gutter, a nav row below 1200px', () => {
  const foundationCss = readRepoFile('styles', 'foundation.css');
  const shellChromeCss = readRepoFile('styles', 'shell-chrome.css');

  assert.match(
    foundationCss,
    /\.titlebar\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*max-content\)\s+minmax\(var\(--titlebar-drag-gutter\),\s*1fr\)\s+auto\s+auto;[^}]*grid-template-areas:\s*"brand nav gutter status controls";/,
    'brand, nav (the track that yields), gutter, cluster and window controls'
  );
  assert.match(foundationCss, /--toprail-height:\s*0px;/, 'the rail row is retired');
  assert.match(foundationCss, /--titlebar-row-height:\s*52px;/);
  assert.match(
    shellChromeCss,
    /@media \(max-width: 1199px\)\s*\{\s*:root\s*\{\s*--titlebar-nav-row-height:\s*40px;/,
    'below 1200px the nav drops to a 40px second row'
  );
  assert.ok(shellChromeCss.includes('.titlebar-status {'), 'the cluster rule exists');
  assert.doesNotMatch(
    shellChromeCss.slice(shellChromeCss.indexOf('.titlebar-status {')),
    /^\.titlebar-status\s*\{[^}]*-webkit-app-region:\s*no-drag;/,
    'no-drag is scoped to the interactive children of the cluster, not its gaps'
  );
  assert.match(
    shellChromeCss,
    /\.window-controls\s*\{[^}]*grid-area:\s*controls;[^}]*flex-shrink:\s*0;[^}]*align-self:\s*stretch;/,
    'window controls sit in their own track and never shrink'
  );
  assert.match(
    shellChromeCss,
    /\.window-button\s*\{[\s\S]*-webkit-app-region:\s*no-drag;/,
    'each window control button must opt out of the draggable titlebar region'
  );
});

test('narrow titlebar bounds status content without sacrificing the brand or window controls', () => {
  const shellChromeCss = readRepoFile('styles', 'shell-chrome.css');
  const commandPaletteCss = readRepoFile('styles', 'command-palette.css');
  const mediaStart = shellChromeCss.indexOf('@media (max-width: 480px)');
  assert.ok(mediaStart >= 0, 'narrow titlebar media block should exist');
  const media = shellChromeCss.slice(mediaStart);

  assert.match(
    media,
    /\.titlebar\s*\{[^}]*grid-template-columns:\s*auto\s+0\s+minmax\(0,\s*1fr\)\s+auto;/,
    'narrow titlebar should reserve fixed brand and window-control tracks around a bounded status track'
  );
  assert.match(
    media,
    /\.titlebar-status\s*\{[^}]*overflow:\s*hidden;/,
    'narrow status content must not paint through the wordmark or controls'
  );
  assert.match(
    media,
    /\.titlebar-status\s*>\s*\.metric-list\s*\{[^}]*display:\s*none;/,
    'nonessential telemetry should yield at narrow widths'
  );
  assert.doesNotMatch(media, /\.window-(controls|button)/, 'the <=480px block never touches the window cluster');
  assert.match(
    commandPaletteCss,
    /@media\s*\(max-width:\s*320px\)\s*\{[\s\S]*?\.titlebar-palette-pill\s*\{[^}]*display:\s*none;/,
    'the duplicate palette affordance should yield when brand and window controls consume the ultranarrow titlebar'
  );
});

test('machine-load read-out: fixed slots and tabular figures, no refresh button styling', () => {
  const shellChromeCss = readRepoFile('styles', 'shell-chrome.css');
  assert.match(shellChromeCss, /\.metric-list\s*\{[^}]*font-size:\s*var\(--font-size-footnote\);[^}]*font-variant-numeric:\s*tabular-nums;/);
  assert.match(shellChromeCss, /\.metric-item-value\[data-slot="percent"\]\s*\{[^}]*min-width:\s*5ch;/);
  assert.match(shellChromeCss, /\.metric-item-value\[data-slot="memory"\]\s*\{[^}]*min-width:\s*7ch;/);
  assert.match(
    shellChromeCss,
    /\.metric-item\[data-stale="true"\]\s*\{[^}]*opacity:\s*0\.55;/,
    'stale GPU-derived readouts must dim'
  );
  assert.doesNotMatch(shellChromeCss, /\.metric-list\[role="button"\]/, 'the read-out is a group, not a refresh button');
});

test('titlebar Jenny wordmark uses the bundled Anastasia face at a readable size and inset', () => {
  const foundationCss = readRepoFile('styles', 'foundation.css');

  assert.match(
    foundationCss,
    /@font-face\s*\{[^}]*font-family:\s*"Anastasia";[^}]*font-weight:\s*400;/,
    'foundation should register the bundled Anastasia font at its real weight'
  );
  assert.match(
    foundationCss,
    /\.section-link\.titlebar-home-link\s*\{[^}]*font-family:\s*var\(--font-family-brand\);[^}]*font-size:\s*var\(--font-size-5xl\);[^}]*letter-spacing:\s*var\(--tracking-kicker-lg\);[^}]*font-weight:\s*400;/,
    'the titlebar Jenny wordmark should use Anastasia at 24px with readable tracking and no synthesized bold'
  );
  assert.match(
    foundationCss,
    /\.titlebar\s*\{[^}]*padding-block:\s*0;[^}]*padding-inline-start:\s*var\(--space-5\);[^}]*padding-inline-end:\s*0;/,
    'the titlebar should retain its 10px inline-start inset'
  );
  assert.match(
    foundationCss,
    /\.titlebar-brand\s*\{[^}]*padding-inline-start:\s*var\(--space-9\);/,
    'the brand group should add 18px for a 28px effective inline-start inset'
  );
});

test('titlebar window controls helper loads before chat event bindings', () => {
  const scripts = extractScriptSources(readRepoFile('index.html'));
  const helperIndex = scripts.indexOf('renderer/chat/renderer-window-controls-utils.js');
  const eventUtilsIndex = scripts.indexOf('renderer/chat/renderer-chat-event-utils.js');

  assert.notEqual(helperIndex, -1, 'index.html should load renderer-window-controls-utils.js');
  assert.notEqual(eventUtilsIndex, -1, 'index.html should load renderer-chat-event-utils.js');
  assert.ok(
    helperIndex < eventUtilsIndex,
    'window controls helper must load before renderer-chat-event-utils.js captures dependencies'
  );
});
