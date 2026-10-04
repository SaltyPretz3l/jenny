const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SESSION_TITLE_MAX_LENGTH,
  deriveSessionTitleFromMessage,
  resolveDefaultTitle,
} = require('../renderer/shared/string-utils');
const { deriveTitleFromFirstMessage } = require('../renderer/shell/renderer-session-autotitle');
const { prepareManagedSession } = require('../services/backend/managed-sidecar-session-preflight');

// One default-title rule for the tab rail, the sidebar and the backend
// preflight (shell-chrome area 2, T1): the first user message, a leading
// greeting dropped, clipped at a word boundary to 48 characters.

test('a leading greeting is dropped before the title is clipped', () => {
  assert.equal(deriveSessionTitleFromMessage("Hi Jenny. I'm the owner of the G1 gate"), "I'm the owner of the G1 gate");
  assert.equal(deriveSessionTitleFromMessage('Hi Jenny, can you check the rail?'), 'can you check the rail?');
  assert.equal(deriveSessionTitleFromMessage('hello! Fix the flaky rail test'), 'Fix the flaky rail test');
  assert.equal(deriveSessionTitleFromMessage('Hey, quick one about tabs'), 'quick one about tabs');
  assert.equal(deriveSessionTitleFromMessage('Hi Jenny —  plan the next wave'), 'plan the next wave');
  assert.equal(deriveSessionTitleFromMessage('Hi, Jenny! Can you fix my build'), 'Can you fix my build', 'comma-first greeting drops the name too');
  assert.equal(deriveSessionTitleFromMessage('hey , jenny: tabs again'), 'tabs again');
});

test('only a punctuated greeting is a greeting', () => {
  assert.equal(deriveSessionTitleFromMessage('Hey there friend'), 'Hey there friend');
  assert.equal(deriveSessionTitleFromMessage('Highlights of the week'), 'Highlights of the week');
  assert.equal(deriveSessionTitleFromMessage('Hello-world program in Rust'), 'Hello-world program in Rust');
  assert.equal(deriveSessionTitleFromMessage('Hello, world program in Rust'), 'Hello, world program in Rust', '"Hello, world" is a phrase, not a greeting');
  assert.equal(deriveSessionTitleFromMessage('Hi Jenny.'), 'Hi Jenny.', 'a greeting-only message keeps its text');
});

test('greetings in the other UI locales are dropped too, with the name and closing punctuation', () => {
  const cases = [
    ['¡Hola, Jenny! ¿Puedes revisar el build?', '¿Puedes revisar el build?'], // es
    ['Salut ! Corrige le test du rail', 'Corrige le test du rail'], // fr
    ['Hallo Jenny, bitte den Build prüfen', 'bitte den Build prüfen'], // de
    ['Ciao Jenny. Sistema la barra laterale', 'Sistema la barra laterale'], // it
    ['Olá! Revise o teste', 'Revise o teste'], // pt-BR
    ['Cześć, popraw proszę test', 'popraw proszę test'], // pl
    ['ПРИВЕТ, Дженни! Почини сборку', 'Почини сборку'], // ru, upper case
    ['Merhaba Jenny, testi düzelt', 'testi düzelt'], // tr
    ['مرحبا جيني، ساعدني في الكود', 'ساعدني في الكود'], // ar (RTL, Arabic comma)
    ['नमस्ते जेनी। बिल्ड ठीक करो', 'बिल्ड ठीक करो'], // hi (danda)
    ['Xin chào, sửa giúp tôi bài kiểm tra', 'sửa giúp tôi bài kiểm tra'], // vi
    ['こんにちは、ジェニー！ビルドを直して', 'ビルドを直して'], // ja (full-width)
    ['안녕하세요, 제니! 빌드 좀 고쳐줘', '빌드 좀 고쳐줘'], // ko
    ['你好，帮我看看这个错误', '帮我看看这个错误'], // zh-CN
    ['嗨，珍妮！幫我修一下測試', '幫我修一下測試'], // zh-TW
  ];
  for (const [message, expected] of cases) {
    assert.equal(deriveSessionTitleFromMessage(message), expected, message);
  }
});

test('non-English greetings still need closing punctuation and keep a greeting-only message', () => {
  assert.equal(deriveSessionTitleFromMessage('Hola mundo en Rust'), 'Hola mundo en Rust');
  assert.equal(deriveSessionTitleFromMessage('Ciaone a tutti'), 'Ciaone a tutti');
  assert.equal(deriveSessionTitleFromMessage('你好！'), '你好！');
});

test('titles clip at a word boundary within the 48-character budget', () => {
  assert.equal(SESSION_TITLE_MAX_LENGTH, 48);
  const title = deriveSessionTitleFromMessage('Hi Jenny. Refactor the renderer stream handler to support resumable sessions');
  assert.equal(title, 'Refactor the renderer stream handler to support...');
  assert.ok(title.length <= SESSION_TITLE_MAX_LENGTH + 3);
  assert.equal(deriveSessionTitleFromMessage('x'.repeat(60)), `${'x'.repeat(48)}...`);
  assert.equal(deriveSessionTitleFromMessage('/plan  /compact   Ship the tab rail'), 'Ship the tab rail');
  assert.equal(deriveSessionTitleFromMessage('   '), '');
});

const SHARED_FIXTURE = [
  "Hi Jenny. I'm the owner and I need the G1 closeout checklist reviewed today",
  'Hello, what changed in the tab rail spec since yesterday?',
  'Hey! Quick one',
  'Fix the flaky sidebar resize test on Windows runners please',
  '/plan Build the eviction toast for the ninth tab',
  'Hi Jenny.',
  'x'.repeat(70),
];

function backendCandidate(prompt, normalizedInteractiveResponse) {
  const service = {
    sessionStore: {
      getSessionSummary: (id) => ({ id, title: 'New Chat', message_count: 0, created_at: '2026-09-29T10:00:00Z' }),
    },
  };
  return prepareManagedSession(service, {
    sessionId: 'session-title-fixture', prompt, attachments: [], normalizedInteractiveResponse,
  }).automaticTitleCandidate;
}

test('the renderer auto-title and the backend preflight derive identical titles', () => {
  for (const prompt of SHARED_FIXTURE) {
    const shared = deriveSessionTitleFromMessage(prompt);
    assert.equal(deriveTitleFromFirstMessage(prompt), shared, `renderer: ${prompt}`);
    assert.equal(backendCandidate(prompt), shared, `backend: ${prompt}`);
  }
});

test('the backend preflight never titles a chat from an interactive answer or an empty prompt', () => {
  assert.equal(backendCandidate('Interactive answer chip', { disposition: 'answered' }), '');
  assert.equal(backendCandidate('   '), '');
});

test('a stored default title becomes its display label; a real title is kept as stored', () => {
  assert.equal(resolveDefaultTitle(''), 'New Chat');
  assert.equal(resolveDefaultTitle('  New Chat '), 'New Chat');
  assert.equal(resolveDefaultTitle(null), 'New Chat');
  assert.equal(resolveDefaultTitle('New Plugin Session'), 'New Plugin Session');
  assert.equal(resolveDefaultTitle('Ship the rail'), 'Ship the rail');
});
