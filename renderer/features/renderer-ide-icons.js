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
  const GLYPHS = {
    folder: '<path d="M2 4.5h4l1.5 1.5H14v7H2z"/>',
    folderOpen: '<path d="M2 4.5h4l1.5 1.5H14v1.5H4.5L3 13H2zM4.5 7.5H15L13 13H3z"/>',
    file: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
    code: '<path d="M6 5 3 8l3 3"/><path d="m10 5 3 3-3 3"/>',
    braces: '<path d="M6 2.5c-1.5 0-2 .75-2 2v2c0 1-.5 1.5-1.5 1.5 1 0 1.5.5 1.5 1.5v2c0 1.25.5 2 2 2"/><path d="M10 2.5c1.5 0 2 .75 2 2v2c0 1 .5 1.5 1.5 1.5-1 0-1.5.5-1.5 1.5v2c0 1.25-.5 2-2 2"/>',
    markdown: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/><path d="M6 8h4M6 10.5h4"/>',
    image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><circle cx="6" cy="7" r="1.2"/><path d="m3.5 12 3.5-3.5 2 2 2-2 2.5 2.5"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 3v1.6M8 11.4V13M3 8h1.6M11.4 8H13M4.5 4.5l1.1 1.1M10.4 10.4l1.1 1.1M11.5 4.5l-1.1 1.1M5.6 10.4l-1.1 1.1"/>',
    diagram: '<rect x="2.5" y="2.5" width="4" height="3.5" rx="0.8"/><rect x="9.5" y="10" width="4" height="3.5" rx="0.8"/><path d="M4.5 6v3.5a2 2 0 0 0 2 2h3"/>',
  };

  // extension -> color category. Categories double as the glyph selector via
  // CATEGORY_GLYPHS; unknown extensions fall back to the neutral 'file'.
  const EXTENSION_CATEGORIES = {
    js: 'js', cjs: 'js', mjs: 'js', jsx: 'js',
    ts: 'ts', tsx: 'ts',
    py: 'py',
    ps1: 'shell', psm1: 'shell', sh: 'shell', bash: 'shell', bat: 'shell', cmd: 'shell',
    html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    json: 'json', jsonc: 'json',
    md: 'md', markdown: 'md',
    yml: 'config', yaml: 'config', toml: 'config', ini: 'config', cfg: 'config', conf: 'config',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', ico: 'image', bmp: 'image',
    mmd: 'diagram', mermaid: 'diagram',
  };

  const CATEGORY_GLYPHS = {
    js: 'code', ts: 'code', py: 'code', shell: 'code', html: 'code', css: 'code',
    json: 'braces',
    md: 'markdown',
    image: 'image',
    config: 'gear',
    diagram: 'diagram',
    file: 'file',
  };

  function categoryForName(name) {
    const normalized = String(name || '');
    const dotIndex = normalized.lastIndexOf('.');
    const extension = dotIndex > 0 ? normalized.slice(dotIndex + 1).toLowerCase() : '';
    return EXTENSION_CATEGORIES[extension] || 'file';
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
    const category = categoryForName(name);
    return wrapIcon(category, CATEGORY_GLYPHS[category] || 'file');
  }

  return {
    categoryForName,
    fileIconMarkup,
  };
});
