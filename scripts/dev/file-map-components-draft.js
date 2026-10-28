#!/usr/bin/env node
'use strict';

// Row 77 phase 0: headless File Map Components draft.
//
// Scans a git checkout the way the File Map service does (git's non-ignored
// files, contents of the files the import scanner reads, tsconfig aliases),
// builds the engine graph, drafts the component tree and prints it.
//
//   node scripts/dev/file-map-components-draft.js [root] [--depth N] [--json out.json]
//
// The draft partitions source files only (classifyPath, D14); tests, docs and
// other files are printed as the groups beside the tree.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildGraph } = require('../../services/workspace-file-map-engine');
const { isDependencyContentPath, parseTsconfigAliases, EMPTY_ALIASES } = require('../../services/workspace-file-map-scan-rules');
const { draftComponents } = require('../../services/workspace-file-map-components');

function parseArgs(argv) {
  const args = { root: process.cwd(), depth: 3, json: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--depth') args.depth = Number(argv[++i]) || 3;
    else if (arg === '--json') args.json = argv[++i] || '';
    else args.root = path.resolve(arg);
  }
  return args;
}

function listFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return Array.from(new Set(out.split('\0').filter(Boolean)))
    .filter((relPath) => fs.existsSync(path.join(root, relPath)))
    .sort();
}

function printTree(result) {
  const byParent = new Map();
  for (const component of result.components) {
    const key = component.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(component);
  }
  const scopes = new Map(result.scopes.map((scope) => [scope.id, scope]));
  const lines = [];
  const rootScope = scopes.get('root');
  const sourceFiles = result.components.filter((c) => c.parentId === null).reduce((sum, c) => sum + c.fileCount, 0);
  lines.push(`root: ${sourceFiles} source files, rung ${rootScope.rung}, axis ${rootScope.axis || '-'}${rootScope.leafReason ? `, ${rootScope.leafReason}` : ''}`);
  const visit = (parentId, indent) => {
    for (const component of byParent.get(parentId) || []) {
      const scope = scopes.get(component.id);
      let detail = '';
      if (scope && scope.rung === 'leaf') detail = `  [leaf: ${scope.leafReason}]`;
      else if (scope) detail = `  [${scope.rung}]`;
      const parts = component.parts.length ? `  <- ${component.parts.slice(0, 6).join(', ')}${component.parts.length > 6 ? ', ...' : ''}` : '';
      lines.push(`${'  '.repeat(indent)}${component.id} ${component.name} (${component.fileCount})${detail}${parts}`);
      visit(component.id, indent + 1);
    }
  };
  visit('', 1);
  const rootRelations = result.relations
    .filter((relation) => relation.scopeId === 'root')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 15);
  const names = new Map(result.components.map((component) => [component.id, component.name]));
  lines.push('', 'Top root relations (importer -> imported, file-pair imports):');
  for (const relation of rootRelations) {
    lines.push(`  ${names.get(relation.from)} -> ${names.get(relation.to)}: ${relation.weight}`);
  }
  lines.push('', 'Beside the tree (files; importing files per root component):');
  for (const group of result.outside) {
    const into = result.outsideRelations
      .filter((relation) => relation.from === group.id)
      .map((relation) => `${names.get(relation.to)} ${relation.files}`)
      .join(', ');
    lines.push(`  ${group.id} (${group.fileCount})${into ? `: ${into}` : ''}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const files = listFiles(args.root);
  const contents = new Map();
  for (const relPath of files) {
    if (!isDependencyContentPath(relPath) && relPath !== 'tsconfig.json') continue;
    try {
      contents.set(relPath, fs.readFileSync(path.join(args.root, relPath), 'utf8'));
    } catch {
      // Unreadable: the engine keeps the node with no edges.
    }
  }
  let aliases = EMPTY_ALIASES;
  if (contents.has('tsconfig.json')) aliases = parseTsconfigAliases(contents.get('tsconfig.json'));
  const scanned = Date.now();
  const graph = buildGraph({
    files,
    readContent: (relPath) => {
      if (!contents.has(relPath)) throw new Error('unread');
      return contents.get(relPath);
    },
    cochangeCommits: [],
    tsconfigAliases: aliases,
  });
  const built = Date.now();
  const result = draftComponents(graph, { maxDepth: args.depth });
  const drafted = Date.now();
  const importEdges = graph.edges.filter((edge) => edge.kind === 'import').length;
  console.log(`${args.root}: ${graph.nodes.length} files, ${importEdges} import edges`);
  console.log(`read ${scanned - started} ms, graph ${built - scanned} ms, components ${drafted - built} ms`);
  console.log(printTree(result));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(result, null, 2));
}

main();
