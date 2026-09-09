'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SUPPORTED_TAGS } = require('../renderer/shared/i18n-utils');

const BROWSER_INPUTS = Object.freeze(['index.html', 'app.js', 'styles.css']);

function assertRegularFile(filePath, label) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (error) { throw new Error(`Browser input is missing: ${label}`, { cause: error }); }
  if (!stat.isFile()) throw new Error(`Browser input is not a file: ${label}`);
}

function buildBrowser({ root = path.resolve(__dirname, '..'), esbuildImpl = null } = {}) {
  const projectRoot = path.resolve(root);
  const inputRoot = path.join(projectRoot, 'renderer', 'browser');
  const outputRoot = path.join(projectRoot, 'build', 'browser');
  const inputs = Object.fromEntries(BROWSER_INPUTS.map((name) => {
    const filePath = path.join(inputRoot, name);
    assertRegularFile(filePath, `renderer/browser/${name}`);
    return [name, filePath];
  }));
  const esbuild = esbuildImpl || require('esbuild');
  if (!esbuild || typeof esbuild.buildSync !== 'function') {
    throw new Error('esbuild is required for the browser bundle.');
  }
  const buildRoot = path.dirname(outputRoot);
  fs.mkdirSync(buildRoot, { recursive: true });
  if (fs.realpathSync(buildRoot) !== path.resolve(buildRoot)) throw new Error('Browser build directory cannot be a link.');
  if (fs.existsSync(outputRoot) && (!fs.lstatSync(outputRoot).isDirectory() || fs.lstatSync(outputRoot).isSymbolicLink())) {
    throw new Error('Browser output directory cannot be a link.');
  }
  const temporary = fs.mkdtempSync(path.join(buildRoot, '.browser-next-'));
  const previous = fs.mkdtempSync(path.join(buildRoot, '.browser-previous-'));
  fs.rmdirSync(previous);
  let oldMoved = false;
  let promoted = false;
  try {
    fs.copyFileSync(inputs['index.html'], path.join(temporary, 'index.html'));
    fs.copyFileSync(inputs['styles.css'], path.join(temporary, 'styles.css'));
    esbuild.buildSync({
      entryPoints: [inputs['app.js']],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: ['es2022'],
      outfile: path.join(temporary, 'app.js'),
      sourcemap: false,
      minify: true,
      logLevel: 'warning',
    });
    const catalogRoot = path.join(temporary, 'locales');
    fs.mkdirSync(catalogRoot);
    for (const tag of [...SUPPORTED_TAGS, 'qps-ploc']) {
      const source = path.join(projectRoot, 'locales', `${tag}.json`);
      assertRegularFile(source, `locales/${tag}.json`);
      fs.copyFileSync(source, path.join(catalogRoot, `${tag}.json`));
    }
    for (const name of BROWSER_INPUTS) assertRegularFile(path.join(temporary, name), name);
    if (fs.readdirSync(temporary).length !== BROWSER_INPUTS.length + 1) throw new Error('Unexpected browser output.');
    if (fs.existsSync(outputRoot)) { fs.renameSync(outputRoot, previous); oldMoved = true; }
    fs.renameSync(temporary, outputRoot);
    promoted = true;
  } finally {
    if (oldMoved && !promoted) fs.renameSync(previous, outputRoot);
    // Both recursive cleanup targets are unique children of the verified,
    // non-symlink buildRoot; no user-provided path is recursively removed.
    fs.rmSync(temporary, { recursive: true, force: true });
    if (promoted && oldMoved) fs.rmSync(previous, { recursive: true, force: true });
  }
  return Object.freeze({
    outputRoot,
    files: BROWSER_INPUTS.map((name) => path.join(outputRoot, name)),
  });
}

if (require.main === module) {
  try {
    buildBrowser();
  } catch (error) {
    process.stderr.write(`${error?.message || 'Browser build failed.'}\n`);
    process.exitCode = 1;
  }
}

module.exports = { BROWSER_INPUTS, buildBrowser };
