'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGitStreamed, buildPluginFetchProfile } = require('../../git-runner');
const { createPinnedConnectProxy } = require('../network/pinned-connect-proxy');
const { normalizeReusableUrl } = require('./source-intake');
const { LIMITS } = require('./distribution-limits');

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
async function acquireGitPackage({ locator, ref = 'HEAD', consent, resolve, signal = null,
  runGit = runGitStreamed, createProxy = createPinnedConnectProxy, tempRoot = os.tmpdir() }) {
  const source = normalizeReusableUrl(locator); if (!source.ok) return source;
  if (typeof ref !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes('..')) return { ok: false, reason: 'git_ref_invalid' };
  const tempDir = await fs.promises.mkdtemp(path.join(tempRoot, 'jenny-plugin-git-'));
  const repoDir = path.join(tempDir, 'repo.git'); const archivePath = path.join(tempDir, 'package.zip');
  let proxy;
  try {
    proxy = await createProxy({ origin: source.origin, consent, resolve, signal }); if (!proxy.ok) return proxy;
    const profile = buildPluginFetchProfile({ proxyUrl: proxy.proxy_url });
    const invoke = (args) => runGit(repoDir, args, { signal, timeoutMs: LIMITS.gitMs,
      maxOutputBytes: LIMITS.gitOutputBytes, pluginFetchProfile: profile });
    await fs.promises.mkdir(repoDir);
    let result = await invoke(['init', '--bare']); if (!result.success) return { ok: false, reason: result.reason };
    result = await invoke(['fetch', '--no-tags', '--depth=1', source.locator, `${ref}:refs/jenny/candidate`]);
    if (!result.success) return { ok: false, reason: result.reason };
    result = await invoke(['rev-parse', '--verify', 'refs/jenny/candidate^{commit}']);
    const commit = result.stdout.trim().toLowerCase();
    if (!result.success || !COMMIT_RE.test(commit)) return { ok: false, reason: 'git_commit_resolution_failed' };
    result = await invoke(['archive', '--format=zip', `--output=${archivePath}`, commit]);
    if (!result.success) return { ok: false, reason: result.reason };
    const bytes = await fs.promises.readFile(archivePath);
    if (bytes.length > LIMITS.packageBytes) return { ok: false, reason: 'git_archive_too_large' };
    return { ok: true, bytes, pinned_commit: commit, repository_url_digest: source.locator_digest };
  } finally {
    try { if (proxy?.ok) await proxy.close(); }
    catch (_error) { /* best-effort proxy teardown: never outranks the decided result */ }
    finally {
      // maxRetries/retryDelay exist for exactly the Windows EBUSY/EPERM window
      // after git.exe exits or an AV scanner touches the tree.
      try { await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch (_error) { /* best-effort scratch cleanup */ }
    }
  }
}

module.exports = { acquireGitPackage };
