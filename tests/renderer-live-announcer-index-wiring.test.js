/* UIUX-029: confirms index.html actually declares the one shared live-announcer channel that
   renderer/shared/renderer-live-announcer.js is wired against (renderer-app code resolves these
   elements by id at boot -- see renderer-app-shell-bindings.js pattern for other #...Announcer
   nodes). A pure regex check on the markup is enough here; the module unit tests
   (tests/renderer-live-announcer.test.js) cover the announcer's behavior once wired to real nodes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('index.html: declares the polite live-announcer region with correct roles', () => {
  assert.match(
    indexHtml,
    /<div class="sr-only" id="srAnnouncePolite" role="status" aria-live="polite" aria-atomic="true"><\/div>/
  );
});

test('index.html: declares the assertive live-announcer region with correct roles', () => {
  assert.match(
    indexHtml,
    /<div class="sr-only" id="srAnnounceAssertive" role="alert" aria-live="assertive" aria-atomic="true"><\/div>/
  );
});

test('index.html: loads renderer-live-announcer.js before any chat/ script that could consume it', () => {
  const announcerIndex = indexHtml.indexOf('renderer/shared/renderer-live-announcer.js');
  const toolPatchIndex = indexHtml.indexOf('renderer/chat/renderer-stream-tool-patch-utils.js');
  assert.notEqual(announcerIndex, -1, 'announcer script tag missing from index.html');
  assert.notEqual(toolPatchIndex, -1, 'renderer-stream-tool-patch-utils.js script tag missing from index.html');
  assert.ok(announcerIndex < toolPatchIndex, 'announcer must load before its first consumer script');
});
