'use strict';

// Electron's default application menu carries Ctrl+R / Ctrl+Shift+R reload
// accelerators that bypass the renderer's guarded reload (dirty-buffer
// preflight). Jenny installs its own menu with no reload role anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApplicationMenuTemplate, installApplicationMenu } = require('../services/main/app-menu');

function roles(template) {
  const found = [];
  const walk = (items) => {
    for (const item of items || []) {
      if (item.role) found.push(item.role);
      if (item.submenu) walk(item.submenu);
    }
  };
  walk(template);
  return found;
}

test('no reload role on any platform, packaged or not', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const isPackaged of [true, false]) {
      const found = roles(buildApplicationMenuTemplate({ platform, isPackaged }));
      assert.equal(found.some((role) => /reload/i.test(role)), false, `${platform} packaged=${isPackaged}: ${found.join(',')}`);
      assert.ok(found.includes('editMenu'), 'clipboard shortcuts keep their edit roles');
    }
  }
});

test('DevTools toggle only in development; macOS gets its app and window menus', () => {
  assert.ok(roles(buildApplicationMenuTemplate({ platform: 'win32', isPackaged: false })).includes('toggleDevTools'));
  assert.equal(roles(buildApplicationMenuTemplate({ platform: 'win32', isPackaged: true })).includes('toggleDevTools'), false);
  const mac = roles(buildApplicationMenuTemplate({ platform: 'darwin', isPackaged: true }));
  assert.deepEqual(mac, ['appMenu', 'editMenu', 'windowMenu']);
  assert.deepEqual(roles(buildApplicationMenuTemplate({ platform: 'linux', isPackaged: true })), ['editMenu']);
});

test('installApplicationMenu builds and sets the menu, and never throws', () => {
  const calls = [];
  const Menu = {
    buildFromTemplate: (template) => { calls.push(['build', template]); return { built: true }; },
    setApplicationMenu: (menu) => calls.push(['set', menu]),
  };
  const template = installApplicationMenu({ Menu, platform: 'win32', isPackaged: true });
  assert.deepEqual(roles(template), ['editMenu']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['set', { built: true }]);

  const logs = [];
  const broken = { buildFromTemplate: () => { throw new Error('no menu here'); }, setApplicationMenu: () => {} };
  assert.equal(installApplicationMenu({ Menu: broken, platform: 'win32', isPackaged: true, log: (...a) => logs.push(a) }), null);
  assert.equal(logs[0][1], 'window.menu_install_failed');
  assert.equal(installApplicationMenu({ Menu: null }), null, 'no Menu module (tests, headless hosts): no-op');
});
