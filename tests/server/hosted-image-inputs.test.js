'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { browserBundleOptions } = require('../../scripts/build-browser');

const ROOT = path.resolve(__dirname, '../..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n');

function builderStage(dockerfile) {
  const stages = dockerfile.split(/^FROM /m).slice(1);
  return { builder: stages[0], runtime: stages[1] };
}

// Source operands of non-`--from` COPY lines; `locales/*.json` style globs kept.
function copySources(stage) {
  return stage.split('\n').map((l) => l.trim()).filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
    .map((l) => l.split(/\s+/).slice(1, -1).map((s) => s.replace(/^\.\//, '')))
    .flat();
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { out += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; } else if (c === '*') out += '[^/]*';
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function ignoreRules(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const negate = l.startsWith('!');
    const pattern = negate ? l.slice(1) : l;
    const body = globToRegex(pattern.replace(/^\//, ''));
    // Docker patterns match from the context root; a leading `**/` matches at any depth.
    return { negate, re: new RegExp(`^${body}(/.*)?$`) };
  });
}

function admitted(rules, rel) {
  let ok = true;
  const parts = rel.split('/');
  // Docker evaluates the path and every parent; the last matching rule on the file wins.
  for (const rule of rules) { if (rule.re.test(rel)) ok = rule.negate; }
  // An excluded parent directory is only re-admitted by an explicit rule for that parent.
  for (let i = 1; i < parts.length; i += 1) {
    const parent = parts.slice(0, i).join('/');
    let parentOk = true;
    for (const rule of rules) { if (rule.re.test(parent) && new RegExp(`^${rule.re.source.replace(/\(\/\.\*\)\?\$$/, '')}$`).test(parent)) parentOk = rule.negate; }
    if (!parentOk) return false;
  }
  return ok;
}

function copiedBy(sources, rel) {
  return sources.some((src) => {
    if (src === '.') return true;
    return new RegExp(`^${globToRegex(src)}(/.*)?$`).test(rel);
  });
}

function bundleClosure() {
  const esbuild = require('esbuild');
  const entry = path.join(ROOT, 'renderer', 'browser', 'app.js');
  const result = esbuild.buildSync({
    ...browserBundleOptions({ entry, outfile: path.join(ROOT, 'build', 'closure-probe.js') }),
    write: false, metafile: true, logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs)
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !p.startsWith('node_modules/') && !p.includes('/node_modules/'));
}

test('browser bundle closure is covered by the Dockerfile builder COPYs and .dockerignore', () => {
  const closure = bundleClosure();
  assert.ok(closure.includes('renderer/browser/app.js'));
  const { builder } = builderStage(read('Dockerfile'));
  const sources = copySources(builder);
  const rules = ignoreRules(read('.dockerignore'));
  const notCopied = closure.filter((f) => !copiedBy(sources, f));
  const notAdmitted = closure.filter((f) => !admitted(rules, f));
  assert.deepEqual(notCopied, [], `bundle inputs missing from Dockerfile builder COPY: ${notCopied.join(', ')}`);
  assert.deepEqual(notAdmitted, [], `bundle inputs excluded by .dockerignore: ${notAdmitted.join(', ')}`);
});

test('hosted.yml path filters follow the Dockerfile COPY sources', () => {
  const workflow = read('.github/workflows/hosted.yml');
  const block = workflow.match(/pull_request:\s*\n\s+paths:\n((?:\s+- .*\n)+)/);
  assert.ok(block, 'pull_request.paths block present');
  const filters = block[1].split('\n').map((l) => l.replace(/^\s*- /, '').replace(/^'|'$/g, '').trim()).filter(Boolean);
  const { builder, runtime } = builderStage(read('Dockerfile'));
  const sources = [...copySources(builder), ...copySources(runtime)].filter((s) => s !== '.');
  const unmatched = sources.filter((src) => {
    const probe = fs.existsSync(path.join(ROOT, src)) && fs.statSync(path.join(ROOT, src)).isDirectory() ? `${src}/x.js` : src;
    return !filters.some((f) => new RegExp(`^${globToRegex(f)}$`).test(probe));
  });
  assert.deepEqual(unmatched, [], `Dockerfile COPY sources without a hosted.yml path filter: ${unmatched.join(', ')}`);
  // The shared execution broker (DKR-008) must trigger the hosted lane.
  assert.ok(filters.some((f) => new RegExp(`^${globToRegex(f)}$`).test('services/execution/execution-broker.js')));
});

test('final image pre-creates the staging volume for the sandbox', () => {
  assert.match(read('Dockerfile'), /install -d -m 0700 -o 10001 -g 10001 \/inputs \/workspace \/run\/jenny-staging/);
});
