'use strict';

// Row 151: shared by the team board tests (the store, the commands and the snapshot route).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Every plain file under `dir` by relative path, as bytes; a link is named, never followed.
function tree(dir) {
  const out = {};
  const walk = (at, rel) => {
    let names;
    try { names = fs.readdirSync(at); } catch { return; }
    for (const name of names.sort()) {
      const full = path.join(at, name);
      const key = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) out[key] = 'link';
      else if (stat.isDirectory()) { out[`${key}/`] = true; walk(full, key); } else out[key] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(dir, '');
  return out;
}

const note = (text = 'hello', x = 0) => ({ op: 'card.add', card: { id: crypto.randomUUID(), kind: 'note', x, y: 0, data: { text } } });
const batch = (...ops) => ({ batch_id: `b-${crypto.randomUUID()}`, ops });

async function must(promise, what = 'call') {
  const answer = await promise;
  if (answer?.ok !== true) throw new Error(`${what}: ${JSON.stringify(answer)}`);
  return answer;
}

module.exports = { batch, must, note, tree };
