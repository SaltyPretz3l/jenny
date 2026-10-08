'use strict';

// Shared fixture for the image engine service tests: a service over a temp
// profile with two pinned archives served by a fake fetch and a fake probe.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assembleZip } = require('./hostile-archive-builder');
const { ImageEngineService, ENGINE_DIRECTORY } = require('../../services/image-engine-service');

const TEMPLATE = require('../../config/sdcpp-engine-manifest.json');
const BANNER = fs.readFileSync(path.join(__dirname, '../fixtures/sdcpp/version-master-929-3f8527a.txt'), 'utf8');
const ACCEPT = { confirmed: true };
const ASSET_HOST = 'release-assets.githubusercontent.com';

function zip(names) {
  return assembleZip(names.map((name) => ({ name, data: Buffer.from(`contents: ${name}`) }))).bytes;
}

function build(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-image-engine-'));
  const userDataPath = path.join(temp, 'profile');
  fs.mkdirSync(userDataPath);
  const archives = options.archives || [zip(TEMPLATE.platforms['win32-x64'].expectedFiles.slice(0, 5)),
    zip(TEMPLATE.platforms['win32-x64'].expectedFiles.slice(5))];
  const manifest = structuredClone(TEMPLATE);
  const pin = manifest.platforms['win32-x64'];
  pin.extractedSizeBytes = 1024;
  pin.extractLimits = { maxEntries: 64, maxEntryUncompressedBytes: 4096, maxTotalUncompressedBytes: 8192 };
  pin.assets.forEach((asset, index) => {
    asset.sizeBytes = archives[index].length;
    asset.sha256 = crypto.createHash('sha256').update(archives[index]).digest('hex');
  });
  options.editManifest?.(manifest);
  const manifestPath = path.join(temp, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const calls = [];
  const probes = [];
  let discarded = 0;
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    const index = pin.assets.findIndex((asset) => url.endsWith(`/${asset.filename}`));
    assert.notEqual(index, -1);
    if (request.redirect === 'manual') {
      return { status: 302, headers: { get: () => `https://${ASSET_HOST}/asset/${pin.assets[index].filename}` },
        body: { cancel: async () => { discarded += 1; } } };
    }
    assert.equal(request.redirect, 'error');
    return { ok: true, status: 200, headers: { get: () => String(archives[index].length) },
      body: (async function* () { yield archives[index]; })() };
  };
  const execFileImpl = (file, args, settings, callback) => {
    probes.push({ file, args, settings });
    callback(null, '', options.banner ?? BANNER);
    return { kill() {} };
  };
  let time = 0;
  const service = new ImageEngineService({ userDataPath, manifestPath, platform: 'win32', arch: 'x64',
    fetchImpl, execFileImpl, now: () => (time += 300), ...options.serviceOptions });
  t.after(() => { service.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const states = [];
  service.on('changed', (state) => states.push(state));
  service.start();
  const root = path.join(userDataPath, ENGINE_DIRECTORY, 'sdcpp');
  return { service, temp, userDataPath, manifestPath, manifest, pin, root, archives, calls, probes, states,
    target: path.join(root, manifest.tag), discarded: () => discarded };
}

function assertUnpublished(context) {
  assert.equal(fs.existsSync(context.target), false);
  assert.equal(fs.readdirSync(context.root).some((name) => name.startsWith('staging-')), false);
  const statePath = path.join(context.root, 'state.json');
  const record = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  assert.equal(record.installed_tag ?? null, null);
}

module.exports = { ACCEPT, ASSET_HOST, BANNER, TEMPLATE, assertUnpublished, build, zip };
