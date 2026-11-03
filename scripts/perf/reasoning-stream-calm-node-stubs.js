'use strict';

// Tiny node-builtin stand-ins for the probe bundle (the harness helpers import
// fs/path at module load). INDEX_HTML is injected by esbuild `define`.

/* global __PROBE_INDEX_HTML__ */
const INDEX_HTML = typeof __PROBE_INDEX_HTML__ === 'string' ? __PROBE_INDEX_HTML__ : '';

function normalize(parts) {
  const out = [];
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

const path = {
  sep: '/',
  join: (...parts) => normalize(parts),
  resolve: (...parts) => normalize(parts),
  dirname: (value) => normalize([String(value), '..']),
  basename: (value) => String(value).split('/').pop(),
  extname: (value) => {
    const base = String(value).split('/').pop();
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot) : '';
  },
  relative: (_from, to) => String(to),
};

const fs = {
  readFileSync: (file) => {
    if (String(file).endsWith('index.html')) return INDEX_HTML;
    throw new Error(`probe fs stub: cannot read ${file}`);
  },
  existsSync: () => false,
};

module.exports = { fs, path };
