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

  const commandPopover = window.document.getElementById('composerCommandPopover');
  assert.ok(commandPopover, 'command popover element exists');
  assert.equal(commandPopover.classList.contains('hidden'), false, 'command popover is visible');

  terminalShortcut.click();
  await waitForUi(window, 20);
  assert.equal(commandPopover.classList.contains('hidden'), true, 'command popover closes on second click');

  terminalShortcut.click();
  await waitForUi(window, 20);
  assert.equal(commandPopover.classList.contains('hidden'), false, 'command popover reopens');

  window.document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(commandPopover.classList.contains('hidden'), true, 'command popover closes on outside press');

  attachShortcut.click();
  await waitForUi(window, 20);

  assert.equal(shell.__state.attachmentPickCalls.length, 1);
  assert.equal(shell.__state.chatCalls.length, 0);
});

test('C4: composer slash suggestions honor Run versus Insert metadata', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const terminalShortcut = window.document.getElementById('composerTerminalShortcut');
  const commandPopover = window.document.getElementById('composerCommandPopover');

  terminalShortcut.click();
  await waitForUi(window, 20);
  const note = commandPopover.querySelector('[data-command-name="/note"]');
  assert.equal(note.dataset.commandAction, 'insert');
  assert.match(note.textContent, /Insert/);
  note.click();
  await waitForUi(window, 20);
  assert.equal(input.value, '/note ');

  input.value = 'remember this';
  input.setSelectionRange(3, 8);
  terminalShortcut.click();
  await waitForUi(window, 20);
  commandPopover.querySelector('[data-command-name="/note"]').click();
  await waitForUi(window, 20);
  assert.equal(input.value, '/note remember this', 'Insert preserves and prefixes an ordinary draft');
  assert.equal(input.selectionStart, 9);
  assert.equal(input.selectionEnd, 14);

  input.value = '';
  terminalShortcut.click();
  await waitForUi(window, 20);
  const compact = commandPopover.querySelector('[data-command-name="/compact"]');
  assert.equal(compact.dataset.commandAction, 'run');
  assert.match(compact.textContent, /Run/);
  const help = commandPopover.querySelector('[data-command-name="/help"]');
  assert.equal(help.dataset.commandAction, 'run');
  assert.match(help.textContent, /Run/);
  help.click();
  await waitForUi(window, 20);
  assert.equal(input.value, '', 'Run commands execute without inserting into the composer');
});

test('command popover keeps focus stable through resize and supports menu navigation', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const terminalShortcut = window.document.getElementById('composerTerminalShortcut');
  const commandPopover = window.document.getElementById('composerCommandPopover');
  terminalShortcut.click();
  await waitForUi(window, 20);

  const items = [...commandPopover.querySelectorAll('[role="menuitem"]')];
  assert.ok(items.length >= 2);
  items[0].focus();
  items[0].dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  assert.equal(window.document.activeElement, items[1]);

  window.dispatchEvent(new window.Event('resize'));
  await waitForUi(window, 20);
  assert.equal(window.document.activeElement, items[1]);
  assert.equal(items[1].isConnected, true);

  items[1].dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Tab', bubbles: true, cancelable: true,
  }));
  await waitForUi(window, 20);
  assert.equal(commandPopover.classList.contains('hidden'), true);
});
