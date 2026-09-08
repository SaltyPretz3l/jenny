'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appImagePath,
  resolveLinuxPackageKind,
} = require('../services/linux-package-kind');

const realAppImage = {
  platform: 'linux',
  env: {
    APPIMAGE: ' /home/u/Jenny-x86_64.AppImage ',
    APPDIR: '/tmp/.mount_Jenny',
  },
  execPath: '/tmp/.mount_Jenny/usr/bin/jenny',
};

test('classifies an executable under APPDIR as an AppImage', () => {
  assert.equal(resolveLinuxPackageKind(realAppImage), 'appimage');
});

test('classifies inherited AppImage variables as a system package', () => {
  assert.equal(resolveLinuxPackageKind({
    ...realAppImage,
    execPath: '/opt/Jenny/jenny',
  }), 'system');
});

test('requires APPIMAGE as well as APPDIR', () => {
  assert.equal(resolveLinuxPackageKind({
    platform: 'linux',
    env: { APPDIR: '/tmp/.mount_Jenny' },
    execPath: '/tmp/.mount_Jenny/usr/bin/jenny',
  }), 'system');
});

test('normalizes dot segments before comparing APPDIR and execPath', () => {
  assert.equal(resolveLinuxPackageKind({
    ...realAppImage,
    execPath: '/tmp/./.mount_Jenny/usr/bin/jenny',
  }), 'appimage');
});

test('returns null outside Linux', () => {
  assert.equal(resolveLinuxPackageKind({ ...realAppImage, platform: 'win32' }), null);
});

test('appImagePath rejects inherited variables and trims a real image path', () => {
  assert.equal(appImagePath({ ...realAppImage, execPath: '/opt/Jenny/jenny' }), '');
  assert.equal(appImagePath(realAppImage), '/home/u/Jenny-x86_64.AppImage');
});
