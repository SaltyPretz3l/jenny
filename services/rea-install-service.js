'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { execFile: defaultExecFile } = require('child_process');
const semver = require('semver');
const { sanitizeSpawnEnv, maskTokensInText } = require('./backend/sanitize-spawn-env');
const { downloadPinnedFile } = require('./pinned-download');
const { probeMcpReadiness } = require('./mcp-readiness-probe');
const { removeTreeSync } = require('./fs-remove-no-follow');
const { createRequestId } = require('./setup-service-helpers');

function boundedError(value) {
  return maskTokensInText(String(value || ''))
    .replace(/(?:\b|_)(api[_-]?key|auth[_-]?token|token|secret|password)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/\\\\[^\s"'<>]+/g, '[path]')
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]*?(?=\s+(?:api[_-]?key|auth[_-]?token|token|secret|password)\s*[=:]|[\r\n"'<>]|$)/gi, '[path]')
    .replace(/\/(?:[^\s:"']+\/)+[^\s:"']*/g, '[path]')
    .trim().slice(-300);
}

function refusal(code, message = code) {
  return { ok: false, error: { code, message: boundedError(message) } };
}

const INSTALL_CODES = new Set(['download_failed', 'integrity_mismatch', 'npm_failed', 'install_invalid',
  'probe_failed', 'publish_failed', 'connection_update_failed']);

function installError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// Only the documented install codes reach the renderer; a raw fs/spawn code (EPERM, ...) does not.
function publicInstallError(error) {
  return installError(INSTALL_CODES.has(error?.code) ? error.code : 'install_failed', error?.message);
}

function reaPresetRow(manifest) {
  return { name: 'rea', transport: 'stdio', command: path.win32.join(manifest.nodeRoot, 'npx.cmd'),
    args: ['-y', `rea-agents@${manifest.version}`, 'mcp'] };
}

class ReaInstallService extends EventEmitter {
  constructor({ manifest, userDataPath, discovery, skillsService = null,
    fetchImpl = globalThis.fetch, execFile = defaultExecFile, fsImpl = fs,
    homedir = os.homedir, platform = process.platform, env = process.env,
    now = () => new Date(), probeImpl = probeMcpReadiness, downloadImpl = downloadPinnedFile,
    removeTree = removeTreeSync, requestIdProvider = createRequestId, logger = () => {},
    npmTimeoutMs = 600000, probeTimeoutMs = 120000, nodeProbeTimeoutMs = 10000,
    responseStartTimeoutMs = 30000, downloadInactivityMs = 60000 } = {}) {
    super();
    if (!manifest || typeof manifest !== 'object' || !userDataPath || !discovery) {
      throw new TypeError('manifest, userDataPath and discovery are required');
    }
    Object.assign(this, { manifest, discovery, skillsService, fetchImpl, execFile, fsImpl,
      platform, env, now, probeImpl, downloadImpl, removeTree, requestIdProvider, logger,
      npmTimeoutMs, probeTimeoutMs, nodeProbeTimeoutMs, responseStartTimeoutMs, downloadInactivityMs });
    const prefixDir = path.join(userDataPath, 'rea');
    const currentDir = path.join(prefixDir, 'current');
    const packageDir = path.join(currentDir, 'node_modules', manifest.package);
    const paths = { prefixDir, currentDir, packageDir,
      entryPath: path.join(packageDir, 'scripts', 'rea.mjs'),
      nodePath: path.win32.join(manifest.nodeRoot, 'node.exe'),
      npmCliPath: path.win32.join(manifest.nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      skillSourceDir: path.join(packageDir, 'skills', manifest.skill),
      skillTargetDir: path.join(homedir(), '.companion', 'skills', manifest.skill) };
    for (const [key, value] of Object.entries(paths)) {
      Object.defineProperty(this, key, { value, enumerable: true });
    }
    this._busy = false;
    this._active = null;
  }

  managedRow() {
    return { name: 'rea', transport: 'stdio', command: this.nodePath, args: [this.entryPath, 'mcp'] };
  }

  _row() {
    return this.discovery.getState().servers?.find((row) => row.name === 'rea');
  }

  _managed(row) {
    return row?.command === this.nodePath && row?.args?.[0] === this.entryPath;
  }

  _skillScopeEnabled() {
    return this.skillsService?.getSidecarConfig?.().skills_user_enabled === true;
  }

  _log(level, event, data) {
    try { this.logger(level, event, data); } catch (_error) { /* logging must never throw */ }
  }

  _exec(args, options) {
    return new Promise((resolve, reject) => {
      try {
        this.execFile(this.nodePath, args, options, (error, stdout, stderr) => {
          if (error) reject(Object.assign(new Error(boundedError(stderr || error.message)), { cause: error }));
          else resolve(String(stdout || ''));
        });
      } catch (error) { reject(error); }
    });
  }

  async _node() {
    const node = { found: this.fsImpl.existsSync(this.nodePath), version: '', supported: false };
    if (!node.found) return node;
    try {
      node.version = (await this._exec(['--version'], { timeout: this.nodeProbeTimeoutMs,
        windowsHide: true, env: sanitizeSpawnEnv(this.env, { extraDeny: [/^JENNY_/i] }) })).trim();
      const version = semver.clean(node.version);
      node.supported = Boolean(version && semver.satisfies(version, this.manifest.nodeRange));
    } catch (_error) { node.version = ''; }
    return node;
  }

  _installedVersion(packageDir) {
    try {
      const pkg = JSON.parse(this.fsImpl.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      return pkg.name === this.manifest.package && typeof pkg.version === 'string' ? pkg.version : '';
    } catch (_error) { return ''; }
  }

  async getInstallPlan() {
    const node = await this._node();
    const row = this._row();
    const version = this._installedVersion(this.packageDir);
    const m = this.manifest;
    return { supported: this.platform === 'win32', package: m.package, version: m.version,
      tarballUrl: m.tarballUrl, tarballBytes: m.tarballBytes, sha256: m.sha256,
      installedBytesApprox: m.installedBytesApprox, prefix: this.currentDir, nodePath: this.nodePath,
      manualUrl: m.manualUrl, source: m.source, node,
      installed: { version, upToDate: version === m.version, managedCommand: this._managed(row) },
      skill: { name: m.skill, copied: this.fsImpl.existsSync(path.join(this.skillTargetDir, 'SKILL.md')),
        scopeEnabled: this._skillScopeEnabled() },
      connection: { present: Boolean(row), enabled: row?.enabled === true },
      active: this._active ? this._public(this._active) : null };
  }

  _public(entry) {
    return { requestId: entry.requestId, status: entry.status, phase: entry.phase,
      percent: entry.percent, downloadedBytes: entry.downloadedBytes, totalBytes: entry.totalBytes,
      version: entry.version, code: entry.code, error: boundedError(entry.error),
      skillCopied: entry.skillCopied, skillError: entry.skillError || '',
      skillScopeEnabled: entry.skillScopeEnabled, manualUrl: this.manifest.manualUrl };
  }

  _emit(entry, phase) {
    const at = this.now().getTime();
    if (!phase && at - entry.lastEmitAt < 250) return;
    if (phase) entry.phase = phase;
    entry.lastEmitAt = at;
    this.emit('install-progress', this._public(entry));
  }

  _finish(entry, error = null) {
    if (entry.finished) return this._public(entry);
    entry.finished = true;
    entry.status = error ? 'failed' : 'completed';
    if (error) { entry.code = error.code; entry.error = boundedError(error.message); }
    else entry.percent = 100;
    this._active = null;
    this._emit(entry, entry.status);
    this._log(error ? 'WARN' : 'INFO', 'rea_install.finished', {
      requestId: entry.requestId, status: entry.status, code: entry.code });
    return this._public(entry);
  }

  _cleanup(dir, requestId) {
    try { this.removeTree(dir, { fsImpl: this.fsImpl }); }
    catch (error) {
      this._log('WARN', 'rea_install.cleanup_failed', { requestId, reason: boundedError(error.message) });
    }
  }

  // Jenny's own install folder must be a real directory; its ancestors may be junctions
  // (a relocated profile keeps working, as fs-remove-no-follow documents).
  _mkdir(dir) {
    this.fsImpl.mkdirSync(dir, { recursive: true });
    const stat = this.fsImpl.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Install directory is not a regular directory');
  }

  async _copySkill(entry) {
    const staging = `${this.skillTargetDir}.staging-${entry.requestId}`;
    try {
      this.fsImpl.mkdirSync(path.dirname(this.skillTargetDir), { recursive: true });
      this.removeTree(staging, { fsImpl: this.fsImpl });
      this.fsImpl.mkdirSync(staging);
      const sourceStat = this.fsImpl.lstatSync(this.skillSourceDir);
      if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('Invalid skill source');
      const skill = path.join(this.skillSourceDir, 'SKILL.md');
      const stat = this.fsImpl.lstatSync(skill);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid skill file');
      this.fsImpl.copyFileSync(skill, path.join(staging, 'SKILL.md'));
      const references = path.join(this.skillSourceDir, 'references');
      if (this.fsImpl.existsSync(references)) {
        const referenceStat = this.fsImpl.lstatSync(references);
        if (referenceStat.isDirectory() && !referenceStat.isSymbolicLink()) {
          this.fsImpl.mkdirSync(path.join(staging, 'references'));
          for (const name of this.fsImpl.readdirSync(references)) {
            if (!name.endsWith('.md')) continue;
            const source = path.join(references, name);
            const fileStat = this.fsImpl.lstatSync(source);
            if (fileStat.isFile() && !fileStat.isSymbolicLink()) {
              this.fsImpl.copyFileSync(source, path.join(staging, 'references', name));
            }
          }
        }
      }
      this.removeTree(this.skillTargetDir, { fsImpl: this.fsImpl });
      this.fsImpl.renameSync(staging, this.skillTargetDir);
      entry.skillCopied = true;
    } catch (_error) {
      entry.skillError = 'skill_copy_failed';
      this._cleanup(staging, entry.requestId);
    }
    if (entry.skillCopied) {
      try { await this.skillsService?.refreshState?.({ emit: true, force: true, reason: 'rea_skill_installed' }); }
      catch (_error) { /* the copy is already published */ }
    }
    entry.skillScopeEnabled = this._skillScopeEnabled();
  }

  async installRea(payload) {
    const { confirmed, requestId } = payload || {};
    if (confirmed !== true) return refusal('opt_in_required', 'Confirm the rea installation first');
    if (this.platform !== 'win32') return refusal('unsupported_platform');
    if (this._busy) return refusal('in_progress');
    const row = this._row();
    if (!row) return refusal('connection_missing');
    if (row.enabled === true) return refusal('connection_enabled', 'Turn the connection off first');
    this._busy = true;
    let entry;
    let staging;
    try {
      const node = await this._node();
      if (!node.found) return refusal('node_missing');
      if (!node.supported) return refusal('node_unsupported');
      // A renderer-supplied id is also a directory suffix: never accept separators or traversal.
      const id = typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(requestId)
        ? requestId : String(this.requestIdProvider()).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
      entry = { requestId: id, status: 'running', phase: 'downloading', percent: 0,
        downloadedBytes: 0, totalBytes: this.manifest.tarballBytes, code: '', error: '',
        version: this.manifest.version, skillCopied: false, skillScopeEnabled: false, lastEmitAt: 0 };
      this._active = entry;
      this._log('INFO', 'rea_install.started', { requestId: id });
      staging = path.join(this.prefixDir, `staging-${id}`);
      this._emit(entry, 'downloading');
      this._mkdir(this.prefixDir);
      this.removeTree(staging, { fsImpl: this.fsImpl });
      this.fsImpl.mkdirSync(staging);
      const tarballPath = path.join(staging, `rea-agents-${this.manifest.version}.tgz`);
      let sha256;
      try {
        sha256 = await this.downloadImpl({ url: this.manifest.tarballUrl, destPath: tarballPath,
          expectedBytes: this.manifest.tarballBytes, fetchImpl: this.fetchImpl, fsImpl: this.fsImpl,
          responseStartTimeoutMs: this.responseStartTimeoutMs, inactivityMs: this.downloadInactivityMs,
          onProgress: ({ downloadedBytes, totalBytes }) => {
            entry.downloadedBytes = downloadedBytes;
            entry.totalBytes = totalBytes;
            entry.percent = totalBytes > 0 ? Math.min(100, downloadedBytes / totalBytes * 100) : 0;
            this._emit(entry);
          } });
      } catch (error) { throw installError('download_failed', `${error.code || 'download_failed'}: ${error.message}`); }
      this._emit(entry, 'verifying');
      if (sha256 !== this.manifest.sha256 || this.fsImpl.statSync(tarballPath).size !== this.manifest.tarballBytes) {
        throw installError('integrity_mismatch', 'Downloaded rea tarball does not match its pinned fingerprint or size');
      }
      this._emit(entry, 'installing');
      try {
        await this._exec([this.npmCliPath, 'install', '--prefix', staging, '--ignore-scripts',
          '--no-audit', '--no-fund', '--no-package-lock', '--loglevel', 'error', tarballPath], {
          cwd: staging, windowsHide: true, timeout: this.npmTimeoutMs, maxBuffer: 4 * 1024 * 1024,
          env: { ...sanitizeSpawnEnv(this.env, { extraDeny: [/^JENNY_/i] }), npm_config_update_notifier: 'false' } });
      } catch (error) { throw installError('npm_failed', error.message); }
      const stagedPackage = path.join(staging, 'node_modules', this.manifest.package);
      if (this._installedVersion(stagedPackage) !== this.manifest.version) throw installError('install_invalid');
      this._emit(entry, 'probing');
      try {
        const probe = await this.probeImpl({ server: { name: 'rea', transport: 'stdio', command: this.nodePath,
          args: [path.join(stagedPackage, 'scripts', 'rea.mjs'), 'mcp'] }, timeoutMs: this.probeTimeoutMs });
        if (probe?.healthy !== true) throw new Error(probe?.reason || 'Readiness probe failed');
      } catch (error) { throw installError('probe_failed', error.message); }
      this._emit(entry, 'publishing');
      // The previous install is moved aside, never deleted, until the new one is in place;
      // reconcile() moves it back if the process dies in between.
      const previous = path.join(this.prefixDir, `staging-old-${id}`);
      const hadPrevious = this.fsImpl.existsSync(this.currentDir);
      try {
        if (hadPrevious) this.fsImpl.renameSync(this.currentDir, previous);
      } catch (error) {
        throw installError('publish_failed', `The previous install was kept. ${boundedError(error.message).slice(-180)}`);
      }
      try {
        this.fsImpl.renameSync(staging, this.currentDir);
      } catch (error) {
        let note = 'The previous install was kept.';
        try { if (hadPrevious) this.fsImpl.renameSync(previous, this.currentDir); }
        catch (_rollback) { note = 'The previous install could not be put back.'; }
        throw installError('publish_failed', `${note} ${boundedError(error.message).slice(-180)}`);
      }
      if (hadPrevious) this._cleanup(previous, id);
      this._emit(entry, 'connecting');
      try {
        const updated = await this.discovery.updateServer({ name: 'rea', server: this.managedRow() });
        if (updated?.ok === false) throw new Error(updated.error?.message || 'Connection update failed');
      } catch (error) { throw installError('connection_update_failed', error.message); }
      this._emit(entry, 'copying_skill');
      await this._copySkill(entry);
      return this._finish(entry);
    } catch (error) {
      if (staging) this._cleanup(staging, entry?.requestId);
      const failure = publicInstallError(error);
      return entry ? this._finish(entry, failure) : refusal(failure.code, failure.message);
    } finally { this._busy = false; }
  }

  async uninstallRea(payload) {
    const { confirmed } = payload || {};
    if (confirmed !== true) return refusal('opt_in_required');
    if (this.platform !== 'win32') return refusal('unsupported_platform');
    if (this._busy) return refusal('in_progress');
    const row = this._row();
    if (row?.enabled === true) return refusal('connection_enabled', 'Turn the connection off first');
    this._busy = true;
    const result = { ok: true, removed: false, connectionRestored: false, skillKept: true };
    try {
      if (this.fsImpl.existsSync(this.prefixDir)) {
        try { this.removeTree(this.prefixDir, { fsImpl: this.fsImpl }); result.removed = true; }
        catch (error) { return Object.assign(result, refusal('remove_failed', error.message)); }
      }
      if (this._managed(row)) {
        try {
          const updated = await this.discovery.updateServer({ name: 'rea', server: reaPresetRow(this.manifest) });
          if (updated?.ok === false) throw new Error(updated.error?.message || 'Connection update failed');
          result.connectionRestored = true;
        } catch (error) { Object.assign(result, refusal('connection_update_failed', error.message)); }
      }
      return result;
    } finally {
      this._busy = false;
      this._log(result.ok ? 'INFO' : 'WARN', 'rea_uninstall.finished', {
        status: result.ok ? 'completed' : 'failed', code: result.error?.code || '' });
    }
  }

  reconcile() {
    const skillsRoot = path.dirname(this.skillTargetDir);
    if (this.fsImpl.existsSync(skillsRoot)) {
      for (const name of this.fsImpl.readdirSync(skillsRoot)) {
        if (name.startsWith(`${this.manifest.skill}.staging-`)) this.removeTree(path.join(skillsRoot, name), { fsImpl: this.fsImpl });
      }
    }
    if (!this.fsImpl.existsSync(this.prefixDir)) return;
    const stat = this.fsImpl.lstatSync(this.prefixDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid rea install directory');
    const names = this.fsImpl.readdirSync(this.prefixDir);
    // A run killed between moving the old install aside and publishing gets the old one back.
    const previous = names.find((name) => name.startsWith('staging-old-'));
    if (previous && !this.fsImpl.existsSync(this.currentDir)) {
      this.fsImpl.renameSync(path.join(this.prefixDir, previous), this.currentDir);
    }
    for (const name of names) {
      const entry = path.join(this.prefixDir, name);
      if (name.startsWith('staging-') && this.fsImpl.existsSync(entry)) this.removeTree(entry, { fsImpl: this.fsImpl });
    }
  }
}

module.exports = { ReaInstallService, reaPresetRow };
