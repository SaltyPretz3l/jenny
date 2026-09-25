const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const util = require('node:util');

const {
  LOG_RETENTION,
  SECRET_SHAPE_RE,
  collapseRedactedPathTails,
  redactLogReportValue,
  redactLogText,
} = require('../renderer/shared/log-contract-utils');

test('log contract exposes the shared retention limits used by Logs V2', () => {
  assert.deepEqual(LOG_RETENTION, {
    mainStoreLimit: 400,
    rendererRetainedLimit: 500,
    rendererTrimThreshold: 550,
    diagnosticsCurrentRunLimit: 750,
    diagnosticsPriorRunLimit: 250,
    observabilityRecentLogLimit: 50,
  });
});

test('log report redaction removes sensitive keys, token-shaped text, and local paths', () => {
  const redacted = redactLogReportValue({
    authorization: 'Bearer secret-token-value',
    apiKey: 'sk-testsecret123456789',
    file: 'G:\\Users\\Jenny\\AppData\\Roaming\\jenny\\sessions.json',
    nested: {
      message: 'failed with token=abc123secret at C:\\Projects\\private\\notes.md',
    },
  });

  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('secret-token-value'), false);
  assert.equal(serialized.includes('sk-testsecret123456789'), false);
  assert.equal(serialized.includes('G:\\Users\\Jenny'), false);
  assert.equal(serialized.includes('C:\\Projects\\private'), false);
  assert.equal(redacted.authorization, '[redacted]');
  assert.equal(redacted.apiKey, '[redacted]');
  assert.match(redacted.file, /\[redacted:path\]/);
  assert.match(redacted.nested.message, /\[redacted\]/);
  assert.match(redacted.nested.message, /\[redacted:path\]/);
});

// F17: this module is the SINGLE require seam behind services/log-entry-normalizer.js,
// so it is the one vocabulary for main.js log(), client-log-forwarding,
// turn-diagnostic-dump AND the user-facing
// log-report copy. Before this slice the general path was materially weaker
// than the canonical turn-event sanitizer: these sentinel shapes survived
// straight into the artifact a user pastes into a bug report.
const SENTINEL_SECRETS = [
  ['github pat (ghp_)', 'ghp_ABCDEFGHIJKLMNOP0123'],
  ['github pat (gho_)', 'gho_ABCDEFGHIJKLMNOP0123'],
  ['github fine-grained pat', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'],
  ['huggingface token', 'hf_QwErTyUiOpAsDfGhJkLzXcVbNm1234567890'],
  // Joined at runtime: GitHub push protection blocks a contiguous Slack-token
  // literal in the public repo, and the redactor only sees the joined value.
  ['slack bot token', `xoxb-${'1234567890-0987654321-AbCdEfGhIjKlMnOpQr'}`],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
];

for (const [label, secret] of SENTINEL_SECRETS) {
  test(`redactLogText strips a ${label} planted in child output`, () => {
    const line = `codex stderr: auth failed using ${secret} (retrying)`;
    const redacted = redactLogText(line);
    assert.equal(redacted.includes(secret), false, `${label} survived redaction`);
    assert.match(redacted, /\[redacted(:token)?\]/);
    // Surrounding diagnostic context must survive — this is a log, not a hash.
    assert.match(redacted, /codex stderr/);
    assert.match(redacted, /retrying/);
  });
}

test('log report redaction strips sentinel secrets from nested details and arrays', () => {
  const redacted = redactLogReportValue({
    stderr_tail: [
      'GITHUB ghp_ABCDEFGHIJKLMNOP0123',
      { line: 'HF hf_QwErTyUiOpAsDfGhJkLzXcVbNm1234567890' },
    ],
    nested: { deeper: { note: 'AKIAIOSFODNN7EXAMPLE and xoxb-1234567890-abcdefghijkl' } },
  });
  const serialized = JSON.stringify(redacted);
  for (const [, secret] of SENTINEL_SECRETS.slice(0, 2)) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(serialized.includes('xoxb-1234567890'), false);
});

test('redactLogText redacts POSIX root paths but leaves route-shaped strings alone', () => {
  assert.match(redactLogText('crash reading /Users/example/notes.md'), /\[redacted:path\]/);
  assert.equal(redactLogText('crash reading /Users/example/notes.md').includes('example'), false);
  assert.match(redactLogText('failed at /home/ci/build/app.py'), /\[redacted:path\]/);
  assert.match(redactLogText('{"config":"/etc/passwd"}'), /\[redacted:path\]/);
  assert.match(redactLogText('opened (/var/log/jenny.log)'), /\[redacted:path\]/);

  // Root-anchored on purpose: an unanchored rule mangles ordinary prose and
  // route strings, which is why canonical-turn-event.js anchors it too.
  assert.equal(redactLogText('GET /api/users returned 200'), 'GET /api/users returned 200');
  assert.equal(redactLogText("app.get('/api/users')"), "app.get('/api/users')");
});

// Paths with spaces in folder and file names. Every path shape used to stop at
// the first whitespace, so 'model=/home/jane/My Models/x.gguf' became
// 'model=[redacted:path] Models/x.gguf' and leaked the names behind the space.
// llama.server.spawn logs binary/model/mmproj paths like these, Node spawn
// errors read 'spawn <path> ENOENT', and GGUF folders often carry spaces.
// Windows fixtures use String.raw so every backslash is literal.
const SPACED_PATH_CASES = [
  ['POSIX folder with a space, path at the end', 'model=/home/jane/My Models/x.gguf', 'model=[redacted:path]'],
  ['POSIX folder and file name with spaces, path at the end', 'mmproj /home/jane/My Models/mmproj Model F16.gguf', 'mmproj [redacted:path]'],
  ['POSIX GGUF folder whose last folder has a space', 'GGUF folder /Users/jane/AI Models/Local GGUF', 'GGUF folder [redacted:path]'],
  ['POSIX file name with spaces before ", retrying"', 'failed to load /home/jane/My Models/My Model Q4.gguf, retrying', 'failed to load [redacted:path], retrying'],
  ['POSIX path before a strerror clause', 'cannot open /home/jane/My Models/x.gguf: No such file or directory', 'cannot open [redacted:path]: No such file or directory'],
  ['POSIX extensionless binary before an error code', 'spawn /home/jane/AI Tools/llama b10683/llama-server ENOENT', 'spawn [redacted:path] ENOENT'],
  ['POSIX file name with spaces followed by prose', 'loaded /home/jane/My Models/My Model.gguf in 3.2 seconds', 'loaded [redacted:path] in 3.2 seconds'],
  ['POSIX pair of paths in one line', 'copy /home/jane/My Models/x.gguf to /tmp/Jenny Cache/x.gguf', 'copy [redacted:path] to [redacted:path]'],
  ['win32 spawn error before an error code', String.raw`spawn G:\AI Tools\llama b10683\llama-server.exe ENOENT`, 'spawn [redacted:path] ENOENT'],
  ['win32 folder and file name with spaces, path at the end', String.raw`model=G:\AI Tools\My Models\My Model Q4.gguf`, 'model=[redacted:path]'],
  ['win32 GGUF folder whose last folder has a space', String.raw`G:\AI Tools\GGUF Models`, '[redacted:path]'],
  ['win32 file name with spaces followed by prose', String.raw`G:\AI Tools\My Model.gguf could not be opened, retrying`, '[redacted:path] could not be opened, retrying'],
  ['win32 quoted folder mid-string', String.raw`open 'G:\AI Tools\GGUF Models' failed`, "open '[redacted:path]' failed"],
  ['win32 path inside JSON-escaped details', String.raw`{"model":"G:\\AI Tools\\My Model.gguf","port":8080}`, '{"model":"[redacted:path]","port":8080}'],
  ['win32 UNC share with spaces', String.raw`read \\nas\AI Share\My Models\model.gguf`, 'read [redacted:path]'],
  ['POSIX file name with an abbreviation period', 'open /Users/jane/Documents/Letter to Dr. Jones.docx', 'open [redacted:path]'],
  ['POSIX names with no-break and narrow no-break spaces', 'saved /Users/jane/Client\u00A0Files/Screenshot 2026-09-18 at 10.15.32\u202FAM.png', 'saved [redacted:path]'],
  ['win32 file name with a finance acronym', String.raw`C:\Users\jane\Finance\Q3 EBITDA Bridge.xlsx`, '[redacted:path]'],
  ['win32 file name with a dotted fiscal period', String.raw`C:\Users\jane\Finance\FY2024.Q3 Forecast.xlsx`, '[redacted:path]'],
  ['POSIX folder before a prose verb', 'workspace root /home/jane/proj does not exist', 'workspace root [redacted:path] does not exist'],
  ['POSIX extensionless binary before an exit report', 'spawn /home/jane/AI Tools/llama-server exited with code 3221225781', 'spawn [redacted:path] exited with code 3221225781'],
  ['POSIX blob path before command-line flags', '--model /home/jane/.ollama/models/blobs/sha256-6a0746a1ec1a --ctx-size 2048 --port 41234', '--model [redacted:path] --ctx-size 2048 --port 41234'],
  ['POSIX file name before a closing parenthesis', '(see /home/jane/My Models/x.gguf) for details', '(see [redacted:path] for details'],
  ['POSIX source location before a compiler error', '/home/jane/My Project/app.ts:10:5 - error TS2304: Cannot find name', '[redacted:path] - error TS2304: Cannot find name'],
  ['POSIX spaced path as a keyed value', 'token=/home/jane/My Secrets/key.pem', 'token=[redacted]'],
  ['POSIX folder before a sentence period', 'Workspace root set to /home/jane/proj. Indexing started.', 'Workspace root set to [redacted:path]. Indexing started.'],
  ['win32 file name with an abbreviation', String.raw`C:\Users\jane\Finance\Actual vs. Budget Q3.xlsx`, '[redacted:path]'],
  ['POSIX extensionless binary before a network error code', 'spawn /home/jane/AI Tools/llama-server ECONNREFUSED', 'spawn [redacted:path] ECONNREFUSED'],
  ['POSIX path before a DSN with a pipe in the password', 'loaded /home/jane/config.yaml using postgres://admin:hun|ter2@db/app', 'loaded [redacted:path] using [redacted:dsn]'],
  ['POSIX path before a URL with a pipe in the user', 'cwd /home/jane/app https://us|er:hunter2@host/x', 'cwd [redacted:path] [redacted:dsn]'],
  ['win32 spawn error before a clause with a slash', String.raw`spawn C:\AI Tools\llama-server.exe ENOENT and/or EACCES`, 'spawn [redacted:path] ENOENT and/or EACCES'],
  ['POSIX file name before a clause with a relative path', 'load /home/jane/My Models/a.gguf, retrying with models/b.gguf', 'load [redacted:path], retrying with models/b.gguf'],
  ['POSIX file name before a failure and a URL', 'open /home/jane/My Models/x.gguf failed, see https://example.com/help', 'open [redacted:path] failed, see https://example.com/help'],
  ['win32 pair of paths separated by one space', String.raw`copy C:\Users\jane\proj D:\Backup Drive\proj`, 'copy [redacted:path] [redacted:path]'],
  ['win32 HR file name with a comma before a capitalised name', String.raw`C:\Users\jane\HR\Smith, John - Offer.pdf`, '[redacted:path]'],
  ['win32 file name before a comma and a capitalised word', String.raw`copied C:\Users\jane\a.txt, And more`, 'copied [redacted:path], And more'],
  ['POSIX log file whose name holds a verb', '/home/jane/Logs/build failed.log', '[redacted:path]'],
  ['POSIX track whose name holds an error-code word', '/home/jane/Music/Track 01 UNKNOWN.mp3', '[redacted:path]'],
  ['UNC path before a delimited POSIX path with a backtick', String.raw`\\nas\share\My Docs ,/home/jane/Priv` + '`/x.txt', '[redacted:path] ,[redacted:path]'],
  ['win32 comma-joined pair of paths', String.raw`Loaded C:\Users\jane\Client Files\Acme Merger.docx,C:\Users\jane\b.txt`, 'Loaded [redacted:path]'],
  ['POSIX colon-joined search path', 'MODEL_PATH=/home/jane/My Models:/home/jane/Other Models', 'MODEL_PATH=[redacted:path]'],
  ['win32 pair of paths joined by "to"', String.raw`copy C:\a\x.txt to D:\b\y.txt`, 'copy [redacted:path] to [redacted:path]'],
  ['POSIX folder before a shell operator', 'exec: cd /home/jane/proj && npm test', 'exec: cd [redacted:path] && npm test'],
  ['POSIX binary before a redirect', 'exec: /home/jane/bin/server 2>&1', 'exec: [redacted:path] 2>&1'],
  ['win32 paths joined by an arrow', String.raw`Copied C:\a\b -> D:\c\d`, 'Copied [redacted:path] -> [redacted:path]'],
  ['POSIX path inside backticks', 'Ran `ls /home/jane/proj` and then `npm test`', 'Ran `ls [redacted:path] and then `npm test`'],
  ['POSIX C source file before prose', 'compiled /home/jane/proj/main.c in 3.2 seconds', 'compiled [redacted:path] in 3.2 seconds'],
  ['win32 path before EOF', String.raw`read C:\x\model EOF`, 'read [redacted:path] EOF'],
  ['win32 acronym folder before a sentence period', String.raw`Installed to C:\AI. Restart Jenny to apply.`, 'Installed to [redacted:path]. Restart Jenny to apply.'],
  ['win32 folder before ", Retrying"', String.raw`Could not open C:\Users\jane\config, Retrying in 5s`, 'Could not open [redacted:path], Retrying in 5s'],
  ['POSIX folder before a question mark', 'Is /home/jane/proj? retrying later', 'Is [redacted:path]? retrying later'],
  ['win32 folder before a closing parenthesis', String.raw`(see C:\Users\jane\notes) for details`, '(see [redacted:path] for details'],
  ['Ollama env map', 'env="map[OLLAMA_MODELS:/home/jane/.ollama/models OLLAMA_NOHISTORY:false OLLAMA_NUM_PARALLEL:0]"', 'env="map[OLLAMA_MODELS:[redacted:path] OLLAMA_NOHISTORY:false OLLAMA_NUM_PARALLEL:0]"'],
  ['Ollama logfmt fields', 'msg=loaded model=/home/jane/.ollama/models/blobs/sha256-6a07 ctx=4096 threads=8', 'msg=loaded model=[redacted:path] ctx=4096 threads=8'],
  ['POSIX file named like a key before a strerror clause', 'open /home/jane/.jenny/token: permission denied', 'open [redacted:path]: permission denied'],
  ['win32 file name before a strerror clause', String.raw`Cannot remove C:\Users\jane\Client Files\Acme Merger.docx: The process cannot access the file`, 'Cannot remove [redacted:path]: The process cannot access the file'],
  ['win32 source location in a spaced name', String.raw`C:\src\my module.ts:10:5 - error TS2345`, '[redacted:path] - error TS2345'],
  ['win32 file name in bold markdown', String.raw`Saved **C:\Users\jane\Reports\Q3 close.xlsx** and emailed Dana at 9:05.`, 'Saved **[redacted:path] and emailed Dana at 9:05.'],
  ['win32 rotated log file', String.raw`Rotated C:\Users\jane\AppData\Roaming\jenny\logs\shell.log.1 to archive`, 'Rotated [redacted:path] to archive'],
  ['POSIX file with a digit in its extension', '/home/jane/Voice Memos/memo 3.m4a uploaded', '[redacted:path] uploaded'],
  ['win32 file name in curly quotes', String.raw`Open ‘C:\Users\jane\My Docs\plan.docx’ now`, 'Open ‘[redacted:path] now'],
];

for (const [label, input, expected] of SPACED_PATH_CASES) {
  test(`redactLogText redacts the whole path: ${label}`, () => {
    assert.equal(redactLogText(input), expected);
  });
}

// Node reports libuv codes and os.constants.errno names (EDQUOT, EMULTIHOP and
// ESTALE exist off Windows only); Win32 and winsock logs use ERROR_* and WSA*.
test('redactLogText keeps every runtime error code after a spaced path', () => {
  const codes = new Set([
    ...[...util.getSystemErrorMap().values()].map(([name]) => name),
    ...Object.keys(os.constants.errno),
    'EDQUOT', 'EMULTIHOP', 'ESTALE', 'ERROR_FILE_NOT_FOUND', 'WSAECONNREFUSED',
  ]);
  for (const code of codes) {
    assert.equal(redactLogText(String.raw`open C:\AI Tools\model ${code}`), `open [redacted:path] ${code}`);
    assert.equal(redactLogText(`stat /home/jane/My Models/x ${code}`), `stat [redacted:path] ${code}`);
    assert.equal(collapseRedactedPathTails(String.raw`open [redacted:path]\AI Tools\model ${code}`), `open [redacted] ${code}`);
  }
});

test('log report redaction redacts spaced llama.server.spawn paths as whole values', () => {
  assert.deepEqual(redactLogReportValue({
    binary: String.raw`G:\AI Tools\llama b10683\llama-server.exe`,
    model: '/home/jane/My Models/My Model Q4.gguf',
    mmproj: String.raw`G:\AI Tools\My Models\mmproj Model F16.gguf`,
    port: 8080,
  }), {
    binary: '[redacted:path]',
    model: '[redacted:path]',
    mmproj: '[redacted:path]',
    port: 8080,
  });
});

// A final segment that crosses spaces must not absorb the key word a later rule
// needs: 'cwd /home/jane/proj token: hunter2' once became
// 'cwd [redacted:path]: hunter2', orphaning the value.
const KEYED_SECRETS_AFTER_PATHS = [
  ['cwd /home/jane/proj token: hunter2', 'hunter2'],
  [String.raw`workspace C:\Users\jane\proj password: hunter2`, 'hunter2'],
  ['/home/jane/app/client.py:88 DEBUG api_key: hunter2', 'hunter2'],
  ['GET /home/jane/app Cookie: sid=hunter2; csrftoken=abc', 'hunter2'],
  ['cwd /home/jane/proj secret\t= hunter2', 'hunter2'],
  ['cwd /home/jane/proj Bearer E3B0C44298FC1C149AFBF4C8996FB924', 'E3B0C44298FC1C149AFBF4C8996FB924'],
  ['cwd /home/jane/proj token:/home/jane/key|hunter2', 'hunter2'],
  [String.raw`cwd /home/jane/proj token: \\JANES-LAPTOP\ next`, 'JANES'],
  ['cwd /home/jane/proj X-Api-Key: hunter2', 'hunter2'],
  ['cwd /home/jane/proj password : hunter2', 'hunter2'],
  ['open /opt/x/token: password: hunter2', 'hunter2'],
  ['Bearer /home/jane/Priv,Folder/file.txt', 'Folder/file.txt'],
];

test('redactLogText still redacts keyed secrets that follow a path', () => {
  for (const [line, secret] of KEYED_SECRETS_AFTER_PATHS) {
    const redacted = redactLogText(line);
    assert.equal(redacted.includes(secret), false, `${JSON.stringify(line)} -> ${JSON.stringify(redacted)}`);
    assert.match(redacted, /\[redacted:path\]/);
  }
});

// A keyed value that holds a path or a data URI hides all of it: key rules
// that ran before the path shapes stopped at the first comma or semicolon.
test('redactLogText hides the whole keyed value when it holds a path or a data URI', () => {
  for (const [line, fragment] of [
    ['cookie=/home/jane/Priv,Folder/file.txt', 'Folder/file.txt'],
    ['dsn=sqlite:///C:/Users/jane/Clients,Acme/app.db', 'Acme'],
    [`password: data:image/png;base64,${'Q'.repeat(70)}`, 'Q'.repeat(64)],
    [`cookie=data:image/png;base64,${'Q'.repeat(70)}`, 'Q'.repeat(64)],
    ['password: /tmp/key,|hunter2', 'hunter2'],
    // A value run crosses a pipe after a path but never into the next key.
    [String.raw`password=C:\a b|dsn: hunter2`, 'hunter2'],
    [String.raw`password=C:\Users\jane\My Keys\k.pem|token: hunter2`, 'hunter2'],
    ['token: /home/jane/My Keys/k.pem|password: hunter2', 'hunter2'],
    [String.raw`password=C:\a b|postgres://u:p,w@h/db`, 'w@h'],
    [String.raw`password=x:C:\a b|api_key: hunter2`, 'hunter2'],
    ['dsn=a=/tmp/x, Priv.txt|token: hunter2', 'hunter2'],
    // A POSIX path runs on through another path's redaction and a backtick,
    // but stops where a key starts.
    [String.raw`/home/C:\a b` + '`cookie=a|sekrit', 'sekrit'],
    [String.raw`PATH=/home/jane/bin;C:\Program Files\Git` + '`token=a|sekrit', 'sekrit'],
    [String.raw`/home/C:\a b` + '`-token=a|sekrit', 'sekrit'],
    // A path never crosses into a word that holds a URL, even after a separator.
    [String.raw`open C:\a b\https://u:p|w@h`, 'w@h'],
    [String.raw`open /home/jane/a (2)\postgres://u:pw|sekrit@h/db`, 'sekrit'],
    // A keyed value takes a path's tail but not the key glued after it.
    ['password=/home/jane/My Keys`token: hunter2', 'hunter2'],
    ['cookie = /opt/My Dir/x`,secret: hunter2', 'hunter2'],
    // A keyed value leaves a URL the DSN rules hide to them and takes any other.
    ['token:/home/x`https://u:pa,ss@h', 'ss@h'],
    ['password=/tmp/a`mysql://u:p{sekrit}@h/db', 'sekrit'],
    ['cookie=/home/x`postgres://u:pw@h/db;sekrit', 'sekrit'],
    ['/opt/PrivL.md`PrivA.postgres://u:pw@h/db', 'PrivA'],
    [String.raw`token=C:\x` + '`PrivT-https://u:pw@h', 'PrivT'],
    [String.raw`token: C:\Users\jane\cfg\a.txt|https://files.example.com/q3.xlsx?X-Amz-Signature=5f3c9a1b`, '5f3c9a1b'],
    // A value may start with a key word.
    ['password=Secret:Winter2026', 'Secret'],
  ]) {
    const redacted = redactLogText(line);
    assert.equal(redacted.includes(fragment), false, `${JSON.stringify(line)} -> ${JSON.stringify(redacted)}`);
  }
});

// HEAD's path shapes ran on through an earlier redaction up to whitespace, so
// a POSIX list holding a drive path hid the name after that path's backtick.
test('redactLogText lets a path run on through an earlier path redaction', () => {
  const tick = '`';
  assert.equal(redactLogText(String.raw`cwd=/home/jane/a;C:\b.md${tick}\PrivD.gguf done`), 'cwd=[redacted:path] done');
  assert.equal(redactLogText(String.raw`cwd=/home/jane/a;\\nas\b.md${tick}\PrivD.gguf done`), 'cwd=[redacted:path] done');
  assert.equal(
    redactLogText(String.raw`copy D:\mirror\C:\Users\example\proj\Priv b.txt`, { prefixes: [String.raw`C:\Users\example\proj`] }),
    'copy [redacted:path]',
  );
});

test('redactLogText takes a known-prefix tail with spaces into a keyed value', () => {
  const prefixes = [String.raw`C:\Users\example\proj`];
  for (const [line, expected] of [
    [String.raw`read token: C:\Users\example\proj\My Keys\key.pem`, 'read token: [redacted]'],
    [String.raw`--api-key=C:\Users\example\proj\My Keys\key.pem ENOENT`, '--api-key=[redacted] ENOENT'],
    [String.raw`cookie=C:\Users\example\proj\My Keys\jar.txt`, 'cookie=[redacted]'],
    [String.raw`api_key:C:\Users\example\proj\a,Authorization: Bearer PrivA`, 'api_key:[redacted],Authorization: [redacted]'],
    [String.raw`password=C:\Users\example\proj\a b\|dsn: hunter2`, String.raw`password=[redacted] b\|dsn: [redacted]`],
    [String.raw`Could not read token: C:\Users\example\proj\My Keys\key.pem.`, 'Could not read token: [redacted].'],
    [String.raw`read token: C:\Users\example\proj\My Keys\key.pem: permission denied`, 'read token: [redacted]: permission denied'],
    [String.raw`cookie=C:\Users\example\proj\Browser Data\cookies.sqlite.`, 'cookie=[redacted].'],
    [String.raw`--api-key=C:\Users\example\proj\http://x\key.gguf exited with code 1`, '--api-key=[redacted] exited with code 1'],
    [String.raw`password=C:\Users\example\proj\http://x\key\ERR_X|x`, 'password=[redacted]'],
  ]) {
    assert.equal(redactLogText(line, { prefixes }), expected);
  }
});

// A keyed value whose tail ended in a period once failed its end check and
// tried 2^k crossing paths (3.3 s here); the end check now allows the period
// and every zero-width choice in a path body is exclusive.
test('redactLogText keeps keyed path values linear when the tail ends in a period', () => {
  for (const [key, word] of [['password=', 'A.'], ['cookie=', 'Dr.']]) {
    const line = `${key}[redacted:path]\\${Array(26).fill(word).join(' ')}`;
    const started = process.hrtime.bigint();
    redactLogText(line);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `${key} took ${elapsedMs.toFixed(0)} ms`);
  }
});

// Each crossing once rescanned the rest of the word from every glued token
// (8 s for 256k characters); a scan now stops at the next token.
test('redactLogText stays linear on a word of glued path redactions', () => {
  const tokens = '[redacted:path]'.repeat(12000);
  for (const run of [
    () => redactLogText(String.raw`C:\a x${tokens}`),
    () => redactLogText(String.raw`token: [redacted:path]\a x${tokens}|`),
    () => collapseRedactedPathTails(String.raw`[redacted:path]\a x${tokens}`),
  ]) {
    const started = process.hrtime.bigint();
    run();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `took ${elapsedMs.toFixed(0)} ms`);
  }
});

test('redactLogText leaves ordinary sentences with spaces and no path alone', () => {
  for (const sentence of [
    'The model failed to load, retrying in 5 seconds.',
    'spawn llama-server ENOENT',
    'GET /api/users returned 200 in 12 ms',
    'Copied 3 files and/or folders at 54 tok/s',
    'Keep models on the C: drive or the D: drive',
  ]) {
    assert.equal(redactLogText(sentence), sentence);
  }
});

// Words after an extensionless final segment that cannot be told apart from
// the name stay inside the redaction: a folder may really be called
// 'Local GGUF for models', and over-redacting a log line beats leaking a path.
test('redactLogText errs toward redaction when prose after a path cannot be told apart', () => {
  assert.equal(
    redactLogText('scanning /home/jane/AI Models/Local GGUF for models'),
    'scanning [redacted:path]'
  );
});

// Known-prefix redaction keeps the relative tail ("[redacted:path]\AI Tools\x");
// surfaces that must hide the whole path collapse the token and its tail, and
// the tail follows the same space rules as any other path.
test('collapseRedactedPathTails collapses a prefix redaction and its spaced tail', () => {
  const cases = [
    [String.raw`failed at [redacted:path]\AI Tools\My Models\model.gguf ENOENT`, 'failed at [redacted] ENOENT'],
    ['[redacted:path]/My Models/My Model Q4.gguf, retrying', '[redacted], retrying'],
    [String.raw`folder [redacted:path]\GGUF Models\Local GGUF`, 'folder [redacted]'],
    ['failed under [redacted:path] with bearer', 'failed under [redacted] with bearer'],
    [String.raw`{"path":"[redacted:path]\\AI Tools\\model.gguf"}`, '{"path":"[redacted]"}'],
    [String.raw`spawn [redacted:path]\AI Tools\llama-server.exe ENOENT and/or EACCES`, 'spawn [redacted] ENOENT and/or EACCES'],
    [String.raw`load [redacted:path]\My Models\a.gguf, retrying with models/b.gguf`, 'load [redacted], retrying with models/b.gguf'],
    // A prefix that ends in a separator (a drive root) or inside a name.
    [String.raw`open [redacted:path]Projects\My Secret Plans\budget.xlsx ENOENT`, 'open [redacted] ENOENT'],
    [String.raw`copy to [redacted:path]-backup\Secret Folder\file.txt failed`, 'copy to [redacted] failed'],
    ['(see [redacted:path]) for details', '(see [redacted]) for details'],
    [String.raw`copied [redacted:path]\a.txt, And [redacted:path]\b.txt`, 'copied [redacted], And [redacted]'],
    [String.raw`[redacted:path]\Smith, John[redacted:path]\y`, '[redacted]'],
    // Joined path lists merge; paths separated by a word stay apart.
    [String.raw`Loaded [redacted:path]\Client Files\Acme Merger.docx,[redacted:path]\b.txt`, 'Loaded [redacted]'],
    [String.raw`Model search paths: [redacted:path]\My Models;[redacted:path]\More`, 'Model search paths: [redacted]'],
    [String.raw`copy [redacted:path]\x.txt to [redacted:path]\y.txt`, 'copy [redacted] to [redacted]'],
    ['Is [redacted:path]? retrying later', 'Is [redacted]? retrying later'],
    ['{cwd:[redacted:path]} failed', '{cwd:[redacted]} failed'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(collapseRedactedPathTails(input, '[redacted]'), expected);
  }
  assert.equal(collapseRedactedPathTails(String.raw`[redacted:path]\x`), '[redacted]');
  assert.equal(collapseRedactedPathTails(String.raw`[redacted:path]\x`, '$&'), '$&');
});

test('redactLogText collapses base64 data URIs instead of copying them into the report', () => {
  const payload = `data:image/png;base64,${'A'.repeat(400)}`;
  const redacted = redactLogText(`attachment ${payload}`);
  assert.equal(redacted.includes('A'.repeat(64)), false);
  assert.match(redacted, /data:image\/png;base64,\[redacted:data-uri\]/);
});

test('SECRET_SHAPE_RE is a strict superset of the vocabularies it replaced', () => {
  // The retired diagnostic reviewer used to carry its own TOKEN_PATTERN with the
  // underscore-prefixed forms; dropping it must not weaken anything.
  for (const secret of ['sk_testsecret123456', 'pk_livesecret123456', 'tok_abcdefgh1234']) {
    SECRET_SHAPE_RE.lastIndex = 0;
    assert.equal(SECRET_SHAPE_RE.test(secret), true, `${secret} must still match`);
    assert.equal(redactLogText(`value ${secret}`).includes(secret), false);
  }
});

test('log report redaction handles circular values without throwing', () => {
  const circular = { token: 'secret-token-value' };
  circular.self = circular;

  const redacted = redactLogReportValue(circular);

  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.self, '[redacted:circular]');
});
