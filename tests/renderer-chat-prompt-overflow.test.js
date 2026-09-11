/* global document */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const browserPath = [
  process.env.JENNY_TEST_CHROMIUM,
  process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  chromium.executablePath(),
].find((candidate) => candidate && fs.existsSync(candidate));

test('long user prompts stay inside the lane while code scrolls within its block', {
  skip: !browserPath && 'No local Chromium available; set JENNY_TEST_CHROMIUM',
}, async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage();
    const css = ['foundation.css', 'chat-thread.css', 'markdown.css']
      .map((file) => fs.readFileSync(path.join(root, 'styles', file), 'utf8')).join('\n');
    const code = 'A long pasted instruction with spacing. '.repeat(25);
    for (const width of [360, 900]) {
      await page.setViewportSize({ width: width + 80, height: 800 });
      await page.setContent(`<style>${css}
        * { box-sizing: border-box; }
        :root { --chat-user-bubble-max-width: 100%; --space-6: 16px; --space-8: 24px; }
        .lane { display: flex; flex-direction: column; width: ${width}px; margin: 20px; }
      </style><main class="lane"><article class="chat-entry user">
        <div class="chat-message-content"><div class="chat-bubble chat-bubble-markdown">
          <p>Prompt intro and a long path: ${'verylongpath/'.repeat(50)}</p>
          <div class="markdown-code-block"><pre><code>${code}</code></pre></div>
        </div></div></article></main>`);
      const bounds = await page.evaluate(() => {
        const lane = document.querySelector('.lane').getBoundingClientRect();
        const bubble = document.querySelector('.chat-bubble').getBoundingClientRect();
        const pre = document.querySelector('pre');
        return { left: bubble.left - lane.left, right: bubble.right - lane.right,
          scrolls: pre.scrollWidth > pre.clientWidth };
      });
      assert.ok(bounds.left >= -1 && bounds.right <= 1, JSON.stringify({ width, ...bounds }));
      assert.equal(bounds.scrolls, true, 'unwrapped code keeps its own horizontal scroll');
      await page.locator('.markdown-code-block').evaluate((element) => element.classList.add('is-wrapped'));
      assert.equal(await page.locator('pre').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
      assert.equal(await page.locator('code').textContent(), code, 'layout never truncates the actual prompt');
    }
  } finally {
    await browser.close();
  }
});
