const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'markdown.css'), 'utf8');

test('fullscreen Mermaid viewport and toolbar retain their base styling', () => {
  for (const fullscreenSelector of [
    '.mermaid-fullscreen-stage .mermaid-viewport',
    '.mermaid-fullscreen-stage .mermaid-viewport:active',
    '.mermaid-fullscreen-stage .mermaid-viewport svg',
    '.mermaid-fullscreen-shell .mermaid-controls',
    '.mermaid-fullscreen-shell .mermaid-control-btn',
    '.mermaid-fullscreen-shell .mermaid-control-btn:hover',
    '.mermaid-fullscreen-shell .mermaid-zoom-label',
  ]) {
    const selectorIndex = css.indexOf(fullscreenSelector);
    assert.notEqual(selectorIndex, -1, `missing fullscreen base selector: ${fullscreenSelector}`);
    assert.ok(selectorIndex < css.indexOf('.mermaid-fullscreen-overlay {'),
      `${fullscreenSelector} must share the base rule before fullscreen overrides`);
  }
});
