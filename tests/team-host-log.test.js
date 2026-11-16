'use strict';

// The desktop team host's log sink (services/team/host/host-log.js, owner decision E51): the child's
// stdout into a bounded rotating file, kept only as ids, counts and reason words. A PassThrough
// stands in for the child's stdout; everything runs in a fresh temp folder.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const test = require('node:test');

const {
  LOG_FILE_BYTES, LOG_FILES, MAX_LINE_BYTES, MAX_PENDING_BYTES, createHostLogSink,
} = require('../services/team/host/host-log');
const { deriveTeamId, keyPairFromSeed, newId } = require('../server/team/ids');
const { defaultIdFactory } = require('../services/projects/project-service');
const { fileSymlinkSkip, linkDirectory } = require('./helpers/platform-skips');

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0, 0);
const TIMESTAMP = new Date(NOW).toISOString();
const settle = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

function line(fields = {}, event = 'team.host.state') {
  return `${JSON.stringify({ ...fields, timestamp: TIMESTAMP, level: 'INFO', event })}\n`;
}

function setup(t, { fsImpl } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-log-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'team-host');
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const says = [];
  const open = (stream = new PassThrough()) => {
    const sink = createHostLogSink({ stream, logsDir, now: () => NOW, say: (...args) => says.push(args), ...(fsImpl ? { fsImpl } : {}) });
    t.after(() => sink.end());
    return { stream, sink };
  };
  const file = path.join(logsDir, 'host.log');
  const lines = (target = file) => fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text));
  return { base, root, logsDir, file, says, open, lines };
}

test('three good lines are kept in order, one JSON object per line', async (t) => {
  const { open, lines, file } = setup(t);
  const { stream, sink } = open();
  for (const index of [1, 2, 3]) stream.write(line({ seq: index, reason: 'team_host_ready' }));
  await settle();
  assert.deepEqual(lines().map((entry) => entry.seq), [1, 2, 3]);
  assert.deepEqual(lines()[0], { seq: 1, reason: 'team_host_ready', timestamp: TIMESTAMP, level: 'INFO', event: 'team.host.state' });
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 4, 'three lines and the last newline');
  // A line split across two chunks, and a CRLF ending, are still one line.
  const split = line({ seq: 4 });
  stream.write(split.slice(0, 20));
  stream.write(`${split.slice(20, -1)}\r\n`);
  await settle();
  assert.deepEqual(lines().map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.equal(sink.stats().kept, 4);
});

test('a line over 4,096 bytes, not JSON, an array, a nested object or no event is dropped whole and counted', async (t) => {
  const { open, lines } = setup(t);
  const { stream, sink } = open();
  const bad = [
    `${JSON.stringify({ timestamp: TIMESTAMP, level: 'INFO', event: 'team.host.state', pad: 'a'.repeat(MAX_LINE_BYTES) })}\n`,
    'not json at all\n',
    `${JSON.stringify([TIMESTAMP, 'INFO', 'team.host.state'])}\n`,
    `${JSON.stringify({ wrapped: { timestamp: TIMESTAMP, level: 'INFO', event: 'team.host.state' } })}\n`,
    `${JSON.stringify({ timestamp: TIMESTAMP, level: 'INFO' })}\n`,
    `${JSON.stringify({ timestamp: TIMESTAMP, level: 'LOUD', event: 'team.host.state' })}\n`,
    `${JSON.stringify({ timestamp: 'yesterday', level: 'INFO', event: 'team.host.state' })}\n`,
    `${JSON.stringify({ timestamp: TIMESTAMP, level: 'INFO', event: 'Not a dotted word' })}\n`,
  ];
  bad.forEach((text, index) => { stream.write(text); stream.write(line({ seq: index })); });
  await settle();
  assert.deepEqual(lines().map((entry) => entry.seq), bad.map((_text, index) => index), 'each next good line is kept');
  assert.equal(sink.stats().dropped_lines, bad.length);
  sink.end();
  assert.equal(lines().at(-1).dropped_lines, bad.length);
});

test('a field that is not a plain value is dropped and counted, and its bytes never reach the file', async (t) => {
  const { open, lines, file } = setup(t);
  const { stream, sink } = open();
  const unsafe = {
    key: crypto.randomBytes(32).toString('base64url'),
    ipv4: '192.168.1.20',
    ipv4_port: '192.168.1.20:4242',
    ipv6_port: '[fe80::1]:4242',
    ipv6: '2001:db8::1',
    spaced: 'two words',
    long_word: `${'ab.'.repeat(53)}ab`,
    path: 'C:\\Users\\someone\\team-host',
    invite: 'jteam1_abcdef',
  };
  stream.write(line({ ...unsafe, nested: { a: 1 }, list: [1, 2], Upper: 'x', infinite: 'Infinity' }));
  const seed = crypto.randomBytes(32);
  const projectId = defaultIdFactory();
  const ids = {
    team_id: deriveTeamId(keyPairFromSeed(seed).publicKey), member_id: newId('member'), device_id: newId('device'),
    invite_id: newId('invite'), project_id: projectId, channel_id: `chan_${projectId}`, request_id: crypto.randomUUID(),
  };
  const safe = { ...ids, count: 3, ratio: 0.5, ok: true, nothing: null, reason: 'team_host_busy', word: 'ENOENT' };
  stream.write(line(safe));
  await settle();
  const [first, second] = lines();
  assert.deepEqual(Object.keys(first), ['infinite', 'timestamp', 'level', 'event', 'dropped_fields']);
  assert.equal(first.dropped_fields, Object.keys(unsafe).length + 3);
  const bytes = fs.readFileSync(file, 'utf8');
  for (const value of Object.values(unsafe)) assert.equal(bytes.includes(value), false, value);
  assert.equal(bytes.includes(JSON.stringify(unsafe.path).slice(1, -1)), false, 'not even escaped');
  assert.deepEqual(second, { ...safe, timestamp: TIMESTAMP, level: 'INFO', event: 'team.host.state' }, 'real ids, counts, booleans and reason words pass');
  assert.equal(sink.stats().dropped_fields, first.dropped_fields);
});

test('the file rotates at its cap with at most three files, the oldest removed', async (t) => {
  const { open, logsDir, file } = setup(t);
  const { stream, sink } = open();
  const pad = 'pqrs'.repeat(7); // under 32, so not a key-like run: it is kept
  const fields = Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`f${index}`, pad]));
  const size = Buffer.byteLength(line({ seq: 0, ...fields }));
  const total = Math.ceil((LOG_FILES * LOG_FILE_BYTES) / size) + 20;
  for (let seq = 0; seq < total; seq += 1) {
    stream.write(line({ seq, ...fields }));
    if (seq % 10 === 9) await settle();
  }
  await settle();
  sink.end();
  assert.deepEqual(fs.readdirSync(logsDir).sort(), ['host.log', 'host.log.1', 'host.log.2']);
  for (const name of fs.readdirSync(logsDir)) assert.ok(fs.statSync(path.join(logsDir, name)).size <= LOG_FILE_BYTES, name);
  const seqs = ['host.log.2', 'host.log.1', 'host.log'].flatMap((name) => fs.readFileSync(path.join(logsDir, name), 'utf8')
    .split('\n').filter(Boolean).map((text) => JSON.parse(text).seq).filter((seq) => seq !== undefined));
  assert.ok(seqs[0] > 0, 'the oldest lines are gone');
  assert.equal(seqs.at(-1), total - 1);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'in order across the files');
  assert.equal(fs.existsSync(`${file}.3`), false);
});

test('a flood keeps the pending queue within its cap, drops are counted and the closing line carries the counts', async (t) => {
  const { open, lines } = setup(t);
  const { stream, sink } = open();
  stream.write(Array.from({ length: 10_000 }, (_unused, seq) => line({ seq })).join(''));
  await settle();
  const stats = sink.stats();
  assert.ok(stats.peak_pending_bytes <= MAX_PENDING_BYTES, `${stats.peak_pending_bytes}`);
  assert.ok(stats.dropped_pressure > 0);
  assert.equal(stats.kept + stats.dropped_pressure, 10_000);
  assert.equal(stream.readableFlowing, true, 'the stream is never left paused');
  sink.end();
  const closing = lines().at(-1);
  assert.deepEqual(closing, { timestamp: TIMESTAMP, level: 'INFO', event: 'team.host_log.closed', kept: stats.kept,
    dropped_lines: 0, dropped_fields: 0, dropped_pressure: stats.dropped_pressure });
  assert.equal(lines().length, stats.kept + 1);
});

test('a write that throws stops the file for the run: one WARN with a reason word and no path, no further writes', async (t) => {
  let writes = 0;
  const fsImpl = { ...fs, realpathSync: fs.realpathSync, writeSync: () => { writes += 1; throw Object.assign(new Error('disk full at C:\\x'), { code: 'ENOSPC' }); } };
  const { open, says, logsDir } = setup(t, { fsImpl });
  const { stream, sink } = open();
  stream.write(line({ seq: 1 }));
  await settle();
  stream.write(line({ seq: 2 }));
  await settle();
  sink.end();
  assert.equal(writes, 1);
  assert.deepEqual(says, [['WARN', 'team.host.log_stopped', { reason: 'team_host_log_write_failed' }]]);
  assert.equal(JSON.stringify(says).includes(logsDir), false);
  assert.equal(stream.listenerCount('data'), 0);
});

test('end removes every listener but a no-op error listener and closes the file; a second sink appends', async (t) => {
  const { open, lines } = setup(t);
  const first = open();
  first.stream.write(line({ seq: 1 }));
  await settle();
  first.sink.end();
  assert.equal(first.stream.listenerCount('data'), 0);
  assert.equal(first.stream.listenerCount('error'), 1, 'only the no-op stays');
  assert.equal(first.stream.listeners('error')[0](new Error('late')), undefined);
  assert.deepEqual(first.sink.resources(), { reading: false, open: false, pending_bytes: 0 });
  first.sink.end();
  const second = open();
  second.stream.write(line({ seq: 2 }));
  await settle();
  second.sink.end();
  assert.deepEqual(lines().map((entry) => entry.seq ?? entry.event), [1, 'team.host_log.closed', 2, 'team.host_log.closed']);
});

test('a logs folder that is a link, or no folder at all, keeps nothing and still reads the stream', async (t) => {
  const { base, logsDir, says, file } = setup(t);
  fs.rmSync(logsDir, { recursive: true });
  fs.mkdirSync(path.join(base, 'elsewhere'));
  linkDirectory(path.join(base, 'elsewhere'), logsDir);
  const stream = new PassThrough();
  const sink = createHostLogSink({ stream, logsDir, say: (...args) => says.push(args) });
  stream.write(line({ seq: 1 }));
  await settle();
  sink.end();
  assert.deepEqual(fs.readdirSync(path.join(base, 'elsewhere')), []);
  assert.deepEqual(says, [['WARN', 'team.host.log_stopped', { reason: 'team_host_log_folder_invalid' }]]);
  const none = createHostLogSink({ stream: new PassThrough(), logsDir: null });
  none.end();
  assert.equal(fs.existsSync(file), false);
});

test('the sink touches nothing under the profile, the projects folder or the trash', async (t) => {
  const { root, open } = setup(t);
  const listing = () => ['profile', 'projects', 'trash'].flatMap((name) => {
    const dir = path.join(root, name);
    return fs.readdirSync(dir).map((entry) => `${name}/${entry}:${fs.statSync(path.join(dir, entry)).size}`);
  });
  for (const name of ['profile', 'projects', 'trash']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'kept.txt'), name);
  }
  const before = listing();
  const { stream, sink } = open();
  stream.write(line({ seq: 1 }));
  await settle();
  sink.end();
  assert.deepEqual(listing(), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'logs')), ['host.log']);
});

// Resolves to true when `promise` settles within `ms`, false otherwise; leaves no timer behind.
function within(promise, ms) {
  let timer;
  return Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })])
    .finally(() => clearTimeout(timer));
}

// One line of exactly `bytes` bytes before its newline, padded with plain-word fields.
function sizedLine(bytes, seq) {
  const fields = { seq };
  const size = () => Buffer.byteLength(line(fields)) - 1;
  // A field `"qNNN":"v",` costs 10 bytes plus its value; never leave a remainder too small for one.
  for (let index = 0; size() < bytes; index += 1) {
    const room = bytes - size();
    let value = 30;
    if (room - 10 <= 30) value = room - 10;
    else if (room - 40 < 11) value = 15;
    fields[`q${String(index).padStart(3, '0')}`] = 'x'.repeat(value);
  }
  assert.equal(size(), bytes);
  return line(fields);
}

test('the hostile-line table: each event, name and value that breaks the rule is dropped and counted, real ids pass', async (t) => {
  const { open, lines, file } = setup(t);
  const { stream, sink } = open();
  const hex = crypto.randomBytes(32).toString('hex');
  const b64url = crypto.randomBytes(32).toString('base64url');
  const projectId = defaultIdFactory();
  const real = {
    team_id: deriveTeamId(keyPairFromSeed(crypto.randomBytes(32)).publicKey), member_id: newId('member'),
    device_id: newId('device'), invite_id: newId('invite'), project_id: projectId, channel_id: `chan_${projectId}`,
    lease_id: `lease_${crypto.randomBytes(16).toString('base64url')}`, upload_id: `upload_${crypto.randomBytes(16).toString('base64url')}`,
    request_id: crypto.randomUUID(), code: 'ERR_FS_EISDIR', reason: 'team_host_log_write_failed', count: 12.5,
    // The id shape is 32 characters wide on purpose (a project id's tail), so this is kept.
    wide_id: `device_${'a1'.repeat(16)}`,
    [`n${'m'.repeat(30)}`]: 1,
  };
  // Each of these events drops its line whole.
  const badEvents = ['ip.192.168.1.20', `team.host.a${hex.slice(1)}`, 'jteam1_abc.def', 'jteam2_abc.def',
    `team.${'a'.repeat(30)}.${'b'.repeat(30)}.${'c'.repeat(30)}`];
  const longestEvent = `team.${'a'.repeat(30)}.${'b'.repeat(30)}.${'c'.repeat(29)}`;
  // Each of these fields is dropped and counted: its name or its value breaks the rule.
  const hostile = {
    [`a${hex.slice(1)}`]: 1, [`a${'b'.repeat(31)}`]: 1, jteam2_name: 1,
    invite_v2: `jteam2_${crypto.randomBytes(16).toString('base64url')}`, address_v1: 'jteamaddr1_abc',
    joined_eq: 'ip=192.168.1.20', joined_comma: '192.168.1.20,10.0.0.1', joined_colon: 'host:192.168.1.20',
    joined_v6: 'ip=fe80::abcd:ef01', hex_key: hex, b64url_key: b64url,
    plus_key: `${b64url.slice(0, 21)}+${b64url.slice(21)}=`,
    fingerprint: crypto.randomBytes(32).toString('hex').match(/../gu).join(':'),
    ipv4: '192.168.1.20', ipv6: 'fe80::abcd:ef01', dns: 'relay.example.net', version: '1.7.0',
    too_wide: `device_${'a'.repeat(33)}`,
  };
  stream.write(line({ seq: 0 }, longestEvent));
  for (const event of badEvents) stream.write(line({ seq: 1 }, event));
  stream.write(line({ ...hostile, ...real }));
  await settle();
  sink.end();
  const [longest, kept, closing] = lines();
  assert.equal(longest.event, longestEvent, 'an event of 96 characters is kept');
  assert.deepEqual(kept, { ...real, timestamp: TIMESTAMP, level: 'INFO', event: 'team.host.state', dropped_fields: Object.keys(hostile).length });
  assert.deepEqual([closing.kept, closing.dropped_lines, closing.dropped_fields], [2, badEvents.length, Object.keys(hostile).length]);
  const bytes = fs.readFileSync(file, 'utf8');
  const strings = Object.values(hostile).filter((value) => typeof value === 'string');
  for (const text of [...badEvents, ...Object.keys(hostile), ...strings]) assert.equal(bytes.includes(text), false, text);
});

for (const [label, make, skip] of [
  ['a link', (file, base) => { fs.writeFileSync(path.join(base, 'target.log'), ''); fs.symlinkSync(path.join(base, 'target.log'), file, 'file'); }, fileSymlinkSkip()],
  ['a directory', (file) => fs.mkdirSync(file), false],
  ['a file with two links', (file, base) => { fs.writeFileSync(file, ''); fs.linkSync(file, path.join(base, 'second.log')); }, false],
]) {
  test(`host.log as ${label} is refused: nothing written, one WARN team_host_log_file_invalid`, { skip }, async (t) => {
    const { base, file, says, open } = setup(t);
    make(file, base);
    const { stream, sink } = open();
    stream.write(line({ seq: 1 }));
    await settle();
    sink.end();
    assert.deepEqual(says, [['WARN', 'team.host.log_stopped', { reason: 'team_host_log_file_invalid' }]]);
    if (fs.lstatSync(file).isFile()) assert.equal(fs.readFileSync(file, 'utf8'), '');
  });
}

test('a stopped file still reads the stream to its end, so a child never stalls on its pipe', async (t) => {
  const total = 2_000;
  let produced = 0;
  const source = new Readable({ highWaterMark: 64, read() { produced += 1; this.push(produced <= total ? line({ seq: produced }) : null); } });
  const sink = createHostLogSink({ stream: source, logsDir: null });
  t.after(() => sink.end());
  assert.equal(await within(new Promise((resolve) => { source.once('end', resolve); }), 5_000), true, 'the source ended');
  assert.equal(sink.stats().dropped_pressure, total, 'every line counted, none parsed');
});

test('a stopped file or a full queue counts a line before it is parsed', async (t) => {
  const stopped = new PassThrough();
  const none = createHostLogSink({ stream: stopped, logsDir: null });
  t.after(() => none.end());
  stopped.write(`not json\n${line({ seq: 1 })}`);
  await settle();
  assert.deepEqual([none.stats().kept, none.stats().dropped_lines, none.stats().dropped_pressure], [0, 0, 2]);
  const { open } = setup(t);
  const { stream, sink } = open();
  stream.write(`${Array.from({ length: 2_000 }, (_unused, seq) => line({ seq })).join('')}${'x'.repeat(200)}\n`);
  await settle();
  const stats = sink.stats();
  assert.equal(stats.dropped_lines, 0, 'the non-JSON line met a full queue and was never parsed');
  assert.equal(stats.kept + stats.dropped_pressure, 2_001);
});

test('a write that makes no progress stops the file with a reason instead of looping', async (t) => {
  let writes = 0;
  const fsImpl = { ...fs, realpathSync: fs.realpathSync, writeSync: () => { writes += 1; if (writes > 1_000) throw new Error('looping'); return 0; } };
  const { open, says } = setup(t, { fsImpl });
  const { stream, sink } = open();
  stream.write(line({ seq: 1 }));
  await settle();
  sink.end();
  assert.equal(writes, 1);
  assert.deepEqual(says, [['WARN', 'team.host.log_stopped', { reason: 'team_host_log_write_stalled' }]]);
});

test('splitter edges: 4,096 bytes kept and 4,097 dropped, a long line or a character split across chunks, the last line, a late error', async (t) => {
  const { open, lines } = setup(t);
  const { stream, sink } = open();
  stream.write(sizedLine(MAX_LINE_BYTES, 1));
  stream.write(sizedLine(MAX_LINE_BYTES + 1, 2));
  const long = sizedLine(MAX_LINE_BYTES + 900, 3);
  stream.write(long.slice(0, 3_000));
  stream.write(long.slice(3_000));
  const accented = Buffer.from(line({ seq: 4, note: 'café' }), 'utf8');
  const cut = accented.indexOf(0xc3) + 1;
  stream.write(accented.subarray(0, cut));
  stream.write(accented.subarray(cut));
  stream.write(line({ seq: 5 }).slice(0, -1));
  await settle();
  sink.end();
  assert.doesNotThrow(() => stream.emit('error', new Error('late read error')));
  const entries = lines();
  assert.deepEqual(entries.map((entry) => entry.seq ?? entry.event), [1, 4, 'team.host_log.closed']);
  assert.equal(entries[1].dropped_fields, 1, 'the split character stayed in its one line (its field is not a plain word)');
  assert.equal(entries.at(-1).dropped_lines, 3, 'the 4,097-byte line, the split long line and the unterminated last line');
});

test('drain: lines written after the exit and before the stream ends are kept; a stream that never ends closes after a second', async (t) => {
  const { open, lines } = setup(t);
  const { stream, sink } = open();
  stream.write(line({ seq: 1 }));
  const closed = sink.drain();
  stream.write(line({ seq: 2 }));
  stream.end(line({ seq: 3 }));
  await closed;
  assert.deepEqual(lines().map((entry) => entry.seq ?? entry.event), [1, 2, 3, 'team.host_log.closed']);
  assert.equal(lines().at(-1).kept, 3);
  assert.equal(stream.listenerCount('data'), 0);
  const silent = open();
  const started = Date.now();
  assert.equal(await within(silent.sink.drain(), 3_000), true);
  assert.ok(Date.now() - started >= 900, `${Date.now() - started} ms`);
  assert.equal(silent.sink.resources().reading, false);
  assert.equal(lines().at(-1).event, 'team.host_log.closed');
});
