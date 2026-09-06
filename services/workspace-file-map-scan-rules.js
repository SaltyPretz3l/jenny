'use strict';

// Workspace File Map — scanner accuracy layer.
//
// Pure, DOM-free, IPC-free. Given a file's raw text content, extract
// import/require-like specifiers via per-language regexes, then resolve
// those specifiers to real workspace-relative paths using a supplied
// fileSet (for O(1) existence checks) and optional tsconfig path aliases.
//
// This module intentionally does NOT parse a real AST — it is a fast,
// best-effort regex layer. Known false-positive/false-negative edge cases
// are documented inline near the relevant regex.
//
// All workspace paths are POSIX-style (forward slash), relative to the
// workspace root, with no leading "./".

const JS_TS_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const RESOLVE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];

// ---------------------------------------------------------------------------
// Path helpers (POSIX-only; workspace paths never use backslashes)
// ---------------------------------------------------------------------------

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function stripLeadingDotSlash(p) {
  return p.replace(/^\.\//, '');
}

/**
 * Normalize a POSIX path: collapse `.` segments, resolve `..` against
 * preceding segments, drop a leading "./", and signal attempts to escape
 * above the workspace root so callers can reject them as unresolved.
 */
function normalizeRelPath(p) {
  const posix = toPosix(p);
  const parts = posix.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else {
        return null;
      }
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function dirnamePosix(relPath) {
  const posix = toPosix(relPath);
  const idx = posix.lastIndexOf('/');
  return idx === -1 ? '' : posix.slice(0, idx);
}

function joinPosix(dir, specifier) {
  if (!dir) return stripLeadingDotSlash(toPosix(specifier));
  return `${dir}/${toPosix(specifier)}`;
}

function extname(p) {
  const posix = toPosix(p);
  const base = posix.slice(posix.lastIndexOf('/') + 1);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}

// ---------------------------------------------------------------------------
// Comment stripping (best-effort, regex-based — not a real tokenizer)
// ---------------------------------------------------------------------------

/**
 * Strip `//` line comments and `/* *\/` block comments from JS/TS/CSS source.
 *
 * Known false positives/negatives (documented, not fixed — v1 regex layer):
 *  - A `//` or `/*` sequence embedded inside a string/template literal is
 *    treated as a real comment start, which can truncate a live specifier
 *    line (e.g. `const x = "http://example.com"` loses everything after
 *    `//`). This mirrors common naive-stripper behavior; a real specifier
 *    string containing `//` immediately after an import/require call is the
 *    risky case, and import paths practically never contain `//`.
 *  - Regex literals containing `/*` or `//`-like sequences are not specially
 *    handled and can confuse the block/line boundary in rare cases.
 */
function stripJsCssComments(content) {
  let out = '';
  let i = 0;
  const len = content.length;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < len) {
    const ch = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === '\n') out += ch; // preserve line numbers loosely
      i += 1;
      continue;
    }

    if (inSingle) {
      out += ch;
      if (ch === '\\') {
        out += next || '';
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }

    if (inDouble) {
      out += ch;
      if (ch === '\\') {
        out += next || '';
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (inTemplate) {
      out += ch;
      if (ch === '\\') {
        out += next || '';
        i += 2;
        continue;
      }
      if (ch === '`') inTemplate = false;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Strip `#` line comments from Python source.
 *
 * Known limitation: a `#` inside a string literal is not distinguished from
 * a real comment marker in the simple fallback path — but this implementation
 * tracks quote state (single/double/triple) to avoid the common case of
 * `"a # not a comment"` being truncated.
 */
function stripPythonComments(content) {
  let out = '';
  let i = 0;
  const len = content.length;
  let quoteChar = null; // "'" | '"' | null
  let triple = false;

  while (i < len) {
    const ch = content[i];

    if (quoteChar) {
      out += ch;
      if (ch === '\\') {
        out += content[i + 1] || '';
        i += 2;
        continue;
      }
      if (ch === quoteChar) {
        if (triple) {
          if (content[i + 1] === quoteChar && content[i + 2] === quoteChar) {
            out += content[i + 1] + content[i + 2];
            i += 3;
            quoteChar = null;
            triple = false;
            continue;
          }
        } else {
          quoteChar = null;
        }
      }
      i += 1;
      continue;
    }

    if (ch === '#') {
      // line comment: skip to end of line (exclusive of the newline)
      while (i < len && content[i] !== '\n') i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      if (content[i + 1] === ch && content[i + 2] === ch) {
        triple = true;
        quoteChar = ch;
        out += ch + ch + ch;
        i += 3;
        continue;
      }
      quoteChar = ch;
      triple = false;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function stripComments(relPath, content) {
  const ext = extname(relPath).toLowerCase();
  if (ext === '.py') return stripPythonComments(content);
  if (JS_TS_EXTENSIONS.includes(ext) || ext === '.css') return stripJsCssComments(content);
  return content;
}

// ---------------------------------------------------------------------------
// extract()
// ---------------------------------------------------------------------------

const RE_IMPORT_FROM = /\bimport\s+(?:[\s\S]*?)\sfrom\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;
const RE_IMPORT_BARE = /\bimport\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;
const RE_EXPORT_FROM = /\bexport\s+(?:[\s\S]*?)\sfrom\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;
const RE_REQUIRE = /\brequire\s*\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;
const RE_DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;

const RE_PY_IMPORT = /^\s*import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)/gm;
const RE_PY_FROM_IMPORT = /^\s*from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+/gm;

const RE_CSS_IMPORT = /@import\s+(?:url\(\s*)?(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)?/g;

const RE_SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1[^>]*>/gi;

function extractJsTs(content) {
  const results = [];

  // import ... from '...'  (also covers `import Default, { a } from '...'`)
  for (const m of content.matchAll(RE_IMPORT_FROM)) {
    results.push({ raw: m[2], kind: 'import' });
  }
  // bare `import '...'` (side-effect only import; no `from`)
  for (const m of content.matchAll(RE_IMPORT_BARE)) {
    results.push({ raw: m[2], kind: 'import' });
  }
  // export ... from '...' (re-exports)
  for (const m of content.matchAll(RE_EXPORT_FROM)) {
    results.push({ raw: m[2], kind: 'export-from' });
  }
  // CommonJS require() calls with a string-literal argument
  for (const m of content.matchAll(RE_REQUIRE)) {
    results.push({ raw: m[2], kind: 'require' });
  }
  // dynamic import('...') — only string-literal arguments are matched by
  // RE_DYNAMIC_IMPORT itself (non-literal args like `import(someVar)` simply
  // do not match the regex, so they are silently skipped, never throw).
  for (const m of content.matchAll(RE_DYNAMIC_IMPORT)) {
    results.push({ raw: m[2], kind: 'dynamic-import' });
  }

  return results;
}

function extractPython(content) {
  const results = [];

  for (const m of content.matchAll(RE_PY_IMPORT)) {
    const modules = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const mod of modules) {
      results.push({ raw: mod, kind: 'python-import' });
    }
  }

  for (const m of content.matchAll(RE_PY_FROM_IMPORT)) {
    const target = m[1];
    const isRelative = target.startsWith('.');
    results.push({
      raw: target,
      kind: isRelative ? 'python-import-relative' : 'python-import',
    });
  }

  return results;
}

function extractCss(content) {
  const results = [];
  for (const m of content.matchAll(RE_CSS_IMPORT)) {
    results.push({ raw: m[2], kind: 'css-import' });
  }
  return results;
}

function extractHtml(content) {
  const results = [];
  for (const m of content.matchAll(RE_SCRIPT_SRC)) {
    results.push({ raw: m[2], kind: 'script-src' });
  }
  return results;
}

/**
 * Extract raw import/require-like specifiers from a file's content.
 * @param {string} relPath - workspace-relative path (used only to infer language by extension)
 * @param {string} content - raw file text
 * @returns {Array<{raw: string, kind: string}>}
 */
function extract(relPath, content) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const ext = extname(relPath).toLowerCase();

  const stripped = stripComments(relPath, content);

  if (JS_TS_EXTENSIONS.includes(ext)) return extractJsTs(stripped);
  if (ext === '.py') return extractPython(stripped);
  if (ext === '.css') return extractCss(stripped);
  if (ext === '.html' || ext === '.htm') return extractHtml(stripped);
  return [];
}

/**
 * Whether reading this file can contribute dependency edges to the graph.
 * Keep this predicate beside extract() so the service's content-budget
 * priority cannot drift from the parser's supported source types.
 */
function isDependencyContentPath(relPath) {
  const ext = extname(relPath).toLowerCase();
  return JS_TS_EXTENSIONS.includes(ext)
    || ext === '.py'
    || ext === '.css'
    || ext === '.html'
    || ext === '.htm';
}

// ---------------------------------------------------------------------------
// classifySpecifier() — helper used by resolveSpecifier
// ---------------------------------------------------------------------------

function classifySpecifier(specifier) {
  if (specifier.startsWith('.')) return 'relative';
  if (specifier.startsWith('/')) return 'absolute';
  return 'bare';
}

// ---------------------------------------------------------------------------
// resolveSpecifier() — relative-path probing shared by JS/TS/CSS/HTML
// ---------------------------------------------------------------------------

/**
 * Try `candidate` as-is, then with each extension appended, then as an
 * `index.<ext>` file under `candidate` treated as a directory.
 */
function probeCandidate(candidate, fileSet, extensions) {
  const normalized = normalizeRelPath(candidate);
  if (normalized === null) return null;
  if (fileSet.has(normalized)) return normalized;

  for (const ext of extensions) {
    const withExt = normalized + ext;
    if (fileSet.has(withExt)) return withExt;
  }

  for (const ext of extensions) {
    const indexPath = normalized ? `${normalized}/index${ext}` : `index${ext}`;
    if (fileSet.has(indexPath)) return indexPath;
  }

  return null;
}

function resolveRelative(fromPath, specifier, fileSet, extensions) {
  const fromDir = dirnamePosix(fromPath);
  const joined = joinPosix(fromDir, specifier);
  return probeCandidate(joined, fileSet, extensions);
}

/**
 * Longest-prefix-wins match against tsconfig-style `paths` map.
 * Keys may be exact (`"@app"`) or wildcard-suffixed (`"@app/*"`).
 * Returns the rewritten specifier candidates (in priority order) or null.
 */
function resolveAlias(specifier, aliases) {
  if (!aliases || !aliases.paths) return null;
  const paths = aliases.paths;
  const baseUrl = aliases.baseUrl || '';

  let bestKey = null;
  let bestPrefixLen = -1;

  for (const key of Object.keys(paths)) {
    const keyPrefix = key.endsWith('*') ? key.slice(0, -1) : key;
    if (key.endsWith('*')) {
      if (specifier.startsWith(keyPrefix) && keyPrefix.length > bestPrefixLen) {
        bestKey = key;
        bestPrefixLen = keyPrefix.length;
      }
    } else if (specifier === key && key.length > bestPrefixLen) {
      bestKey = key;
      bestPrefixLen = key.length;
    }
  }

  if (bestKey === null) return null;

  const targets = paths[bestKey];
  if (!Array.isArray(targets)) return null;

  const isWildcard = bestKey.endsWith('*');
  const keyPrefix = isWildcard ? bestKey.slice(0, -1) : bestKey;
  const remainder = isWildcard ? specifier.slice(keyPrefix.length) : '';

  const candidates = [];
  for (const target of targets) {
    if (typeof target !== 'string') continue;
    const targetPath = target.endsWith('*') && isWildcard
      ? target.slice(0, -1) + remainder
      : target;
    const withBase = baseUrl ? joinPosix(baseUrl, targetPath) : targetPath;
    candidates.push(withBase);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Python dotted resolution
// ---------------------------------------------------------------------------

function resolvePythonAbsolute(dotted, fileSet) {
  const asPath = dotted.replace(/\./g, '/');
  const pyFile = `${asPath}.py`;
  if (fileSet.has(pyFile)) return pyFile;
  const initFile = `${asPath}/__init__.py`;
  if (fileSet.has(initFile)) return initFile;
  return null;
}

/**
 * Relative-dotted python import: `.x`, `..pkg.mod`, or bare dots (`.`, `..`).
 * One leading dot = same package directory as the importing file; each
 * additional dot walks one more directory up.
 */
function resolvePythonRelative(fromPath, dotted, fileSet) {
  const leadingDotsMatch = dotted.match(/^\.+/);
  const leadingDots = leadingDotsMatch ? leadingDotsMatch[0].length : 0;
  const rest = dotted.slice(leadingDots); // may be '' for bare "." / ".."

  let baseDir = dirnamePosix(fromPath);
  // One dot = same directory (no ascent); each extra dot ascends once more.
  for (let i = 1; i < leadingDots; i += 1) {
    baseDir = dirnamePosix(baseDir);
  }

  const restPath = rest ? rest.replace(/\./g, '/') : '';
  const combined = restPath ? joinPosix(baseDir, restPath) : baseDir;

  const pyFile = `${combined}.py`;
  if (rest && fileSet.has(pyFile)) return pyFile;
  const initFile = combined ? `${combined}/__init__.py` : '__init__.py';
  if (fileSet.has(initFile)) return initFile;
  return null;
}

// ---------------------------------------------------------------------------
// Public: resolveSpecifier()
// ---------------------------------------------------------------------------

/**
 * Resolve an extracted specifier to a workspace-relative path.
 * @param {object} args
 * @param {string} args.fromPath - workspace-relative path of the importing file
 * @param {string} args.specifier - the raw specifier text (as extracted)
 * @param {Set<string>} args.fileSet - set of every relPath in the workspace
 * @param {{baseUrl: string|null, paths: Record<string,string[]>}} [args.aliases]
 * @returns {string|null}
 */
function resolveSpecifier({ fromPath, specifier, fileSet, aliases }) {
  if (typeof specifier !== 'string' || specifier.length === 0) return null;
  if (!fileSet || typeof fileSet.has !== 'function') return null;

  const fromExt = extname(fromPath).toLowerCase();
  const isPython = fromExt === '.py';
  const isCssOrHtml = fromExt === '.css' || fromExt === '.html' || fromExt === '.htm';

  if (isPython) {
    // Relative-dotted forms start with one or more literal dots.
    if (specifier.startsWith('.')) {
      return resolvePythonRelative(fromPath, specifier, fileSet);
    }
    return resolvePythonAbsolute(specifier, fileSet);
  }

  const kind = classifySpecifier(specifier);

  if (kind === 'relative') {
    return resolveRelative(fromPath, specifier, fileSet, RESOLVE_EXTENSIONS);
  }

  if (kind === 'absolute') {
    // Treat a leading-slash specifier as workspace-root-relative.
    return probeCandidate(specifier.slice(1), fileSet, RESOLVE_EXTENSIONS);
  }

  // Bare specifier: CSS/HTML have no bare/alias/external concept — a bare
  // CSS `@import 'foo.css'` (no leading dot) is still commonly relative in
  // practice, but per spec CSS/HTML only get relative resolution, so treat
  // non-relative CSS/HTML specifiers as external (null).
  if (isCssOrHtml) return null;

  // JS/TS bare specifier: try aliases first (longest-prefix-wins), then
  // fall back to external (null) if nothing matches.
  const aliasCandidates = resolveAlias(specifier, aliases);
  if (aliasCandidates) {
    for (const candidate of aliasCandidates) {
      const hit = probeCandidate(candidate, fileSet, RESOLVE_EXTENSIONS);
      if (hit) return hit;
    }
    // Alias matched but nothing on disk resolves — still unresolved/external.
    return null;
  }

  return null;
}

/**
 * Best-effort strip of `//` and `/* *\/` comments from JSONC before
 * JSON.parse. This is a v1 shortcut, not a real JSONC parser: a `//` or
 * `/*` sequence inside a JSON string value could be mis-stripped. tsconfig
 * files in practice rarely embed such sequences inside string values, so
 * this is an accepted known limitation rather than a full tokenizer.
 */
function stripJsonComments(text) {
  return stripJsCssComments(text);
}

const EMPTY_ALIASES = Object.freeze({ baseUrl: null, paths: {} });

function parseTsconfigAliases(raw) {
  if (typeof raw !== 'string') return { baseUrl: null, paths: {} };

  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return { baseUrl: null, paths: {} };
  }

  if (!parsed || typeof parsed !== 'object') return { baseUrl: null, paths: {} };
  const compilerOptions = parsed.compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== 'object') {
    return { baseUrl: null, paths: {} };
  }
  const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : null;
  const paths = {};
  const rawPaths = compilerOptions.paths;
  if (rawPaths && typeof rawPaths === 'object' && !Array.isArray(rawPaths)) {
    for (const [key, targets] of Object.entries(rawPaths)) {
      if (!key.trim() || !Array.isArray(targets)) continue;
      paths[key] = targets.filter((target) => typeof target === 'string');
    }
  }
  return { baseUrl, paths };
}

module.exports = {
  extract,
  isDependencyContentPath,
  resolveSpecifier,
  parseTsconfigAliases,
  EMPTY_ALIASES,
};
