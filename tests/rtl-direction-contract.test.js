const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const textField = require('../renderer/inventory/text-field');
const { buildInlineUserMessageEditorMarkup } = require('../renderer/inventory/inline-text-editor');

const ROOT = path.join(__dirname, '..');

function rendererJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

test('RTL isolation and directional icon contracts are present', () => {
  const foundation = fs.readFileSync(path.join(ROOT, 'styles/foundation.css'), 'utf8');
  assert.match(
    foundation,
    /\[dir="rtl"\]\s+:is\([^}]+\)\s*\{[^}]*direction:\s*ltr;[^}]*unicode-bidi:\s*isolate;[^}]*text-align:\s*start;[^}]*\}/s
  );
  assert.match(
    foundation,
    /\[dir="rtl"\]\s+\.icon-mirror-rtl\s*\{[^}]*transform:\s*scaleX\(-1\);[^}]*\}/s
  );

  const markerCount = rendererJavaScriptFiles(path.join(ROOT, 'renderer'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .reduce((count, source) => count + (source.match(/icon-mirror-rtl/g) || []).length, 0);
  assert.ok(markerCount >= 5, `expected at least 5 RTL-mirrored icons, found ${markerCount}`);
});

test('the static chat textarea carries automatic direction', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // Attribute adjacency is not the contract: the textarea carrying dir="auto"
  // is (split view W0-6 added data-chat-node between the two).
  assert.match(html, /id="chatInput"[^>]*\sdir="auto"/);
});

test('inventory text editors use automatic direction except for passwords', () => {
  assert.match(textField({ id: 'plain' }), /type="text" dir="auto"/);
  assert.match(textField({ id: 'multiline', multiline: true }), /<textarea[^>]* dir="auto"/);
  assert.doesNotMatch(textField({ id: 'secret', type: 'password' }), /dir="auto"/);
  assert.match(
    buildInlineUserMessageEditorMarkup({ messageId: 'message-1' }),
    /<textarea[^>]* dir="auto"/
  );
});

// 2026-09-27 gate N4: under Arabic, an English reply rendered right-to-left
// with its period on the wrong side (".nothing at all"). Message bodies carry
// their own direction; the row chrome keeps inheriting the document's RTL.
test('message bodies take their direction from their text while the timeline chrome stays RTL', async (t) => {
  const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
  const stream = 'stream_session-rtl';
  const app = await loadRendererApp({
    shell: {
      sessions: [{
        id: 'session-rtl', title: 'RTL chat', session_type: 'chat', conversation_mode: 'chat',
        preferred_model: 'gpt-test', reasoning_effort: 'default', interactive_round_count: 0,
        interactive_sequence_state: 'idle', pending_question_batch: null, updated_at: new Date().toISOString(),
      }],
      workspaceState: { activeSessionId: 'session-rtl', openSessionIds: ['session-rtl'] },
      sessionMessagePayloads: { 'session-rtl': { data: [
        { id: 'user_rtl', role: 'user', content: 'What changed?', status: 'complete' },
        {
          id: 'assistant_rtl', role: 'assistant', content: 'nothing at all.', status: 'complete',
          streamId: stream, finalizedAt: '2026-09-27T10:00:00.000Z',
          reasoning: { source: 'provider', entries: [{ text: 'Checking the diff.' }] },
        },
      ] } },
    },
  });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  doc.documentElement.dir = 'rtl';
  await waitForUi(window, 150);

  const timeline = doc.getElementById('chatTimeline');
  const bubbles = Array.from(timeline.querySelectorAll('.chat-bubble'));
  assert.ok(bubbles.some((bubble) => bubble.textContent.includes('What changed?')), 'precondition: the user bubble rendered');
  assert.ok(bubbles.some((bubble) => bubble.textContent.includes('nothing at all.')), 'precondition: the reply rendered');
  for (const bubble of bubbles) assert.equal(bubble.getAttribute('dir'), 'auto', `${bubble.className} takes its text's direction`);
  for (const chrome of timeline.querySelectorAll('.chat-entry, .chat-row')) {
    assert.equal(chrome.hasAttribute('dir'), false, `${chrome.className} inherits the document direction`);
  }
  const reasoningBodies = Array.from(timeline.querySelectorAll('.reasoning-row-panel-body'));
  assert.equal(reasoningBodies.length, 1, 'precondition: the reasoning body rendered');
  assert.equal(reasoningBodies[0].getAttribute('dir'), 'auto', 'model reasoning takes the direction of its text');
  assert.equal(doc.documentElement.dir, 'rtl');
});

test('context rail artifact titles take their own direction', () => {
  const orbitCard = require('../renderer/inventory/orbit-card');
  assert.match(orbitCard({ id: 'a1', title: 'Researched the topic.' }), /<span class="orbit-card-title" dir="auto">Researched the topic\.<\/span>/);
});
