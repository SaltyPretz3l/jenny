'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  classifyBrowserUrl,
  classifyBrowserUrlForOpen,
  classifyBrowserUrlWithRealpathSync,
} = require('../services/browser-url-policy');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('classifyBrowserUrl / allows local development URLs', () => {
  test('loopback URLs with an explicit non-default port are allowed without approval', () => {
    const result = classifyBrowserUrl('http://localhost:3000/');
    assert.equal(result.decision, 'allow');
    assert.equal(result.reason, 'localhost_http');
    assert.equal(result.allowed_without_approval, true);
  });

  test('http://127.0.0.1 is allowed', () => {
    const result = classifyBrowserUrl('http://127.0.0.1:8080/page');
    assert.equal(result.decision, 'allow');
  });

  test('IPv6 loopback URLs are allowed', () => {
    const result = classifyBrowserUrl('http://[::1]:8080/page');
    assert.equal(result.decision, 'allow');
    assert.equal(result.host, '::1');
  });

  test('bare localhost URLs are denied as ambiguous smoke targets', () => {
    for (const rawUrl of [
      'http://localhost/',
      'http://127.0.0.1/',
      'https://[::1]/',
    ]) {
      const result = classifyBrowserUrl(rawUrl);
      assert.equal(result.decision, 'deny');
      assert.equal(result.reason, 'localhost_http_missing_port');
      assert.equal(result.allowed_without_approval, false);
    }
  });

  test('artifact:// pseudo-scheme is denied until a browser resolver exists', () => {
    const result = classifyBrowserUrl('artifact://session_abc/preview.png');
    assert.equal(result.decision, 'deny');
    assert.equal(result.reason, 'artifact_url_unresolved');
  });

  test('file:// inside an allowed root is allowed', () => {
    const result = classifyBrowserUrl('file:///workspace/jenny/index.html', {
      allowedFileRoots: ['/workspace/jenny'],
    });
    assert.equal(result.decision, 'allow');
    assert.equal(result.reason, 'workspace_file_url');
  });
});

describe('classifyBrowserUrl / blocks unsafe URLs', () => {
  test('javascript: scheme is denied', () => {
    const result = classifyBrowserUrl('javascript:alert(1)');
    assert.equal(result.decision, 'deny');
    assert.ok(result.reason.startsWith('unsafe_scheme'));
  });

  test('data: scheme is denied', () => {
    const result = classifyBrowserUrl('data:text/html,<h1>hi</h1>');
    assert.equal(result.decision, 'deny');
  });

  test('chrome:// scheme is denied', () => {
    const result = classifyBrowserUrl('chrome://flags');
    assert.equal(result.decision, 'deny');
  });

  test('file:// outside allowed roots is denied', () => {
    const result = classifyBrowserUrl('file:///etc/passwd', {
      allowedFileRoots: ['/workspace/jenny'],
    });
    assert.equal(result.decision, 'deny');
    assert.equal(result.reason, 'file_url_outside_allowed_roots');
  });

  test('file:// with no allowed roots is denied', () => {
    const result = classifyBrowserUrl('file:///etc/passwd');
    assert.equal(result.decision, 'deny');
  });

  test('unparseable URL is denied', () => {
    const result = classifyBrowserUrl('not a url');
    assert.equal(result.decision, 'deny');
    assert.equal(result.reason, 'unparseable_url');
  });
});

describe('classifyBrowserUrl / external URL gating', () => {
  test('external http URL is denied by default', () => {
    const result = classifyBrowserUrl('http://example.com/');
    assert.equal(result.decision, 'deny');
    assert.equal(result.reason, 'external_url_disabled');
  });

  test('external http URL is approval-gated when allowExternalUrls=true', () => {
    const result = classifyBrowserUrl('http://example.com/', {
      allowExternalUrls: true,
    });
    assert.equal(result.decision, 'ask');
    assert.equal(result.reason, 'external_url');
    assert.equal(result.host, 'example.com');
    assert.equal(result.allowed_without_approval, false);
  });

  test('external https URL with credentials is denied, host stripped', () => {
    const result = classifyBrowserUrl('https://user:pass@example.com/secret', {
      allowExternalUrls: true,
    });
    assert.equal(result.decision, 'deny');
    assert.equal(result.reason, 'credentialed_url');
    assert.equal(result.host, 'example.com');
  });
});

describe('classifyBrowserUrl / Windows file URL handling', () => {
  test('Windows-style file URL with drive letter root works', () => {
    const result = classifyBrowserUrl('file:///C:/projects/jenny/dist/index.html', {
      allowedFileRoots: ['C:/projects/jenny'],
    });
    assert.equal(result.decision, 'allow');
  });
});

describe('classifyBrowserUrlForOpen / realpath file containment', () => {
  test('allows existing file URLs whose real path stays inside the allowed root', async () => {
    const workspaceRoot = createTrackedTempDir('jenny-browser-url-policy-');
    const fixturePath = path.join(workspaceRoot, 'fixture.html');
    fs.writeFileSync(fixturePath, '<h1>local</h1>', 'utf8');

    const result = await classifyBrowserUrlForOpen(pathToFileURL(fixturePath).toString(), {
      allowedFileRoots: [workspaceRoot],
    });

    assert.equal(result.decision, 'allow');
    assert.equal(result.reason, 'workspace_file_url');
  });

  test('allows file URLs when a symlinked lexical path resolves inside the allowed root', async () => {
    const workspaceRoot = createTrackedTempDir('jenny-browser-url-policy-');
    const outsideRoot = createTrackedTempDir('jenny-browser-url-policy-link-');
    const linkPath = path.join(outsideRoot, 'linked-workspace');
    const fixturePath = path.join(workspaceRoot, 'fixture.html');
    fs.writeFileSync(fixturePath, '<h1>local</h1>', 'utf8');
    fs.symlinkSync(
      workspaceRoot,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const rawUrl = pathToFileURL(path.join(linkPath, 'fixture.html')).toString();
    const asyncResult = await classifyBrowserUrlForOpen(rawUrl, {
      allowedFileRoots: [workspaceRoot],
    });
    const syncResult = classifyBrowserUrlWithRealpathSync(rawUrl, {
      allowedFileRoots: [workspaceRoot],
    });

    assert.equal(asyncResult.decision, 'allow');
    assert.equal(asyncResult.reason, 'workspace_file_url');
    assert.equal(syncResult.decision, 'allow');
    assert.equal(syncResult.reason, 'workspace_file_url');
  });

  test('denies file URLs that lexically sit inside the root but realpath outside it', async () => {
    const workspaceRoot = createTrackedTempDir('jenny-browser-url-policy-');
    const outsideRoot = createTrackedTempDir('jenny-browser-url-policy-outside-');
    const linkPath = path.join(workspaceRoot, 'linked-outside');
    fs.writeFileSync(path.join(outsideRoot, 'escape.html'), '<h1>escape</h1>', 'utf8');
    fs.symlinkSync(
      outsideRoot,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const result = await classifyBrowserUrlForOpen(
      pathToFileURL(path.join(linkPath, 'escape.html')).toString(),
      { allowedFileRoots: [workspaceRoot] }
    );

    assert.equal(result.decision, 'deny');
    assert.equal(result.reason, 'file_url_outside_allowed_roots');
  });
});
