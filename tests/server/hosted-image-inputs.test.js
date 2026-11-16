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

// Source operands of non-`--from` COPY lines; `locales/*.json` style globs kept, `--chmod=` style flags dropped.
function copySources(stage) {
  return stage.split('\n').map((l) => l.trim()).filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
    .map((l) => l.split(/\s+/).slice(1, -1).filter((s) => !s.startsWith('--')).map((s) => s.replace(/^\.\//, '')))
    .flat();
}

// Both images (slice 3-11 added the team image). A build output copied from the context is matched
// by the source it is built from: the path filters name sources, not build outputs.
const DOCKERFILES = ['Dockerfile', 'Dockerfile.team'];
const BUILT_FROM = Object.freeze({ 'build/sidecar/jenny-team-bridge': 'native/jenny-team-bridge/src/main.rs' });

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
    return { negate, re: new RegExp(`^${body}(/.*)?$`), literal: /[*?[]/.test(pattern) ? null : pattern.replace(/^\//, '') };
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
    // Docker still walks an excluded directory when an exception names a literal path beneath it.
    if (!parentOk && rules.some((rule) => rule.negate && rule.literal?.startsWith(`${parent}/`)
      && (rel === rule.literal || rel.startsWith(`${rule.literal}/`)))) continue;
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
  for (const name of DOCKERFILES) {
    const { builder, runtime } = builderStage(read(name));
    const sources = [...copySources(builder), ...copySources(runtime)].filter((s) => s !== '.');
    const unmatched = sources.filter((src) => {
      const built = BUILT_FROM[src] ?? src;
      const probe = fs.existsSync(path.join(ROOT, built)) && fs.statSync(path.join(ROOT, built)).isDirectory() ? `${built}/x.js` : built;
      return !filters.some((f) => new RegExp(`^${globToRegex(f)}$`).test(probe));
    });
    assert.deepEqual(unmatched, [], `${name} COPY sources without a hosted.yml path filter: ${unmatched.join(', ')}`);
    assert.ok(filters.includes(name), `${name} itself must trigger the hosted lane`);
  }
  assert.ok(filters.includes('compose.team.yml'));
  // The shared execution broker (DKR-008) must trigger the hosted lane.
  assert.ok(filters.some((f) => new RegExp(`^${globToRegex(f)}$`).test('services/execution/execution-broker.js')));
});

test('every context COPY source of both Dockerfiles is admitted by .dockerignore', () => {
  const rules = ignoreRules(read('.dockerignore'));
  for (const name of DOCKERFILES) {
    const { builder, runtime } = builderStage(read(name));
    const refused = [...copySources(builder), ...copySources(runtime)].filter((src) => {
      const isDirectory = fs.existsSync(path.join(ROOT, src)) && fs.statSync(path.join(ROOT, src)).isDirectory();
      // A glob source is probed with one concrete name; a directory with a file inside it.
      const probe = src.includes('*') ? src.replace('*', 'en') : isDirectory ? `${src}/index.js` : src;
      return !admitted(rules, probe);
    });
    assert.deepEqual(refused, [], `${name} COPY sources excluded by .dockerignore: ${refused.join(', ')}`);
  }
  // The bridge is admitted alone: nothing else under build/ enters the context.
  for (const other of ['build/sidecar/sidecar', 'build/sidecar/jenny-team-bridge.exe', 'build/release.log', 'build/browser/app.js']) {
    assert.equal(admitted(rules, other), false, other);
  }
});

test('final image pre-creates the staging volume for the sandbox', () => {
  assert.match(read('Dockerfile'), /install -d -m 0700 -o 10001 -g 10001 \/inputs \/workspace \/run\/jenny-staging/);
});
