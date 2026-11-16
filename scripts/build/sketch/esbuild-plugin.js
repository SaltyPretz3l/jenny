'use strict';

// esbuild plugin that lets vendor/sketchy/ build unedited (vendor/sketchy/JENNY_VENDORING.md).
// It maps the @sketchy/ alias to the vendored tree, swaps the three modules Jenny replaces,
// loads Vite's `?inline` suffix, shims node:module and refuses what must not enter a bundle.

const fs = require('fs');
const path = require('path');

const norm = (file) => file.split(path.sep).join('/');

// Upstream modules Jenny replaces, relative to the vendored root.
const REPLACED = {
  'src/icons.ts': 'replace/icons.ts',
  'src/parts/metadata.ts': 'replace/metadata.ts',
  'viewer/src/palette.ts': 'replace/palette.ts',
};

// Upstream modules that must never be imported for a value. src/parts/index.ts is imported for
// its types only; esbuild drops a type-only import before it resolves, so any hit here is a re-sync
// that started using the part catalog.
const REFUSED = {
  'src/parts/index.ts': 'the part catalog and its SQLite reader are not bundled',
};

function sketchPlugin({ vendorDir, sketchDir, elkFile }) {
  const vendorRoot = norm(vendorDir);
  const replacements = new Map(
    Object.entries(REPLACED).map(([upstream, own]) => [`${vendorRoot}/${upstream}`, path.join(sketchDir, own)]),
  );
  const refused = new Map(Object.entries(REFUSED).map(([upstream, why]) => [`${vendorRoot}/${upstream}`, why]));

  function resolveUpstream(absolute) {
    const ts = norm(absolute.replace(/\.js$/, '.ts'));
    const replaced = replacements.get(ts);
    if (replaced) return { path: replaced };
    const why = refused.get(ts);
    if (why) {
      return {
        errors: [{
          text: `vendor/sketchy: ${ts.slice(vendorRoot.length + 1)} is imported for a value (${why}). `
            + 'Re-check the re-sync recipe in vendor/sketchy/JENNY_VENDORING.md.',
        }],
      };
    }
    return { path: ts.split('/').join(path.sep) };
  }

  return {
    name: 'jenny-sketch',
    setup(build) {
      // Upstream loads elkjs through createRequire(import.meta.url); the shim hands back the bundled copy.
      build.onResolve({ filter: /^node:module$/ }, () => ({ path: path.join(sketchDir, 'replace', 'node-module.ts') }));
      build.onResolve({ filter: /^sketch-elk-impl$/ }, () => ({ path: elkFile }));
      build.onResolve({ filter: /^node:/ }, (args) => ({
        errors: [{ text: `Node built-in in a sketch bundle: ${args.path} from ${args.importer}` }],
      }));

      // Vite's ?inline suffix: .woff2 as a data URL, .css as text. Registered before the path mapper
      // so the suffix wins over the @sketchy/ rule.
      build.onResolve({ filter: /\?inline$/ }, async (args) => {
        const bare = args.path.replace(/\?inline$/, '');
        if (bare.startsWith('.')) return { path: path.resolve(args.resolveDir, bare), namespace: 'inline' };
        if (bare.startsWith('@sketchy/')) return { path: path.join(vendorDir, bare.slice('@sketchy/'.length)), namespace: 'inline' };
        const resolved = await build.resolve(bare, { kind: 'import-statement', resolveDir: args.resolveDir });
        if (resolved.errors.length) return { errors: resolved.errors };
        return { path: resolved.path, namespace: 'inline' };
      });
      build.onLoad({ filter: /.*/, namespace: 'inline' }, (args) => ({
        contents: fs.readFileSync(args.path),
        loader: args.path.endsWith('.css') ? 'text' : 'dataurl',
        watchFiles: [args.path],
      }));

      build.onResolve({ filter: /^@sketchy\// }, (args) => resolveUpstream(path.join(vendorDir, args.path.slice('@sketchy/'.length))));

      // Relative imports inside the vendored tree: apply the replacements and the refusals.
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.namespace !== 'file' || !norm(args.importer).startsWith(`${vendorRoot}/`)) return undefined;
        return resolveUpstream(path.resolve(args.resolveDir, args.path));
      });
    },
  };
}

module.exports = { sketchPlugin, REPLACED, REFUSED };
