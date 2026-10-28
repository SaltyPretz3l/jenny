/* renderer/features/renderer-ide-icons.js - inline-SVG file-type icons for
 * the Workspace IDE explorer tree. Inline SVG (stroke: currentColor) keeps
 * the icons CSP-proof on file:// (no @font-face, no fetched assets); color
 * comes from ide-tree-icon--<category> classes mapped to palette tokens in
 * styles/ide-explorer.css. All markup here is static and internally built -
 * file names only steer the extension lookup, they are never interpolated. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeIcons = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 16x16 stroke glyphs; every path is a hand-written constant.
  const GLYPHS = Object.freeze({
    folder: '<path d="M2 4.5h4l1.5 1.5H14v7H2z"/>',
    folderOpen: '<path d="M2 4.5h4l1.5 1.5H14v1.5H4.5L3 13H2zM4.5 7.5H15L13 13H3z"/>',
    file: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
    code: '<path d="M6 5 3 8l3 3"/><path d="m10 5 3 3-3 3"/>',
    braces: '<path d="M6 2.5c-1.5 0-2 .75-2 2v2c0 1-.5 1.5-1.5 1.5 1 0 1.5.5 1.5 1.5v2c0 1.25.5 2 2 2"/><path d="M10 2.5c1.5 0 2 .75 2 2v2c0 1 .5 1.5 1.5 1.5-1 0-1.5.5-1.5 1.5v2c0 1.25-.5 2-2 2"/>',
    markdown: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/><path d="M6 8h4M6 10.5h4"/>',
    image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><circle cx="6" cy="7" r="1.2"/><path d="m3.5 12 3.5-3.5 2 2 2-2 2.5 2.5"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 3v1.6M8 11.4V13M3 8h1.6M11.4 8H13M4.5 4.5l1.1 1.1M10.4 10.4l1.1 1.1M11.5 4.5l-1.1 1.1M5.6 10.4l-1.1 1.1"/>',
    diagram: '<rect x="2.5" y="2.5" width="4" height="3.5" rx="0.8"/><rect x="9.5" y="10" width="4" height="3.5" rx="0.8"/><path d="M4.5 6v3.5a2 2 0 0 0 2 2h3"/>',
    // Row 82 additions (budget: 8 new glyphs; 6 used).
    terminal: '<rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="m4.8 6.2 2 1.8-2 1.8"/><path d="M8.6 10.2h2.6"/>',
    database: '<ellipse cx="8" cy="4.5" rx="4.5" ry="1.8"/><path d="M3.5 4.5v7c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8v-7"/><path d="M3.5 8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/><path d="M8 9.6v1.4"/>',
    git: '<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="7" r="1.5"/><path d="M5 5.5v5M11 8.5c0 1.8-1.5 2-6 2.2"/>',
    archive: '<path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11z"/><path d="m2.5 5 5.5 2.5L13.5 5M8 7.5v6"/>',
    font: '<path d="M3.5 13 8 3l4.5 10"/><path d="M5.2 9.5h5.6"/>',
  });

  // extension -> color category. Categories double as the glyph selector via
  // CATEGORY_GLYPHS; unknown extensions fall back to the neutral 'file'.
  const EXTENSION_CATEGORIES = Object.freeze({
    // web
    js: 'js', cjs: 'js', mjs: 'js', jsx: 'js',
    ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts',
    html: 'html', htm: 'html', vue: 'html', svelte: 'html', astro: 'html',
    css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
    // data / config
    json: 'json', jsonc: 'json', json5: 'json',
    yml: 'config', yaml: 'config', toml: 'config', ini: 'config', cfg: 'config', conf: 'config',
    env: 'config', editorconfig: 'config', properties: 'config', xml: 'config',
    sql: 'data', csv: 'data', tsv: 'data', db: 'data', sqlite: 'data', parquet: 'data', ndjson: 'data',
    // systems languages
    c: 'sys', h: 'sys', cpp: 'sys', hpp: 'sys', cc: 'sys', cxx: 'sys', hh: 'sys', cs: 'sys',
    go: 'sys', rs: 'sys', java: 'sys', kt: 'sys', kts: 'sys', swift: 'sys', m: 'sys', mm: 'sys',
    scala: 'sys', zig: 'sys',
    // scripting
    py: 'py', pyi: 'py', pyw: 'py', ipynb: 'py',
    rb: 'script', php: 'script', pl: 'script', lua: 'script', r: 'script', jl: 'script',
    dart: 'script', ex: 'script', exs: 'script', erl: 'script', hs: 'script', clj: 'script',
    elm: 'script', fs: 'script',
    // shell
    ps1: 'shell', psm1: 'shell', psd1: 'shell', sh: 'shell', bash: 'shell', zsh: 'shell',
    fish: 'shell', bat: 'shell', cmd: 'shell',
    // docs
    md: 'md', markdown: 'md', mdx: 'md', rst: 'md', txt: 'md', adoc: 'md', log: 'md',
    // media, fonts, archives
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
    ico: 'image', bmp: 'image', avif: 'image', tiff: 'image',
    ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
    zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive',
    '7z': 'archive', rar: 'archive', jar: 'archive',
    // build, locks, vcs, diagrams
    gradle: 'build', cmake: 'build', mk: 'build',
    lock: 'lock',
    gitignore: 'git', gitattributes: 'git',
    mmd: 'diagram', mermaid: 'diagram', puml: 'diagram', drawio: 'diagram',
  });

  // Lower-cased basename -> category, checked before the extension.
  const FILENAME_CATEGORIES = Object.freeze({
    'package.json': 'archive', 'package-lock.json': 'lock', 'yarn.lock': 'lock', 'pnpm-lock.yaml': 'lock',
    'tsconfig.json': 'config', 'jsconfig.json': 'config', '.editorconfig': 'config',
    '.npmrc': 'config', '.env': 'config', '.env.local': 'config',
    '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.dockerignore': 'git',
    dockerfile: 'build', 'docker-compose.yml': 'build', makefile: 'build', 'cmakelists.txt': 'build',
    'readme.md': 'md', license: 'md', 'changelog.md': 'md',
    'cargo.toml': 'archive', 'go.mod': 'archive', 'pyproject.toml': 'archive', 'requirements.txt': 'archive',
  });

  const CATEGORY_GLYPHS = Object.freeze({
    js: 'code', ts: 'code', py: 'code', html: 'code', css: 'code', sys: 'code', script: 'code',
    shell: 'terminal',
    json: 'braces',
    md: 'markdown',
    image: 'image',
    config: 'gear', build: 'gear',
    data: 'database',
    lock: 'lock',
    git: 'git',
    archive: 'archive',
    font: 'font',
    diagram: 'diagram',
    file: 'file',
  });

  // Own keys only: "x.constructor" must not resolve through Object.prototype.
  const hasOwn = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

  function categoryForName(name) {
    const full = String(name || '');
    const base = full.slice(Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\')) + 1).toLowerCase();
    if (hasOwn(FILENAME_CATEGORIES, base)) return FILENAME_CATEGORIES[base];
    // .env.production, .env.test, ... share the .env look.
    if (base.startsWith('.env.')) return 'config';
    // A leading dot is not an extension (".env", ".bashrc" stay 'file' unless named above).
    const dotIndex = base.lastIndexOf('.');
    const extension = dotIndex > 0 ? base.slice(dotIndex + 1) : '';
    return hasOwn(EXTENSION_CATEGORIES, extension) ? EXTENSION_CATEGORIES[extension] : 'file';
  }

  function glyphKeyForName(name) {
    const category = categoryForName(name);
    return hasOwn(CATEGORY_GLYPHS, category) ? CATEGORY_GLYPHS[category] : 'file';
  }

  function wrapIcon(category, glyphKey) {
    const glyph = GLYPHS[glyphKey] || GLYPHS.file;
    return `<span class="ide-tree-icon ide-tree-icon--${category}" aria-hidden="true">`
      + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"'
      + ' stroke-linecap="round" stroke-linejoin="round">'
      + glyph
      + '</svg></span>';
  }

  function fileIconMarkup(name, kind, { expanded } = {}) {
    if (kind === 'directory') {
      return wrapIcon('folder', expanded ? 'folderOpen' : 'folder');
    }
    return wrapIcon(categoryForName(name), glyphKeyForName(name));
  }

  return {
    CATEGORY_GLYPHS,
    EXTENSION_CATEGORIES,
    FILENAME_CATEGORIES,
    GLYPHS,
    categoryForName,
    fileIconMarkup,
    glyphKeyForName,
  };
});
