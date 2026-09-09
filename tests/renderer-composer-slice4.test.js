const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('renderer composer shortcut buttons stay wired (command popover + attach)', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const composer = window.document.querySelector('.composer');
  const attachShortcut = window.document.getElementById('composerAttachShortcut');
  const terminalShortcut = window.document.getElementById('composerTerminalShortcut');

  shell.__state.attachmentPickCalls = [];
  shell.attachments.pick = async () => {
    shell.__state.attachmentPickCalls.push(true);
    return { accepted: [], rejected: [] };
  };

  assert.ok(attachShortcut);
  assert.ok(terminalShortcut);

  input.value = 'hello';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(composer.classList.contains('composer-active'), true);

  input.value = '';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);

  terminalShortcut.click();
  await waitForUi(window, 20);

  const commandPopover = window.document.querySelector('.slash-autocomplete-popover');
  assert.ok(commandPopover, 'command popover element exists');
  assert.equal(commandPopover.classList.contains('hidden'), false, 'command popover is visible');

  terminalShortcut.click();
  await waitForUi(window, 20);
  assert.equal(commandPopover.classList.contains('hidden'), true, 'command popover closes on second click');

  terminalShortcut.click();
  await waitForUi(window, 20);
  assert.equal(commandPopover.classList.contains('hidden'), false, 'command popover reopens');

  window.document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(commandPopover.classList.contains('hidden'), true, 'command popover closes on outside press');

  attachShortcut.click();
  await waitForUi(window, 20);

  assert.equal(shell.__state.attachmentPickCalls.length, 1);
  assert.equal(shell.__state.chatCalls.length, 0);
});

test('composer command selection completes commands while preserving the draft', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const terminalShortcut = window.document.getElementById('composerTerminalShortcut');
  terminalShortcut.click();
  await waitForUi(window, 20);
  const commandPopover = window.document.querySelector('.slash-autocomplete-popover');
  const findCommand = (name) => [...commandPopover.querySelectorAll('[role="option"]')].find((row) => row.querySelector('.slash-autocomplete-command').textContent === name);
  const note = findCommand('/note');
  assert.equal(note.getAttribute('aria-disabled'), null);
  note.click();
  await waitForUi(window, 20);
  assert.equal(input.value, '/note ');

  input.value = 'remember this';
  input.setSelectionRange(3, 8);
  terminalShortcut.click();
  await waitForUi(window, 20);
  findCommand('/note').click();
  await waitForUi(window, 20);
  assert.equal(input.value, '/note remember this', 'Insert preserves and prefixes an ordinary draft');
  assert.equal(input.selectionStart, 6);
  assert.equal(input.selectionEnd, 6);

  input.value = '';
  terminalShortcut.click();
  await waitForUi(window, 20);
  const help = findCommand('/help');
  help.click();
  await waitForUi(window, 20);
  assert.equal(input.value, '/help ', 'Selecting completes a command for review before sending');
});

test('command menu keeps its search focus through resize and supports active option navigation', async (t) => {
  const { window } = await loadRendererTestApp(t);
  window.document.getElementById('composerTerminalShortcut').click();
  await waitForUi(window, 20);
  const popover = window.document.querySelector('.slash-autocomplete-popover');
  const search = popover.querySelector('input');
  const items = [...popover.querySelectorAll('[role="option"]')];
  assert.ok(items.length >= 2);
  assert.equal(window.document.activeElement, search);
  const initial = search.getAttribute('aria-activedescendant');
  search.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  const selected = search.getAttribute('aria-activedescendant');
  assert.notEqual(selected, initial);
  window.dispatchEvent(new window.Event('resize'));
  await waitForUi(window, 20);
  assert.equal(window.document.activeElement, search);
  assert.equal(search.getAttribute('aria-activedescendant'), selected);
  assert.equal(window.document.getElementById(selected).isConnected, true);
  search.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(popover.classList.contains('hidden'), true);
  assert.equal(window.document.activeElement.id, 'composerTerminalShortcut');
});
