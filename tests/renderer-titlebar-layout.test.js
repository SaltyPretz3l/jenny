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

test('titlebar groups center actions so window controls stay in the top row', () => {
  const html = readRepoFile('index.html');
  const dom = new JSDOM(html);
  const titlebar = dom.window.document.querySelector('.titlebar');
  assert.ok(titlebar, 'titlebar should exist');

  const directChildren = Array.from(titlebar.children).map((el) => el.className);
  assert.deepEqual(directChildren, [
    'titlebar-brand',
    'titlebar-center',
    'titlebar-status',
    'window-controls',
  ]);

  const center = titlebar.querySelector(':scope > .titlebar-center');
  const status = titlebar.querySelector(':scope > .titlebar-status');
  // The "Go anywhere" pill rides in the status cluster next to the CPU/RAM meters.
  assert.equal(status.querySelector('#titlebarPalettePill')?.parentElement, status);
  // The pinned-note tab strip shares the center column, right of the brand.
  assert.equal(center.querySelector('#pinnedNoteTabs')?.parentElement, center);
  assert.equal(titlebar.querySelector('#titlebarThreadMapPill'), null);
});

test('pinned-note titlebar tabs opt out of the draggable region', () => {
  const shellChromeCss = readRepoFile('styles', 'shell-chrome.css');
  assert.match(
    shellChromeCss,
    /\.pin-tabs\s*,\s*\.pin-tab\s*\{[\s\S]*-webkit-app-region:\s*no-drag;/,
    'pinned-note tabs must opt out of the draggable titlebar region so clicks select instead of drag'
  );
});

test('titlebar CSS reserves an explicit top-row column for window controls', () => {
  const foundationCss = readRepoFile('styles', 'foundation.css');
  const shellChromeCss = readRepoFile('styles', 'shell-chrome.css');

  assert.match(
    foundationCss,
    /\.titlebar\s*\{[\s\S]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s+auto;/,
    'titlebar should define brand, center, status, and window-control columns'
  );
  assert.match(
    shellChromeCss,
    /\.window-controls\s*\{[\s\S]*grid-column:\s*4;/,
    'window controls should be pinned to the fourth titlebar column'
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
    /\.titlebar-status\s*>\s*\.stat-divider\s*,\s*\.titlebar-status\s*>\s*\.metric-list\s*\{[^}]*display:\s*none;/,
    'nonessential telemetry should yield at narrow widths'
  );
  assert.match(
    media,
    /\.turn-status-pill\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/,
    'essential turn status should remain visible and shrink within its track'
  );
  assert.match(
    commandPaletteCss,
    /@media\s*\(max-width:\s*320px\)\s*\{[\s\S]*?\.titlebar-palette-pill\s*\{[^}]*display:\s*none;/,
    'the duplicate palette affordance should yield when brand and window controls consume the ultranarrow titlebar'
  );
});

test('metric strip refresh affordance and staleness dimming keep their CSS backing', () => {
  const shellChromeCss = readRepoFile('styles', 'shell-chrome.css');

  assert.match(
    shellChromeCss,
    /\.metric-list\[role="button"\]\s*\{[^}]*cursor:\s*pointer;/,
    'the flag-on metric strip must present as clickable'
  );
  assert.match(
    shellChromeCss,
    /\.metric-list\[role="button"\]:focus-visible\s*\{[^}]*outline:[^}]*var\(--focus-outline\)/,
    'the keyboard refresh target needs a visible focus ring'
  );
  assert.match(
    shellChromeCss,
    /\.metric-item\[data-stale="true"\]\s*\{[^}]*opacity:\s*0\.55;/,
    'stale GPU-derived readouts must dim — without this rule the staleness signal is markup-only'
  );
  assert.match(
    shellChromeCss,
    /\.metric-list\.is-refreshing\s*\{[^}]*opacity:/,
    'the in-flight refresh state needs its visual'
  );
  assert.match(
    shellChromeCss,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.metric-list\[role="button"\][\s\S]*?transition:\s*none;/,
    'refresh affordance motion must respect prefers-reduced-motion'
  );
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
    /\.section-link\.titlebar-home-link\s*\{[^}]*font-family:\s*var\(--font-family-brand\);[^}]*font-size:\s*var\(--font-size-4xl\);[^}]*letter-spacing:\s*var\(--tracking-kicker-lg\);[^}]*font-weight:\s*400;/,
    'the titlebar Jenny wordmark should use Anastasia at 22px with readable tracking and no synthesized bold'
  );
  assert.match(
    foundationCss,
    /\.titlebar\s*\{[^}]*padding:\s*0\s+0\s+0\s+var\(--space-5\);/,
    'the titlebar should retain its 10px left inset'
  );
  assert.match(
    foundationCss,
    /\.titlebar-brand\s*\{[^}]*padding-left:\s*var\(--space-9\);/,
    'the brand group should add 18px for a 28px effective left inset'
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
