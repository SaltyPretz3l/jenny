const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* Static contract over index.html: `renderer/shared/async-fence.js` must be
 * loaded before every renderer module whose UMD header captures
 * `root.rendererAsyncFence` at factory time. Deferred scripts execute in
 * document order, so a consumer listed earlier receives `undefined` and every
 * call into the fence throws (2026-09-07: every Mermaid diagram failed to
 * render because renderer-mermaid-utils.js loaded 28 lines too early). */
test('async-fence.js loads before every module that captures rendererAsyncFence at factory time', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  const fenceIndex = scripts.indexOf('renderer/shared/async-fence.js');
  assert.ok(fenceIndex >= 0, 'index.html must load renderer/shared/async-fence.js');

  const tooEarly = scripts
    .slice(0, fenceIndex)
    .filter((src) => src.startsWith('renderer/'))
    .filter((src) => {
      const file = path.join(root, src);
      return fs.existsSync(file) && /\broot\.rendererAsyncFence\b/.test(fs.readFileSync(file, 'utf8'));
    });
  assert.deepEqual(tooEarly, [], 'these scripts capture root.rendererAsyncFence before async-fence.js has run');
});
