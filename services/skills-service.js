const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { normalizeString } = require('../renderer/shared/string-utils');

const {
  DEFAULT_SKILLS,
  normalizeSkillSettings,
} = require('./shell-config-service');
const { isWorkspaceRootChangeReason } = require('./workspace-root-change-reasons');

const SKILL_FILENAME = 'SKILL.md';
const SCOPE_BUNDLED = 'bundled';
const SCOPE_USER = 'user';
const SCOPE_PROJECT = 'project';
const DEFAULT_WATCH_INTERVAL_MS = 5000;
const MAX_DISCOVERED_SKILLS_PER_SCOPE = 128;
const MAX_SKILL_SCAN_DEPTH = 4;
const MAX_SKILL_METADATA_BYTES = 64 * 1024;
const SKILL_COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME_ALIASES = Object.freeze({
  bash: 'run_command',
  glob: 'glob_files',
  grep: 'grep_search',
});

class SkillParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkillParseError';
  }
}

function normalizeAllowedToolName(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }
  const alias = TOOL_NAME_ALIASES[normalized.toLowerCase()];
  return alias || normalized;
}

function splitFrontmatter(content) {
  // Normalize CRLF to LF so the delimiter checks work on Windows checkouts
  // (where core.autocrlf=true converts the bundled SKILL.md files to CRLF).
  const normalized = String(content || '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: '', body: normalized };
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    throw new SkillParseError('Skill frontmatter is missing a closing delimiter.');
  }
  return {
    frontmatter: normalized.slice(4, closingIndex),
    body: normalized.slice(closingIndex + 5),
  };
}

function parseFrontmatter(frontmatter) {
  const result = {
    name: '',
    description: '',
    command: '',
    commandExplicit: false,
    whenToUse: '',
    allowedTools: [],
    always: false,
  };
  if (!normalizeString(frontmatter)) {
    return result;
  }

  let metadataDepth = -1;
  let metadataAlwaysDepth = -1;
  let metadataAlwaysSource = '';
  let hasJennyMetadata = false;
  let allowedToolsDepth = -1;
  for (const rawLine of String(frontmatter).split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    while (allowedToolsDepth !== -1 && indent <= allowedToolsDepth) {
      allowedToolsDepth = -1;
    }
    while (metadataAlwaysDepth !== -1 && indent <= metadataAlwaysDepth) {
      metadataAlwaysDepth = -1;
    }
    while (metadataDepth !== -1 && indent <= metadataDepth && metadataAlwaysDepth === -1) {
      metadataDepth = -1;
    }

    if (/^metadata\s*:\s*$/i.test(trimmed)) {
      metadataDepth = indent;
      metadataAlwaysDepth = -1;
      continue;
    }
    // "nanobot" is a compatibility alias for third-party skill packs.
    const metadataAlwaysMatch = trimmed.match(/^(jenny|nanobot)\s*:\s*$/i);
    if (metadataDepth !== -1 && metadataAlwaysMatch) {
      metadataAlwaysDepth = indent;
      metadataAlwaysSource = metadataAlwaysMatch[1].toLowerCase();
      hasJennyMetadata ||= metadataAlwaysSource === 'jenny';
      continue;
    }

    const keyValueMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (keyValueMatch) {
      const key = normalizeString(keyValueMatch[1]).toLowerCase();
      const rawValue = normalizeString(keyValueMatch[2]).replace(/^['"]|['"]$/g, '');
      if (metadataAlwaysDepth !== -1 && key === 'always') {
        if (metadataAlwaysSource === 'jenny' || !hasJennyMetadata) {
          result.always = ['1', 'true', 'yes', 'on'].includes(rawValue.toLowerCase());
        }
        continue;
      }
      if (key === 'name') {
        result.name = rawValue;
        continue;
      }
      if (key === 'description') {
        result.description = rawValue;
        continue;
      }
      if (key === 'command') {
        result.command = rawValue;
        result.commandExplicit = true;
        continue;
      }
      if (key === 'whentouse' || key === 'when_to_use' || key === 'when-to-use') {
        result.whenToUse = rawValue;
        continue;
      }
      if (
        key === 'allowedtools'
        || key === 'allowed_tools'
        || key === 'allowed-tools'
      ) {
        if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
          result.allowedTools = rawValue
            .slice(1, -1)
            .split(',')
            .map((entry) => normalizeString(entry).replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
        } else if (rawValue) {
          result.allowedTools = [rawValue];
        } else {
          result.allowedTools = [];
          allowedToolsDepth = indent;
        }
        continue;
      }
    }

    if (
      (trimmed.startsWith('- ') || trimmed.startsWith('* '))
      && allowedToolsDepth !== -1
      && metadataAlwaysDepth === -1
      && metadataDepth === -1
      && Array.isArray(result.allowedTools)
    ) {
      const tool = normalizeString(trimmed.slice(2)).replace(/^['"]|['"]$/g, '');
      if (tool) {
        result.allowedTools.push(tool);
      }
    }
  }

  result.allowedTools = Array.from(
    new Set(
      result.allowedTools
        .map((toolName) => normalizeAllowedToolName(toolName))
        .filter(Boolean)
    )
  );
  return result;
}

function resolveScopeEnabled(scope, settings) {
  if (scope === SCOPE_BUNDLED) {
    return settings.bundledEnabled === true;
  }
  if (scope === SCOPE_USER) {
    return settings.userEnabled === true;
  }
  return settings.projectEnabled === true;
}

function buildEntryFromFile(
  scope,
  rootPath,
  skillPath,
  realpathFn,
  readFileImpl = fs.readFileSync,
  displayPath = skillPath,
) {
  let content;
  if (readFileImpl === fs.readFileSync) {
    const fd = fs.openSync(skillPath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_SKILL_METADATA_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } else {
    content = String(readFileImpl(skillPath, 'utf8') || '').slice(0, MAX_SKILL_METADATA_BYTES);
  }
  const { frontmatter } = splitFrontmatter(content);
  const metadata = parseFrontmatter(frontmatter);
  const realPath = realpathFn(skillPath);
  const relPath = path.relative(rootPath, skillPath) || SKILL_FILENAME;
  const explicitCommand = normalizeString(metadata.command).toLowerCase();
  const fallbackCommand = path.basename(path.dirname(skillPath)).trim().toLowerCase().replace(/_/g, '-');
  const commandInvalid = metadata.commandExplicit && !SKILL_COMMAND_PATTERN.test(explicitCommand);
  const command = SKILL_COMMAND_PATTERN.test(explicitCommand)
    ? explicitCommand
    : SKILL_COMMAND_PATTERN.test(fallbackCommand)
      ? fallbackCommand
      : '';
  return {
    scope,
    name: metadata.name || path.basename(path.dirname(skillPath)) || 'Unnamed Skill',
    description: metadata.description,
    command,
    commandInvalid,
    whenToUse: metadata.whenToUse,
    allowedTools: metadata.allowedTools,
    always: metadata.always === true,
    // Discovery is metadata-only. The trusted sidecar owns body loading after
    // the source has been explicitly enabled.
    body: '',
    path: displayPath,
    realPath,
    relPath,
  };
}

function listSkillFiles(rootPath, options = {}) {
  const files = [];
  const fsImpl = options.fsImpl || fs;
  const includeStats = options.includeStats === true;
  if (!rootPath || !fsImpl.existsSync(rootPath)) {
    return files;
  }
  const normalizeBound = (value, fallback, minimum, maximum) => {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
  };
  const maxFiles = normalizeBound(
    options.maxFiles,
    MAX_DISCOVERED_SKILLS_PER_SCOPE,
    1,
    MAX_DISCOVERED_SKILLS_PER_SCOPE
  );
  const maxDepth = normalizeBound(options.maxDepth, MAX_SKILL_SCAN_DEPTH, 0, MAX_SKILL_SCAN_DEPTH);
  const stack = [{ currentPath: rootPath, depth: 0 }];
  while (stack.length) {
    const { currentPath, depth } = stack.pop();
    let entries;
    try {
      entries = fsImpl.readdirSync(currentPath, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    const sortedEntries = entries.slice().sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sortedEntries) {
      if (entry.isFile() && entry.name === SKILL_FILENAME) {
        const skillPath = path.join(currentPath, entry.name);
        if (!includeStats) {
          files.push(skillPath);
        } else {
          try {
            const stats = fsImpl.statSync(skillPath);
            files.push({
              skillPath,
              signatureEntry: [skillPath, Number(stats.mtimeMs || 0), Number(stats.size || 0)],
            });
          } catch (error) {
            files.push({
              skillPath,
              signatureEntry: [skillPath, 'error', String(error.code || error.message || 'unknown')],
            });
          }
        }
        if (files.length >= maxFiles) return files;
      }
    }
    if (depth < maxDepth) {
      const directories = sortedEntries.filter((entry) => entry.isDirectory()).reverse();
      for (const entry of directories) {
        stack.push({ currentPath: path.join(currentPath, entry.name), depth: depth + 1 });
      }
    }
  }
  return files.sort((left, right) => {
    const leftPath = includeStats ? left.skillPath : left;
    const rightPath = includeStats ? right.skillPath : right;
    return leftPath.localeCompare(rightPath);
  });
}

function cloneSkillEntry(entry = {}) {
  return {
    id: String(entry.id || ''),
    enabled: entry.enabled !== false,
    scope: String(entry.scope || ''),
    name: String(entry.name || ''),
    description: String(entry.description || ''),
    command: String(entry.command || ''),
    whenToUse: String(entry.whenToUse || ''),
    allowedTools: Array.isArray(entry.allowedTools) ? [...entry.allowedTools] : [],
    always: entry.always === true,
    body: String(entry.body || ''),
    path: String(entry.path || ''),
    realPath: String(entry.realPath || ''),
    relPath: String(entry.relPath || ''),
  };
}

function cloneSkillWarning(warning = {}) {
  return {
    scope: String(warning.scope || ''),
    path: String(warning.path || ''),
    code: String(warning.code || ''),
    message: String(warning.message || ''),
  };
}

function cloneSkillScope(scope = {}) {
  return {
    scope: String(scope.scope || ''),
    label: String(scope.label || ''),
    path: String(scope.path || ''),
    enabled: scope.enabled === true,
    status: String(scope.status || ''),
    message: String(scope.message || ''),
    blocked: scope.blocked === true,
    workspaceRoot: String(scope.workspaceRoot || ''),
    entries: Array.isArray(scope.entries) ? scope.entries.map((entry) => cloneSkillEntry(entry)) : [],
    warnings: Array.isArray(scope.warnings)
      ? scope.warnings.map((warning) => cloneSkillWarning(warning))
      : [],
  };
}

function cloneSkillsState(state = {}) {
  return {
    featureEnabled: state.featureEnabled === true,
    settings: {
      ...(state.settings && typeof state.settings === 'object' && !Array.isArray(state.settings)
        ? state.settings
        : {}),
      disabledSkillIds: Array.isArray(state.settings?.disabledSkillIds)
        ? [...state.settings.disabledSkillIds]
        : [],
    },
    scopes: Array.isArray(state.scopes) ? state.scopes.map((scope) => cloneSkillScope(scope)) : [],
    entries: Array.isArray(state.entries) ? state.entries.map((entry) => cloneSkillEntry(entry)) : [],
    warnings: Array.isArray(state.warnings)
      ? state.warnings.map((warning) => cloneSkillWarning(warning))
      : [],
    counts: {
      total: Number.isFinite(Number(state.counts?.total)) ? Number(state.counts.total) : 0,
      always: Number.isFinite(Number(state.counts?.always)) ? Number(state.counts.always) : 0,
      warnings: Number.isFinite(Number(state.counts?.warnings)) ? Number(state.counts.warnings) : 0,
    },
  };
}

class SkillsService extends EventEmitter {
  constructor({
    configService,
    bundledRoot,
    openPathImpl,
    featureEnabled = false,
    homedir = os.homedir,
    logger = null,
    watchIntervalMs = DEFAULT_WATCH_INTERVAL_MS,
    fsImpl = fs,
    readFileImpl = fs.readFileSync,
    buildEntryFromFileImpl = buildEntryFromFile,
    realpathImpl = fs.realpathSync.native ? (targetPath) => fs.realpathSync.native(targetPath) : (targetPath) => fs.realpathSync(targetPath),
  } = {}) {
    super();
    if (!configService) {
      throw new Error('configService is required for SkillsService.');
    }
    this.configService = configService;
    this.bundledRoot = normalizeString(bundledRoot);
    this.featureEnabled = featureEnabled === true;
    this.openPathImpl = typeof openPathImpl === 'function' ? openPathImpl : async () => '';
    this.homedir = typeof homedir === 'function' ? homedir : () => os.homedir();
    this.logger = typeof logger === 'function' ? logger : null;
    this.watchIntervalMs = Math.max(0, Number(watchIntervalMs) || 0);
    this.fsImpl = fsImpl || fs;
    this.readFileImpl = typeof readFileImpl === 'function' ? readFileImpl : fs.readFileSync;
    this.buildEntryFromFileImpl =
      typeof buildEntryFromFileImpl === 'function' ? buildEntryFromFileImpl : buildEntryFromFile;
    this.realpathImpl = typeof realpathImpl === 'function' ? realpathImpl : ((targetPath) => targetPath);
    this._watchTimer = null;
    this._watchScanInFlight = false;
    this._lastWatchSignature = '';
    this._lastScopeScan = null;
    this._bundledScan = null;
    this._bundledScopeState = null;
    const initialWatchSignature = this._buildWatchSignature();
    this.lastState = this._buildState();
    this._lastWatchSignature = initialWatchSignature;
    this._handleConfigChanged = this._handleConfigChanged.bind(this);
    this._pollForChanges = this._pollForChanges.bind(this);
    if (typeof this.configService.on === 'function') {
      this.configService.on('changed', this._handleConfigChanged);
    }
    this._startWatching();
  }

  dispose() {
    if (typeof this.configService.off === 'function') {
      this.configService.off('changed', this._handleConfigChanged);
    } else if (typeof this.configService.removeListener === 'function') {
      this.configService.removeListener('changed', this._handleConfigChanged);
    }
    this._stopWatching();
  }

  _log(level, event, details = {}) {
    if (!this.logger) {
      return;
    }
    this.logger(level, event, details);
  }

  _handleConfigChanged(_state, context = {}) {
    const reason = normalizeString(context.reason);
    if (
      isWorkspaceRootChangeReason(reason)
      || reason === 'skills_settings_updated'
    ) {
      this.refreshState({
        emit: true,
        reason: reason || 'skills_state_refreshed',
        force: true,
      });
    }
  }

  _getSettings() {
    return normalizeSkillSettings(this.configService.getState()?.skills || DEFAULT_SKILLS);
  }

  _getToolsWorkspaceRoot() {
    return normalizeString(this.configService.getState()?.toolsWorkspaceRoot);
  }

  getBundledRoot() {
    return this.bundledRoot;
  }

  getUserRoot() {
    return path.join(this.homedir(), '.companion', 'skills');
  }

  getProjectRoot() {
    const workspaceRoot = this._getToolsWorkspaceRoot();
    if (!workspaceRoot) {
      return '';
    }
    return path.join(workspaceRoot, '.jenny', 'skills');
  }

  _buildScopes(settings = this._getSettings()) {
    const toolsWorkspaceRoot = this._getToolsWorkspaceRoot();
    return [
      {
        scope: SCOPE_BUNDLED,
        label: 'Bundled',
        root: this.getBundledRoot(),
        enabled: resolveScopeEnabled(SCOPE_BUNDLED, settings),
      },
      {
        scope: SCOPE_USER,
        label: 'User',
        root: this.getUserRoot(),
        enabled: resolveScopeEnabled(SCOPE_USER, settings),
      },
      {
        scope: SCOPE_PROJECT,
        label: 'Project',
        root: this.getProjectRoot(),
        enabled: resolveScopeEnabled(SCOPE_PROJECT, settings),
        blocked: !toolsWorkspaceRoot,
        workspaceRoot: toolsWorkspaceRoot || '',
      },
    ];
  }

  _startWatching() {
    if (!this.featureEnabled || this.watchIntervalMs <= 0 || this._watchTimer) {
      return;
    }
    this._watchTimer = setInterval(this._pollForChanges, this.watchIntervalMs);
    if (typeof this._watchTimer.unref === 'function') {
      this._watchTimer.unref();
    }
  }

  _stopWatching() {
    if (!this._watchTimer) {
      return;
    }
    clearInterval(this._watchTimer);
    this._watchTimer = null;
  }

  _buildWatchSignature() {
    const settings = this._getSettings();
    const scopes = this._buildScopes(settings).map((scopeDef) => {
      // Safe to memoize: the bundled tree is read-only at runtime (packed
      // into the asar), so it cannot change out from under a cached scan.
      // `refreshState({ force: true })` clears this cache explicitly for the
      // one case where it can change -- editing a bundled SKILL.md in dev.
      if (scopeDef.scope === SCOPE_BUNDLED && scopeDef.enabled && this._bundledScan) {
        return { ...this._bundledScan, scopeDef };
      }
      const normalizedPath = normalizeString(scopeDef.root);
      let rootExists = false;
      let rootStats = null;
      let files = [];
      if (scopeDef.enabled && !scopeDef.blocked && normalizedPath) {
        try {
          rootExists = this.fsImpl.existsSync(normalizedPath);
        } catch (_error) {
          rootExists = false;
        }
        try {
          rootStats = this.fsImpl.statSync(normalizedPath);
        } catch (_error) {
          rootStats = null;
        }
        if (rootStats?.isDirectory()) {
          files = listSkillFiles(normalizedPath, {
            fsImpl: this.fsImpl,
            includeStats: true,
          });
        }
      }
      const scopeScan = { scopeDef, normalizedPath, rootExists, rootStats, files };
      if (scopeDef.scope === SCOPE_BUNDLED && scopeDef.enabled) {
        this._bundledScan = scopeScan;
      }
      return scopeScan;
    });
    this._lastScopeScan = { settings, scopes };
    const snapshot = scopes.map((scopeScan) => {
      const { scopeDef, normalizedPath, rootStats, files } = scopeScan;
      if (!scopeDef.enabled) {
        return {
          scope: scopeDef.scope,
          enabled: false,
          path: normalizedPath,
          status: 'disabled',
        };
      }
      if (scopeDef.blocked) {
        return {
          scope: scopeDef.scope,
          blocked: true,
          workspaceRoot: normalizeString(scopeDef.workspaceRoot),
        };
      }
      if (!normalizedPath) {
        return {
          scope: scopeDef.scope,
          path: '',
          status: 'missing',
        };
      }
      if (!rootStats || !rootStats.isDirectory()) {
        return {
          scope: scopeDef.scope,
          path: normalizedPath,
          status: rootStats ? 'invalid' : 'missing',
        };
      }
      return {
        scope: scopeDef.scope,
        path: normalizedPath,
        status: 'ready',
        entries: files.map((file) => file.signatureEntry),
      };
    });
    // Fold the settings into the signature, not just the file stats. _buildState
    // derives entry.enabled from settings.disabledSkillIds, so a signature keyed
    // only on files would let refreshState() serve a memoized snapshot after a
    // skill was disabled. Scope toggles already reach scopeDef.enabled above;
    // this covers the rest of the settings surface.
    return JSON.stringify({ settings, scopes: snapshot });
  }

  _pollForChanges() {
    if (this._watchScanInFlight) {
      return;
    }
    this._watchScanInFlight = true;
    try {
      const nextSignature = this._buildWatchSignature();
      if (nextSignature === this._lastWatchSignature) {
        return;
      }
      this._log('INFO', 'skills.changed_detected', {
        reason: 'skills_files_changed',
      });
      this.refreshState({
        emit: true,
        reason: 'skills_files_changed',
        signature: nextSignature,
      });
    } finally {
      this._watchScanInFlight = false;
    }
  }

  _buildWarning(scopeDef, skillPath, error) {
    const errorCode = normalizeString(error?.code).toLowerCase();
    const errorName = normalizeString(error?.name);
    let code = 'skill_load_failed';
    if (errorName === 'SkillParseError') {
      code = 'skill_parse_failed';
    } else if (errorCode === 'enoent' || errorCode === 'eacces' || errorCode === 'eperm') {
      code = 'skill_read_failed';
    } else if (errorCode === 'eloop') {
      code = 'skill_realpath_failed';
    }
    return {
      scope: scopeDef.scope,
      path: skillPath,
      code,
      message: normalizeString(error?.message) || 'Skill could not be loaded.',
    };
  }

  _readScope(scopeScan, seenRealPaths) {
    const {
      scopeDef,
      normalizedPath,
      rootExists,
      rootStats,
      files,
    } = scopeScan;
    if (!scopeDef.enabled) {
      return {
        scope: scopeDef.scope,
        label: scopeDef.label,
        path: normalizedPath,
        enabled: false,
        status: 'disabled',
        message: `${scopeDef.label} skills are disabled in Settings.`,
        entries: [],
        warnings: [],
      };
    }
    if (scopeDef.blocked) {
      return {
        scope: scopeDef.scope,
        label: scopeDef.label,
        path: '',
        enabled: scopeDef.enabled,
        status: 'blocked',
        message: 'Set a tools workspace root to enable project skills.',
        entries: [],
      };
    }
    if (!normalizedPath) {
      return {
        scope: scopeDef.scope,
        label: scopeDef.label,
        path: '',
        enabled: scopeDef.enabled,
        status: 'missing',
        message: 'No skill folder is configured for this scope.',
        entries: [],
      };
    }
    if (!rootExists) {
      return {
        scope: scopeDef.scope,
        label: scopeDef.label,
        path: normalizedPath,
        enabled: scopeDef.enabled,
        status: 'missing',
        message: 'Skill folder does not exist yet.',
        entries: [],
      };
    }
    if (!rootStats || !rootStats.isDirectory()) {
      return {
        scope: scopeDef.scope,
        label: scopeDef.label,
        path: normalizedPath,
        enabled: scopeDef.enabled,
        status: 'invalid',
        message: 'Configured skill path is not a directory.',
        entries: [],
      };
    }

    let realRoot;
    try {
      realRoot = this.realpathImpl(normalizedPath);
    } catch (error) {
      return {
        scope: scopeDef.scope,
        label: scopeDef.label,
        path: normalizedPath,
        enabled: scopeDef.enabled,
        status: 'invalid',
        message: 'Skill folder could not be resolved safely.',
        entries: [],
        warnings: [this._buildWarning(scopeDef, normalizedPath, error)],
      };
    }
    const entries = [];
    const warnings = [];
    for (const { skillPath } of files) {
      let entry;
      try {
        const candidateRealPath = this.realpathImpl(skillPath);
        const relativeRealPath = path.relative(realRoot, candidateRealPath);
        if (!relativeRealPath || relativeRealPath.startsWith('..' + path.sep) || path.isAbsolute(relativeRealPath)) {
          const containmentError = new Error('Skill path resolves outside its configured source.');
          containmentError.code = 'EPERM';
          throw containmentError;
        }
        entry = this.buildEntryFromFileImpl(
          scopeDef.scope,
          realRoot,
          candidateRealPath,
          this.realpathImpl,
          this.readFileImpl,
          skillPath,
        );
      } catch (error) {
        const warning = this._buildWarning(scopeDef, skillPath, error);
        warnings.push(warning);
        this._log('WARN', `skills.${warning.code}`, {
          scope: scopeDef.scope,
          path: skillPath,
          message: warning.message,
        });
        continue;
      }
      if (seenRealPaths.has(entry.realPath)) {
        continue;
      }
      seenRealPaths.add(entry.realPath);
      if (entry.commandInvalid) {
        const warning = {
          scope: scopeDef.scope,
          path: skillPath,
          code: 'invalid_command',
          message: `Invalid skill command; using '${entry.command}' from the directory name.`,
        };
        warnings.push(warning);
        this._log('WARN', 'skills.invalid_command', {
          scope: scopeDef.scope,
          path: skillPath,
          message: warning.message,
        });
      }
      entries.push(entry);
    }
    return {
      scope: scopeDef.scope,
      label: scopeDef.label,
      path: normalizedPath,
      enabled: scopeDef.enabled,
      status: entries.length ? 'ready' : 'empty',
      message: entries.length
        ? `${entries.length} skill${entries.length === 1 ? '' : 's'} available.`
        : warnings.length
          ? 'No loadable skills found in this folder.'
          : 'No skills found in this folder yet.',
      entries,
      warnings,
    };
  }

  _buildState() {
    const { settings, scopes: scopeScans } = this._lastScopeScan;
    const disabledSkillIds = new Set(settings.disabledSkillIds);
    const seenRealPaths = new Set();
    const scopes = scopeScans.map((scopeScan) => {
      const { scopeDef } = scopeScan;
      if (scopeDef.scope === SCOPE_BUNDLED && scopeDef.enabled && this._bundledScopeState) {
        const bundledScope = cloneSkillScope(this._bundledScopeState);
        for (const entry of bundledScope.entries) {
          seenRealPaths.add(entry.realPath);
        }
        return bundledScope;
      }
      const scope = this._readScope(scopeScan, seenRealPaths);
      if (scopeDef.scope === SCOPE_BUNDLED && scopeDef.enabled) {
        this._bundledScopeState = cloneSkillScope(scope);
      }
      return scope;
    });
    for (const scope of scopes) {
      for (const entry of scope.entries) {
        const relPath = entry.relPath.replace(/\\/g, '/');
        const skillSlug = relPath.endsWith('/SKILL.md')
          ? relPath.slice(0, -'/SKILL.md'.length)
          : entry.name;
        entry.id = `${scope.scope}/${skillSlug}`;
        entry.enabled = !disabledSkillIds.has(entry.id);
      }
    }
    const entries = scopes.flatMap((scope) => scope.entries);
    const warnings = scopes.flatMap((scope) => scope.warnings || []);
    return {
      featureEnabled: this.featureEnabled,
      settings,
      scopes,
      entries,
      warnings,
      counts: {
        total: entries.filter((entry) => entry.enabled).length,
        always: entries.filter((entry) => entry.enabled && entry.always).length,
        warnings: warnings.length,
      },
    };
  }

  refreshState({
    emit = false,
    reason = 'skills_state_refreshed',
    signature = null,
    force = false,
  } = {}) {
    if (force) {
      // The bundled-scope short-circuits below are safe to memoize because
      // the bundled tree is packed read-only into the asar at runtime -- but
      // that assumption doesn't hold in the dev loop, where a bundled
      // SKILL.md can be edited on disk. force explicitly busts both caches
      // so a forced refresh can actually observe those edits.
      this._bundledScan = null;
      this._bundledScopeState = null;
    }
    const nextSignature = signature === null ? this._buildWatchSignature() : signature;
    if (!force && nextSignature === this._lastWatchSignature) {
      const snapshot = cloneSkillsState(this.lastState);
      if (emit) {
        this.emit('changed', snapshot, { reason });
      }
      return snapshot;
    }
    const nextState = this._buildState();
    this.lastState = nextState;
    this._lastWatchSignature = nextSignature;
    const snapshot = cloneSkillsState(this.lastState);
    if (emit) {
      this.emit('changed', snapshot, { reason });
    }
    return snapshot;
  }

  getState() {
    return this.refreshState();
  }

  setFeatureEnabled(enabled) {
    const nextValue = enabled === true;
    if (nextValue === this.featureEnabled) {
      return this.getState();
    }
    this.featureEnabled = nextValue;
    if (nextValue) {
      this._startWatching();
    } else {
      this._stopWatching();
    }
    return this.refreshState({
      emit: true,
      reason: 'skills_feature_enabled_updated',
      force: true,
    });
  }

  updateSettings(patch = {}) {
    this.configService.updateSkillsSettings(patch);
    return this.refreshState({
      emit: true,
      reason: 'skills_settings_updated',
    });
  }

  async openScopeFolder(scope) {
    const normalizedScope = normalizeString(scope).toLowerCase();
    const state = this.getState();
    const targetScope = state.scopes.find((entry) => entry.scope === normalizedScope);
    if (!targetScope) {
      throw new Error(`Unknown skill scope: ${normalizedScope}`);
    }
    if (targetScope.status === 'blocked') {
      throw new Error(targetScope.message || 'Project skills are blocked until a workspace root is set.');
    }
    let targetPath = targetScope.path;
    if (!targetPath) {
      if (normalizedScope === SCOPE_BUNDLED) {
        throw new Error('Bundled skills path is unavailable.');
      }
      targetPath = normalizedScope === SCOPE_USER ? this.getUserRoot() : this.getProjectRoot();
    }
    if (normalizedScope !== SCOPE_BUNDLED) {
      fs.mkdirSync(targetPath, { recursive: true });
    }
    const openResult = await Promise.resolve(this.openPathImpl(targetPath));
    const openError = normalizeString(openResult);
    if (openError) {
      throw new Error(openError);
    }
    return this.refreshState();
  }

  getSidecarConfig() {
    const settings = this._getSettings();
    return {
      skills_bundled_root: this.getBundledRoot() || null,
      skills_user_root: this.getUserRoot() || null,
      skills_project_root: this.getProjectRoot() || null,
      skills_bundled_enabled: settings.bundledEnabled === true,
      skills_user_enabled: settings.userEnabled === true,
      skills_project_enabled: settings.projectEnabled === true,
      skills_disabled_ids: [...settings.disabledSkillIds],
      skills_auto_index: settings.autoIndex,
    };
  }
}

module.exports = {
  SKILL_FILENAME,
  SCOPE_BUNDLED,
  SCOPE_PROJECT,
  SCOPE_USER,
  SkillParseError,
  SkillsService,
  buildEntryFromFile,
  listSkillFiles,
  parseFrontmatter,
  splitFrontmatter,
};
