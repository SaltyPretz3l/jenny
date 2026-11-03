'use strict';
// Conformance of services/work-leases against the language-neutral vectors in
// tests/fixtures/work-leases/v1/. Cases are read from the files, never copied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { computeGrants, uncoveredTakes } = require('../services/work-leases/grant');
const { isTicketDead } = require('../services/work-leases/liveness');
const { normalizePathForKey, resourceKey } = require('../services/work-leases/paths');
const {
  MAX_RESOURCES, MAX_TICKET_BYTES, parseTicket, redactLabel, serializeTicket,
} = require('../services/work-leases/record');

const VECTOR_DIR = path.join(__dirname, 'fixtures', 'work-leases', 'v1');

function loadVectors(file) {
  const parsed = JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, file), 'utf8'));
  assert.equal(parsed.version, 1, `${file} version`);
  assert.ok(Array.isArray(parsed.cases) && parsed.cases.length > 0, `${file} has cases`);
  const names = parsed.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, `${file} case names are unique`);
  return parsed.cases;
}

test('every vector file is present and well formed', () => {
  const files = fs.readdirSync(VECTOR_DIR).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(files, [
    'coverage-vectors.json', 'grant-vectors.json', 'liveness-vectors.json',
    'path-vectors.json', 'record-vectors.json',
  ]);
  for (const file of files) loadVectors(file);
});

for (const c of loadVectors('grant-vectors.json')) {
  test(`grant: ${c.name}`, () => {
    assert.deepEqual(computeGrants(c.tickets), c.expect_grants);
  });
}

for (const c of loadVectors('coverage-vectors.json')) {
  test(`coverage: ${c.name}`, () => {
    assert.deepEqual(uncoveredTakes(c.tickets, c.inherited, c.request), c.expect_uncovered);
  });
}

function probeFrom(spec) {
  return {
    available: spec.available,
    alive: () => spec.alive,
    startTime: () => spec.start,
  };
}

for (const c of loadVectors('liveness-vectors.json')) {
  test(`liveness: ${c.name}`, () => {
    const dead = isTicketDead(
      { owner: c.owner, heartbeat_at: c.heartbeat_at },
      {
        me: c.me,
        probe: probeFrom(c.probe),
        now: c.now,
        observerResumedRecently: c.observer_resumed_recently === true,
        staleAfterS: 60,
        unknownStartHorizonS: 600,
      },
    );
    assert.equal(dead ? 'dead' : 'live', c.expect);
  });
}

for (const c of loadVectors('path-vectors.json')) {
  test(`path: ${c.name}`, () => {
    assert.equal(normalizePathForKey(c.path, c.platform), c.expect);
  });
}

for (const c of loadVectors('record-vectors.json')) {
  test(`record: ${c.name}`, () => {
    const inputs = c.raw !== undefined ? [c.raw] : [c.record, JSON.stringify(c.record)];
    for (const input of inputs) {
      const result = parseTicket(input);
      if (c.expect === 'corrupt') {
        assert.equal(result.ok, false);
        assert.equal(typeof result.reason, 'string');
        continue;
      }
      assert.equal(result.ok, true, result.reason);
      const { state, enforcement, resources } = result.ticket;
      assert.deepEqual({ state, enforcement, resources }, c.normalized);
    }
  });
}

test('record: unknown fields stay out of the normalized view', () => {
  const vectors = loadVectors('record-vectors.json');
  const future = vectors.find((c) => c.name.startsWith('future version'));
  const { ticket } = parseTicket(future.record);
  assert.equal(ticket.lineage, undefined);
  assert.equal(ticket.owner.region, undefined);
  assert.equal(ticket.resources[0].weight_curve, undefined);
  assert.equal(ticket.v, 3);
});

test('record: size limit applies to raw text', () => {
  const vectors = loadVectors('record-vectors.json');
  const base = vectors.find((c) => c.name === 'complete v1 record').record;
  const padded = JSON.stringify({ ...base, pad: 'x'.repeat(MAX_TICKET_BYTES) });
  assert.ok(Buffer.byteLength(padded) > MAX_TICKET_BYTES);
  assert.equal(parseTicket(padded).ok, false);
  assert.equal(parseTicket(JSON.stringify(base)).ok, true);
  assert.equal(MAX_RESOURCES, 16);
});

test('record: serialize round-trips through parse and keeps the v1 fields', () => {
  const vectors = loadVectors('record-vectors.json');
  const base = vectors.find((c) => c.name === 'complete v1 record').record;
  const { ticket } = parseTicket(base);
  const text = serializeTicket(ticket);
  assert.ok(text.endsWith('\n'));
  const again = parseTicket(text);
  assert.equal(again.ok, true);
  assert.deepEqual(again.ticket, ticket);
  assert.deepEqual(JSON.parse(text), base);
});

test('redactLabel collapses whitespace, hides URL credentials and caps length', () => {
  assert.equal(redactLabel('npm   test\n --  foo'), 'npm test -- foo');
  assert.equal(redactLabel('git clone https://user:s3cret@example.com/r.git'), 'git clone https://***@example.com/r.git');
  assert.equal(redactLabel('curl ssh://a@h:2222/x'), 'curl ssh://***@h:2222/x');
  assert.equal(redactLabel('a'.repeat(500)).length, 120);
  assert.equal(redactLabel(undefined), '');
  assert.ok(!redactLabel(`x https://${'u'.repeat(200)}:pw@host`).includes('pw@'));
});

test('resourceKey builds repo and tree scoped keys', () => {
  assert.equal(resourceKey('git-write', 'repo', null, 'win32'), 'git-write@repo');
  assert.equal(resourceKey('tests', 'tree', 'G:\\Work\\Jenny\\', 'win32'), 'tests@tree:g:/work/jenny');
  assert.equal(resourceKey('deps', 'tree', '/Home/U/Repo/', 'posix'), 'deps@tree:/Home/U/Repo');
  assert.throws(() => resourceKey('Bad Kind', 'repo', null, 'posix'), TypeError);
  assert.throws(() => resourceKey('tests', 'tree', `/${'a'.repeat(600)}`, 'posix'), TypeError);
});
