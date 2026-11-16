// new-test-file: the inventory primitive had no test file of its own; its markup contract is pure string output, so it runs apart from the controller harness.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildInlineUserMessageEditorMarkup,
  resolveInlineEditorSaveState,
} = require('../renderer/inventory/inline-text-editor');

function mount(input) {
  const dom = new JSDOM(`<body>${buildInlineUserMessageEditorMarkup(input)}</body>`);
  const doc = dom.window.document;
  return {
    doc,
    bubble: doc.querySelector('.chat-bubble-editing'),
    textarea: doc.querySelector('textarea.chat-bubble-editor'),
    foot: doc.querySelector('.chat-bubble-editor-foot'),
    impact: doc.querySelector('.chat-bubble-editor-impact'),
    save: doc.querySelector('[data-edit-action="save"]'),
    cancel: doc.querySelector('[data-edit-action="cancel"]'),
  };
}

test('the editor renders the bubble and its footer as two siblings with the controller hooks', () => {
  const m = mount({ messageId: 'm<1>', draftText: 'a <b> & c', originalText: 'a' });
  assert.equal(m.bubble.parentNode, m.foot.parentNode);
  assert.equal(m.bubble.nextElementSibling, m.foot);
  assert.equal(m.bubble.getAttribute('data-message-id'), 'm<1>');
  assert.equal(m.bubble.getAttribute('data-pin-fade-trigger'), 'user');
  assert.equal(m.bubble.getAttribute('dir'), 'auto');
  assert.equal(m.textarea.parentNode, m.bubble);
  assert.equal(m.textarea.getAttribute('data-edit-target-message-id'), 'm<1>');
  assert.equal(m.textarea.getAttribute('dir'), 'auto');
  assert.equal(m.textarea.getAttribute('spellcheck'), 'true');
  assert.equal(m.textarea.getAttribute('maxlength'), '32000');
  assert.equal(m.textarea.getAttribute('rows'), '1');
  assert.equal(m.textarea.getAttribute('aria-label'), 'Edit your message');
  assert.equal(m.textarea.value, 'a <b> & c', 'the draft is escaped, not parsed');
  assert.equal(m.foot.getAttribute('data-edit-foot-message-id'), 'm<1>');
  assert.equal(m.save.getAttribute('data-message-id'), 'm<1>');
  assert.equal(m.cancel.getAttribute('data-message-id'), 'm<1>');
  assert.equal(m.cancel.getAttribute('title'), 'Cancel edit (Esc)');
  assert.ok(m.save.classList.contains('btn') && m.save.classList.contains('btn--primary') && m.save.classList.contains('btn--sm'));
  assert.ok(m.cancel.classList.contains('btn') && m.cancel.classList.contains('btn--ghost') && m.cancel.classList.contains('btn--sm'));
  assert.equal(m.cancel.disabled, false);
  assert.equal(m.textarea.hasAttribute('readonly'), false);
  assert.equal(m.bubble.hasAttribute('aria-busy'), false);
});

test('Resend is disabled until the draft differs from the original', () => {
  const unchanged = mount({ messageId: 'm1', draftText: 'same', originalText: 'same' });
  assert.equal(unchanged.save.disabled, true);
  assert.equal(unchanged.save.getAttribute('title'), 'Change the message to resend it');
  assert.equal(unchanged.save.textContent, 'Resend');

  const changed = mount({ messageId: 'm1', draftText: 'new', originalText: 'old' });
  assert.equal(changed.save.disabled, false);
  assert.equal(changed.save.getAttribute('title'), 'Resend (Ctrl+Enter)');

  const noOriginal = mount({ messageId: 'm1', draftText: 'only a draft' });
  assert.equal(noOriginal.save.disabled, true, 'originalText defaults to the draft');

  const blank = mount({ messageId: 'm1', draftText: '  ', originalText: 'old' });
  assert.equal(blank.save.disabled, true, 'a blank draft cannot be resent without an image');
  const blankWithImage = mount({ messageId: 'm1', draftText: '', originalText: 'old', hasReplayImages: true });
  assert.equal(blankWithImage.save.disabled, false);
});

test('resolveInlineEditorSaveState is the one owner of the Resend rule', () => {
  assert.deepEqual(
    resolveInlineEditorSaveState({ draftText: 'a', originalText: 'a' }),
    { disabled: true, title: 'Change the message to resend it', label: 'Resend' }
  );
  assert.deepEqual(
    resolveInlineEditorSaveState({ draftText: 'b', originalText: 'a' }),
    { disabled: false, title: 'Resend (Ctrl+Enter)', label: 'Resend' }
  );
  assert.deepEqual(
    resolveInlineEditorSaveState({ draftText: 'b', originalText: 'a', committing: true }),
    { disabled: true, title: 'Resend (Ctrl+Enter)', label: 'Resending…' }
  );
  assert.equal(resolveInlineEditorSaveState({ draftText: ' a', originalText: 'a' }).disabled, false, 'whitespace edits count');
  assert.equal(resolveInlineEditorSaveState({ draftText: '', originalText: 'a', hasReplayImages: true }).disabled, false);
  assert.equal(resolveInlineEditorSaveState({ draftText: '', originalText: 'a' }).disabled, true);
});

test('committing greys the editor out without disabling the textarea', () => {
  const m = mount({
    messageId: 'm1', draftText: 'new', originalText: 'old', committing: true, affectedCount: 4,
    textAttachmentNames: ['notes.txt'],
  });
  assert.equal(m.textarea.hasAttribute('readonly'), true);
  assert.equal(m.textarea.disabled, false);
  assert.equal(m.textarea.getAttribute('aria-busy'), 'true');
  assert.equal(m.bubble.getAttribute('aria-busy'), 'true');
  assert.equal(m.cancel.disabled, true);
  assert.equal(m.save.disabled, true);
  assert.equal(m.save.getAttribute('aria-busy'), 'true');
  assert.equal(m.save.textContent, 'Resending…');
  assert.equal(m.impact.textContent, '');
  assert.equal(m.impact.classList.contains('is-warning'), false);
});

test('the impact line names what resending does, first match wins', () => {
  const line = (input) => mount(Object.assign({ messageId: 'm1', draftText: 'x', originalText: 'y' }, input)).impact;

  const one = line({ textAttachmentNames: ['notes <1>.txt'], affectedCount: 5 });
  assert.equal(one.textContent, 'notes <1>.txt can’t be resent. Attach it again in the composer if Jenny still needs it.');
  assert.ok(one.classList.contains('is-warning'));

  const two = line({ textAttachmentNames: ['a.txt', 'b.txt'], affectedCount: 5 });
  assert.equal(two.textContent, '2 text files can’t be resent. Attach them again in the composer if Jenny still needs them.');
  assert.ok(two.classList.contains('is-warning'));

  const none = line({ affectedCount: 1 });
  assert.equal(none.textContent, 'Ctrl+Enter resends · Esc cancels');
  assert.equal(none.classList.contains('is-warning'), false);
  assert.equal(line({}).textContent, 'Ctrl+Enter resends · Esc cancels');

  // No count: stored rows (tool calls, notes) would overstate what the reader sees.
  assert.equal(line({ affectedCount: 2 }).textContent, 'Replaces everything after this message.');
  assert.equal(line({ affectedCount: 4 }).textContent, 'Replaces everything after this message.');
  // While resending, the button says so: the line is empty and shows no warning.
  const busy = line({ textAttachmentNames: ['a.txt'], committing: true });
  assert.equal(busy.textContent, '');
  assert.equal(busy.classList.contains('is-warning'), false);
  assert.equal(line({ affectedCount: 2 }).classList.contains('is-warning'), false);
});
