const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..');

function readCssRuleBlock(css, selector) {
  const escapedSelector = String(selector).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `expected ${selector} CSS rule`);
  return match[1];
}

test('markdown tables shrink to content while preserving horizontal overflow', () => {
  const css = fs.readFileSync(path.join(rootDir, 'styles', 'markdown.css'), 'utf8');
  
  const wrapperRule = readCssRuleBlock(css, '.chat-bubble-markdown .markdown-table-wrapper');
  assert.match(wrapperRule, /\boverflow-x\s*:\s*auto\s*;/);
  assert.match(wrapperRule, /\bmax-width\s*:\s*100%\s*;/);

  const tableRule = readCssRuleBlock(css, '.chat-bubble-markdown .markdown-table-wrapper table');
  assert.match(tableRule, /\bwidth\s*:\s*100%\s*;/);
  assert.match(tableRule, /\bbox-sizing\s*:\s*border-box\s*;/);
  assert.match(tableRule, /\bdisplay\s*:\s*table\s*;/);
});
