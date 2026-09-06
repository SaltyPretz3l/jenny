const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function readIndexHtml() {
  return fs.readFileSync(path.join(root, 'index.html'), 'utf8');
}

function sliceSection(html, sectionId, nextSectionId) {
  const pattern = new RegExp(
    `data-settings-section="${sectionId}"([\\s\\S]*?)data-settings-section="${nextSectionId}"`
  );
  return pattern.exec(html)?.[1] || '';
}

test('Personality Settings removes only the retired overlay playground controls', () => {
  const html = readIndexHtml();
  const fieldCopy = fs.readFileSync(
    path.join(root, 'renderer', 'shell', 'renderer-settings-field-copy.js'),
    'utf8'
  );

  assert.doesNotMatch(html, /settingsOverlayToggle|settingsOverlayList|settingsPlayground/);
  assert.doesNotMatch(fieldCopy, /settingsOverlayToggle/);
  assert.match(html, /data-settings-section="home"/);
  assert.match(html, /appearanceSurfaceEffectSelect/);
  assert.equal(fs.existsSync(path.join(root, 'services', 'companion-service.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'renderer', 'app', 'renderer-app-comet-runtime.js')), true);
});

test('the Personality card is flat: no tabs, no badge, no details, no preview box', () => {
  const personality = sliceSection(readIndexHtml(), 'personality', 'account');
  assert.ok(personality, 'the Personality section still exists');

  assert.doesNotMatch(personality, /<details/);
  assert.doesNotMatch(personality, /data-personality-tab|personality-tabs|personalityTabs/);
  assert.doesNotMatch(personality, /settings-badge|personalityBadge/);
  assert.doesNotMatch(personality, /personality-overflow|personalityPreview|personality-preview/);
  assert.doesNotMatch(personality, /personalityWorkspacePath|Name &amp; profile|Name & profile/);
  assert.doesNotMatch(personality, /settings-summary-row|personalitySummary/);
  // Every control is rendered by the controller through inventory primitives.
  assert.doesNotMatch(personality, /<\s*(button|input|select|textarea)\b/);
});

test('the Personality card keeps its one status line, one footer and the exact-text disclosure', () => {
  const personality = sliceSection(readIndexHtml(), 'personality', 'account');

  assert.match(personality, /id="personalityStatus"[^>]*aria-live="polite"/);
  assert.match(personality, /id="personalityFormHost"/);
  assert.match(personality, /id="personalityTokenLine"/);
  assert.match(personality, /id="personalityExactHost"/);
  assert.match(personality, /id="personalityExactPanelHost"/);
  assert.match(personality, /id="personalityActions"/);
  assert.doesNotMatch(personality, /IDENTITY\.md|SOUL\.md|MEMORY\.md|daily record/);
});

test('the shared form owns the Personality note copy and the Show exact text affordance', () => {
  const form = fs.readFileSync(path.join(root, 'renderer', 'features', 'personality-form.js'), 'utf8');
  const utils = fs.readFileSync(
    path.join(root, 'renderer', 'features', 'renderer-personality-utils.js'),
    'utf8'
  );

  assert.match(form, /Personality note/);
  assert.match(form, /About you/);
  assert.match(utils, /Show exact text/);
  assert.equal(
    fs.existsSync(path.join(root, 'renderer', 'features', 'assistant-identity-form.js')),
    false,
    'assistant-identity-form.js is retired by personality-form.js'
  );
});

test('Memory owns Long-term notes and no daily record twin', () => {
  const memory = sliceSection(readIndexHtml(), 'memories', 'usage');
  assert.ok(memory, 'the Memory section still exists');

  assert.match(memory, /Long-term notes/);
  assert.match(memory, /Always sent with your messages\. Approved memories are separate and live below\./);
  assert.match(memory, /id="memoryNotesFieldHost"/);
  assert.match(memory, /id="memoryNotesCounter"/);
  assert.match(memory, /id="memoryNotesActions"/);
  assert.doesNotMatch(memory, /daily record|memoryContextTabs|memoryContextEditor|memoryContextFilesGroup/);
  assert.doesNotMatch(memory, /<\s*(button|input|select|textarea)\b/);
});

test('the retired per-file personality IPC surface is gone from the renderer', () => {
  const rendererRoot = path.join(root, 'renderer');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      // The minified fallback registry keeps historical shims; it resolves no IPC.
      if (entry.name === 'renderer-fallback-registry.js') continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/personality\.(getWorkspaceState|listFiles|readFile|writeFile|resetFile|getCompiledContext)\b/.test(text)
        || /contextFiles\.readFile\b/.test(text)) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(rendererRoot);
  assert.deepEqual(offenders, [], 'renderer must call only personality.getState/save/clear');
});

test('the context toggle and /context row both read "Personality and notes"', () => {
  const fieldCopy = fs.readFileSync(
    path.join(root, 'renderer', 'shell', 'renderer-settings-field-copy.js'),
    'utf8'
  );
  const slashContext = fs.readFileSync(
    path.join(root, 'renderer', 'shell', 'renderer-slash-command-context.js'),
    'utf8'
  );

  assert.match(fieldCopy, /contextIncludePersonalityToggle:[\s\S]{0,120}label: 'Personality and notes'/);
  assert.doesNotMatch(fieldCopy, /Include advanced personality files/);
  assert.match(slashContext, /dotRow\('Personality and notes'/);
  assert.doesNotMatch(slashContext, /Advanced personality files/);
});
