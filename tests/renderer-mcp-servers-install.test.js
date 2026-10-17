'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { flush, discovery, pendingServer, harness, openDrawer } = require('./helpers/renderer-mcp-servers-harness');

function plan(overrides = {}) {
  return { supported: true, version: '6.4.0', nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    node: { found: true, version: 'v24.11.0', supported: true },
    installed: { version: '', upToDate: false, managedCommand: false },
    connection: { enabled: false }, skill: { copied: false, scopeEnabled: false }, ...overrides };
}
async function setup(t, options = {}) {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer({ name: 'rea' })] }),
    ...options, bridge: { getReaInstallPlan: async () => plan(), ...options.bridge } });
  h.controller.bind();
  await flush();
  return { h, drawer: openDrawer(h, 'details') };
}
const button = (drawer, action) => drawer.querySelector(`[data-mcp-servers-action="${action}"]`);
const section = (drawer) => Array.from(drawer.querySelectorAll('section')).find((node) => node.querySelector('h3')?.textContent === 'Installation');

test('non-preset rows have no Installation section or plan request', async (t) => {
  let requests = 0;
  const { drawer } = await setup(t, { initialState: discovery({ servers: [pendingServer()] }),
    bridge: { getReaInstallPlan: async () => { requests += 1; return plan(); } } });
  assert.equal(section(drawer), undefined);
  assert.equal(requests, 0);
});

test('a missing install-plan bridge hides Installation', async (t) => {
  const { drawer } = await setup(t, { bridge: { getReaInstallPlan: undefined } });
  assert.equal(section(drawer), undefined);
});

test('an unsupported plan hides Installation', async (t) => {
  const { drawer } = await setup(t, { bridge: { getReaInstallPlan: async () => plan({ supported: false }) } });
  assert.equal(section(drawer), undefined);
});

test('a rejected plan hides Installation', async (t) => {
  const { drawer } = await setup(t, { bridge: { getReaInstallPlan: async () => { throw new Error('unavailable'); } } });
  assert.equal(section(drawer), undefined);
});

test('not installed explains the registry, fingerprint, profile and Node folder', async (t) => {
  const { drawer } = await setup(t);
  assert.equal(section(drawer).querySelector('strong').textContent, 'Runs through npx');
  for (const text of ['registry.npmjs.org', 'fingerprint', '102 MB', '6.4.0', 'C:\\Program Files\\nodejs']) {
    assert.ok(section(drawer).textContent.includes(text));
  }
  assert.equal(button(drawer, 'install-rea').disabled, false);
  assert.equal(button(drawer, 'install-rea').textContent.trim(), 'Install rea…');
  const headings = Array.from(drawer.querySelectorAll('h3'), (node) => node.textContent);
  assert.ok(headings.indexOf('Installation') > headings.indexOf('Approval'));
});

test('missing Node disables Install and names its folder', async (t) => {
  const { drawer } = await setup(t, { bridge: { getReaInstallPlan: async () => plan({
    node: { found: false, supported: false, version: '' } }) } });
  assert.equal(button(drawer, 'install-rea').disabled, true);
  assert.equal(drawer.querySelector('.mcp-install-progress').textContent, 'Node.js was not found at C:\\Program Files\\nodejs.');
});

test('unsupported Node explains the accepted versions', async (t) => {
  const { drawer } = await setup(t, { bridge: { getReaInstallPlan: async () => plan({
    node: { found: true, supported: false, version: 'v20.0.0' } }) } });
  assert.equal(button(drawer, 'install-rea').disabled, true);
  assert.equal(drawer.querySelector('.mcp-install-progress').textContent,
    'Node.js v20.0.0 at C:\\Program Files\\nodejs is not supported; rea needs 22.19, 24.11 or newer.');
});

test('enabled connection disables install and uninstall with an off-first note', async (t) => {
  let current = plan({ connection: { enabled: true } });
  const { h, drawer } = await setup(t, { bridge: { getReaInstallPlan: async () => current } });
  assert.equal(button(drawer, 'install-rea').disabled, true);
  assert.equal(drawer.querySelector('.mcp-install-progress').textContent, 'Turn the connection off to install or uninstall.');
  current = plan({ connection: { enabled: true }, installed: { version: '6.3.0', upToDate: false } });
  await h.controller.refresh();
  openDrawer(h, 'details');
  assert.equal(button(drawer, 'install-rea').disabled, true);
  assert.equal(button(drawer, 'uninstall-rea').disabled, true);
});

test('cancelling installation consent shows the dialog and never calls installRea', async (t) => {
  let installs = 0;
  const { h, drawer } = await setup(t, { confirmResult: false,
    bridge: { installRea: async () => { installs += 1; return { status: 'completed' }; } } });
  button(drawer, 'install-rea').click();
  await flush();
  assert.equal(h.confirms.length, 1);
  assert.equal(installs, 0);
  assert.deepEqual(h.toasts, []);
});

test('an install already running disables Install and says so', async (t) => {
  const { drawer } = await setup(t, { bridge: { getReaInstallPlan: async () => plan({ active: { phase: 'installing' } }) } });
  assert.equal(button(drawer, 'install-rea').disabled, true);
  assert.equal(drawer.querySelector('.mcp-install-progress').textContent, 'An install is already running.');
});

test('install confirms, stays busy through progress, reloads the plan and keeps Details open', async (t) => {
  let finish;
  let progress;
  let current = plan();
  let requests = 0;
  const calls = [];
  const { h, drawer } = await setup(t, { bridge: {
    getReaInstallPlan: async () => { requests += 1; return current; },
    onReaInstallProgress: (listener) => { progress = listener; return () => {}; },
    installRea: (payload) => { calls.push(payload); return new Promise((resolve) => { finish = resolve; }); },
  } });
  button(drawer, 'install-rea').click();
  await flush();
  assert.equal(h.confirms[0].title, 'Install rea into Jenny?');
  assert.equal(h.confirms[0].confirmLabel, 'Install');
  for (const text of ['registry.npmjs.org', '102 MB', 'fingerprint', 'Node.js', 'C:\\Program Files\\nodejs']) {
    assert.ok(h.confirms[0].message.includes(text));
  }
  assert.deepEqual(calls, [{ confirmed: true }]);
  assert.equal(button(drawer, 'install-rea').disabled, true);
  const note = drawer.querySelector('.mcp-install-progress');
  assert.equal(note.hidden, true);
  const panel = drawer.querySelector('.inv-drawer-panel');
  progress({ status: 'running', phase: 'downloading', downloadedBytes: 1200000, totalBytes: 1825761 });
  // The line updates in place: no drawer rebuild, so focus and scroll stay where they were.
  assert.equal(drawer.querySelector('.mcp-install-progress'), note);
  assert.equal(drawer.querySelector('.inv-drawer-panel'), panel);
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Downloading rea-agents 6.4.0 · 1.2 of 1.8 MB…');
  assert.equal(note.getAttribute('role'), 'status');
  assert.equal(button(drawer, 'install-rea').disabled, true);
  assert.equal(button(drawer, 'test').disabled, true);
  current = plan({ installed: { version: '6.4.0', upToDate: true, managedCommand: true },
    skill: { copied: true, scopeEnabled: false } });
  finish({ status: 'completed', skillCopied: true });
  await flush();
  assert.equal(requests, 2);
  assert.equal(section(drawer).querySelector('strong').textContent, 'Installed in Jenny · rea-agents 6.4.0');
  const upToDate = Array.from(section(drawer).querySelectorAll('button')).find((node) => node.textContent.trim() === 'Up to date');
  assert.equal(upToDate.disabled, true);
  assert.equal(button(drawer, 'uninstall-rea').disabled, false);
  assert.equal(button(drawer, 'test').disabled, false);
  assert.equal(drawer.hidden, false);
  assert.equal(h.controller._test.getView().drawerState.kind, 'details');
  assert.deepEqual(h.toasts, [{ message: 'rea 6.4.0 installed. Test the connection and approve its tools.', options: undefined }]);
  assert.match(section(drawer).textContent, /turn on user skills in Settings › Skills/);
  assert.match(section(drawer).textContent, /command points at this install/);
  assert.equal(drawer.querySelector('.mcp-install-progress').hidden, true);
});

test('a rejected install call clears the progress line and toasts once', async (t) => {
  let progress;
  const { h, drawer } = await setup(t, { bridge: {
    onReaInstallProgress: (listener) => { progress = listener; return () => {}; },
    installRea: () => { progress({ status: 'running', phase: 'installing' }); return Promise.reject(new Error('ipc')); },
  } });
  button(drawer, 'install-rea').click();
  await flush();
  assert.equal(drawer.querySelector('.mcp-install-progress').hidden, true);
  assert.equal(h.toasts.length, 1);
  assert.equal(button(drawer, 'install-rea').disabled, false);
});

test('integrity failure produces exactly one fingerprint warning', async (t) => {
  const { h, drawer } = await setup(t, { bridge: { installRea: async () => ({ status: 'failed', code: 'integrity_mismatch' }) } });
  button(drawer, 'install-rea').click();
  await flush();
  assert.deepEqual(h.toasts, [{ message: 'The download did not match its fingerprint; nothing was installed.', options: { tone: 'warning' } }]);
});

test('connection_enabled refusal produces exactly one off-first warning', async (t) => {
  const { h, drawer } = await setup(t, { bridge: { installRea: async () => ({ ok: false, error: { code: 'connection_enabled' } }) } });
  button(drawer, 'install-rea').click();
  await flush();
  assert.deepEqual(h.toasts, [{ message: 'Turn the connection off first.', options: { tone: 'warning' } }]);
});

test('older install offers the pinned update and update consent', async (t) => {
  const { h, drawer } = await setup(t, { bridge: {
    getReaInstallPlan: async () => plan({ installed: { version: '6.3.0', upToDate: false, managedCommand: false } }),
    installRea: async () => ({ status: 'completed', skillCopied: false }),
  } });
  assert.equal(button(drawer, 'install-rea').textContent.trim(), 'Update to 6.4.0…');
  assert.match(section(drawer).textContent, /Installed in Jenny · rea-agents 6.3.0/);
  assert.match(section(drawer).textContent, /command does not point at this install/);
  assert.match(section(drawer).textContent, /skill was not copied; see the tutorial/);
  button(drawer, 'install-rea').click();
  await flush();
  assert.equal(h.confirms[0].title, 'Update rea to 6.4.0?');
  assert.equal(h.confirms[0].confirmLabel, 'Update');
  assert.match(h.toasts[0].message, /The skill was not copied\.$/);
});

test('uninstall consent retains the skill, reloads the plan and returns to npx', async (t) => {
  let current = plan({ installed: { version: '6.4.0', upToDate: true, managedCommand: true },
    skill: { copied: true, scopeEnabled: true }, node: { found: false, supported: false } });
  const calls = [];
  const { h, drawer } = await setup(t, { bridge: {
    getReaInstallPlan: async () => current,
    uninstallRea: async (payload) => { calls.push(payload); current = plan(); return { ok: true }; },
  } });
  assert.match(section(drawer).textContent, /user skills are on/);
  assert.equal(button(drawer, 'uninstall-rea').disabled, false);
  button(drawer, 'uninstall-rea').click();
  await flush();
  assert.equal(h.confirms[0].title, 'Remove the rea install?');
  assert.match(h.confirms[0].message, /skill copy in your skills folder stays/);
  assert.deepEqual(calls, [{ confirmed: true }]);
  assert.deepEqual(h.toasts, [{ message: 'rea install removed. The connection runs through npx again; the skill copy stays.', options: undefined }]);
  assert.equal(section(drawer).querySelector('strong').textContent, 'Runs through npx');
  assert.equal(drawer.hidden, false);
});

test('uninstall failures use uninstall wording and flag a command left behind', async (t) => {
  let current = plan({ installed: { version: '6.4.0', upToDate: true, managedCommand: true } });
  const { h, drawer } = await setup(t, { bridge: {
    getReaInstallPlan: async () => current,
    uninstallRea: async () => { current = plan({ installed: { version: '', upToDate: false, managedCommand: true } });
      return { ok: false, error: { code: 'connection_update_failed' } }; },
  } });
  button(drawer, 'uninstall-rea').click();
  await flush();
  assert.deepEqual(h.toasts, [{ message: 'The rea install was removed, but the connection could not be updated: Edit it to use npx again.',
    options: { tone: 'warning' } }]);
  assert.equal(section(drawer).querySelector('strong').textContent, 'Runs through npx');
  assert.match(section(drawer).textContent, /still points at a removed install/);
});

test('a remove failure keeps the install and says so', async (t) => {
  const { h, drawer } = await setup(t, { bridge: {
    getReaInstallPlan: async () => plan({ installed: { version: '6.4.0', upToDate: true, managedCommand: true } }),
    uninstallRea: async () => ({ ok: false, error: { code: 'remove_failed' } }) } });
  button(drawer, 'uninstall-rea').click();
  await flush();
  assert.deepEqual(h.toasts, [{ message: 'The rea install could not be removed.', options: { tone: 'warning' } }]);
  assert.equal(button(drawer, 'uninstall-rea').disabled, false);
});

test('dispose unsubscribes install progress once', async (t) => {
  let unsubscribed = 0;
  const { h } = await setup(t, { bridge: { onReaInstallProgress: () => () => { unsubscribed += 1; } } });
  h.controller.dispose();
  assert.equal(unsubscribed, 1);
});
