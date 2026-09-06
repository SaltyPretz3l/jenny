'use strict';

// JS mirror of scripts/checks/plugin_parity_corpus.py. Both runtimes must walk
// the sharded corpus identically or the cross-runtime differ would compare
// different case sets and report a false pass. See that module for the shard
// document shape and the reason the corpus is sharded per authoring lane.

const fs = require('node:fs');
const path = require('node:path');

const SHARDS_DIR = path.join(__dirname, '..', '..', 'fixtures', 'plugins', 'contract-parity', 'shards');

function shardPaths() {
  return fs
    .readdirSync(SHARDS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(SHARDS_DIR, name));
}

function loadParityCorpus() {
  const paths = shardPaths();
  if (paths.length === 0) throw new Error(`${SHARDS_DIR}: no parity corpus shards found`);

  const cases = [];
  const expectations = {};
  const owner = new Map();

  for (const shardPath of paths) {
    const name = path.basename(shardPath);
    const document = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
    const shardCases = document.cases;
    const shardExpectations = document.expectations;
    if (!Array.isArray(shardCases) || shardCases.length === 0) {
      throw new Error(`${name}: 'cases' must be a non-empty list`);
    }
    if (!shardExpectations || typeof shardExpectations !== 'object' || Array.isArray(shardExpectations)) {
      throw new Error(`${name}: 'expectations' must be a map`);
    }

    const shardIds = shardCases.map((item) => item.id);
    if (new Set(shardIds).size !== shardIds.length) {
      throw new Error(`${name}: duplicate case ids within the shard`);
    }
    const expectationIds = Object.keys(shardExpectations);
    if (new Set(shardIds).size !== expectationIds.length
      || !shardIds.every((id) => Object.prototype.hasOwnProperty.call(shardExpectations, id))) {
      throw new Error(`${name}: cases/expectations mismatch`);
    }

    for (const id of shardIds) {
      if (owner.has(id)) throw new Error(`${name}: case id '${id}' already defined by ${owner.get(id)}`);
      owner.set(id, name);
    }

    cases.push(...shardCases);
    Object.assign(expectations, shardExpectations);
  }

  return { cases, expectations, shardCount: paths.length };
}

module.exports = { loadParityCorpus, shardPaths, SHARDS_DIR };
