'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AttachmentAssetStore } = require('../../services/attachment-asset-store');
const {
  SessionAttachmentAuthority,
} = require('../../services/projects/session-attachment-authority');
const {
  createSessionWithImageAdmission,
} = require('../../services/backend/managed-sidecar-attachments');

function fixture(t, { maxReceipts = 4096 } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-attachment-authority-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const attachmentAssetStore = new AttachmentAssetStore({ rootDir, nativeImage: null });
  const sessions = new Map();
  const sessionStore = {
    peekSession(sessionId) {
      return sessions.get(sessionId) || null;
    },
  };
  const authority = new SessionAttachmentAuthority({
    sessionStore,
    attachmentAssetStore,
    maxReceipts,
  });
  const image = (name) => attachmentAssetStore.saveImageBufferSync(
    Buffer.from(`image-${name}`),
    { displayName: `${name}.png`, mimeType: 'image/png', sourceKind: 'file' }
  );
  const session = (id, overrides = {}) => {
    const record = {
      id,
      project_id: 'project-a',
      session_incarnation: `inc-${id}`,
      messages: [],
      ...overrides,
    };
    sessions.set(id, record);
    return record;
  };
  return { authority, attachmentAssetStore, image, session, sessions };
}

test('existing-session import receipts authorize only their exact id, path, and session', (t) => {
  const { authority, image, session } = fixture(t);
  session('session-a');
  session('session-b');
  const imported = image('owned');
  authority.registerImportedImages(authority.captureImportScope('session-a'), [imported]);

  assert.equal(authority.authorizeManagedSend([imported], {
    requestedSessionId: 'session-a',
    resolvedSessionId: 'session-a',
  }).count, 1);
  assert.throws(() => authority.authorizeManagedSend([imported], {
    requestedSessionId: 'session-b',
    resolvedSessionId: 'session-b',
  }), /not authorized/);
  assert.throws(() => authority.authorizeManagedSend([{
    ...imported,
    id: 'forged-id',
  }], {
    requestedSessionId: 'session-a',
    resolvedSessionId: 'session-a',
  }), /not authorized/);
});

test('a managed profile image without a receipt or canonical reference is refused', (t) => {
  const { authority, image, session } = fixture(t);
  session('session-a');
  const arbitraryManagedImage = image('arbitrary');

  assert.throws(() => authority.authorizeManagedSend([arbitraryManagedImage], {
    requestedSessionId: 'session-a',
    resolvedSessionId: 'session-a',
  }), /not authorized/);
});

test('canonical historical image membership survives project root changes', (t) => {
  const { authority, image, session } = fixture(t);
  const historical = image('historical');
  session('session-a', {
    project_id: 'project-moved',
    messages: [{ role: 'user', attachments: [historical] }],
  });

  assert.equal(authority.authorizeManagedSend([historical], {
    requestedSessionId: 'session-a',
    resolvedSessionId: 'session-a',
  }).count, 1);
});

test('unbound draft receipt retries a failed create then binds once', (t) => {
  const { authority, image, session } = fixture(t);
  const imported = image('new-draft');
  authority.registerImportedImages(authority.captureImportScope(), [imported]);

  const failedClaim = authority.authorizeManagedSend([imported], {
    requestedSessionId: '',
    resolvedSessionId: 'failed-create',
  });
  failedClaim.release();
  const retryClaim = authority.authorizeManagedSend([imported], {
    requestedSessionId: '',
    resolvedSessionId: 'retry-create',
  });
  const created = session('retry-create');
  retryClaim.finalizeCreatedSession(created);

  assert.equal(authority.authorizeManagedSend([imported], {
    requestedSessionId: 'retry-create',
    resolvedSessionId: 'retry-create',
  }).count, 1);
  assert.throws(() => authority.authorizeManagedSend([imported], {
    requestedSessionId: '',
    resolvedSessionId: 'different-new-session',
  }), /not authorized/);
});

test('registration refuses the whole batch at capacity without evicting receipts', (t) => {
  const { authority, image, session } = fixture(t, { maxReceipts: 2 });
  session('session-a');
  const first = image('first');
  const second = image('second');
  const refused = image('refused');
  const scope = authority.captureImportScope('session-a');
  authority.registerImportedImages(scope, [first, second]);

  assert.throws(
    () => authority.registerImportedImages(scope, [refused]),
    /capacity is full/
  );
  assert.equal(authority.authorizeManagedSend([first, second], {
    requestedSessionId: 'session-a',
    resolvedSessionId: 'session-a',
  }).count, 2);
  assert.throws(() => authority.authorizeManagedSend([refused], {
    requestedSessionId: 'session-a',
    resolvedSessionId: 'session-a',
  }), /not authorized/);
});

test('an import scope cannot publish after its canonical session is replaced', (t) => {
  const { authority, image, session } = fixture(t);
  session('session-a');
  const scope = authority.captureImportScope('session-a');
  session('session-a', { session_incarnation: 'replacement-incarnation' });

  assert.throws(
    () => authority.registerImportedImages(scope, [image('late')]),
    /changed before the import completed/
  );
});

test('an import scope cannot be replayed against another authority owner', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  first.session('session-a');
  second.session('session-a');
  const scope = first.authority.captureImportScope('session-a');

  assert.throws(
    () => second.authority.registerImportedImages(scope, [second.image('cross-owner')]),
    /scope is invalid/
  );
});

test('receipt settlement uses session summaries without hydrating transcript records', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-attachment-summary-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const attachmentAssetStore = new AttachmentAssetStore({ rootDir, nativeImage: null });
  const summary = {
    id: 'session-a',
    project_id: 'project-a',
    created_at: '2026-09-09T00:00:00.000Z',
  };
  let transcriptReads = 0;
  const authority = new SessionAttachmentAuthority({
    attachmentAssetStore,
    sessionStore: {
      getSessionSummary(sessionId) {
        return sessionId === summary.id ? summary : null;
      },
      peekSession() {
        transcriptReads += 1;
        return { ...summary, messages: [] };
      },
    },
  });
  const imported = attachmentAssetStore.saveImageBufferSync(Buffer.from('image'), {
    displayName: 'image.png',
    mimeType: 'image/png',
  });

  authority.registerImportedImages(authority.captureImportScope('session-a'), [imported]);
  authority.registerImportedImages(authority.captureImportScope('session-a'), [imported]);
  assert.equal(transcriptReads, 0);
});

test('fresh receipts verify exact bytes and current project authority without reading history', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-attachment-fresh-receipt-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const attachmentAssetStore = new AttachmentAssetStore({ rootDir, nativeImage: null });
  const summary = {
    id: 'session-a', project_id: 'project-a', created_at: '2026-09-09T00:00:00.000Z',
  };
  let rootRevision = 1;
  let transcriptReads = 0;
  const authority = new SessionAttachmentAuthority({
    attachmentAssetStore,
    sessionStore: {
      getSessionSummary: () => summary,
      peekSession() {
        transcriptReads += 1;
        return { ...summary, messages: [] };
      },
    },
    projectAuthority: {
      captureSession: () => ({
        project_id: 'project-a', root_id: 'root-a', root_revision: rootRevision,
        device_id: '10', inode: '20',
      }),
    },
  });
  const imported = attachmentAssetStore.saveImageBufferSync(Buffer.from('original-image'), {
    displayName: 'image.png', mimeType: 'image/png',
  });
  authority.registerImportedImages(authority.captureImportScope('session-a'), [imported]);

  assert.equal(authority.authorizeManagedSend([imported], {
    requestedSessionId: 'session-a', resolvedSessionId: 'session-a',
  }).count, 1);
  assert.equal(transcriptReads, 0);

  fs.writeFileSync(imported.assetPath, Buffer.from('changed-image'));
  assert.throws(() => authority.authorizeManagedSend([imported], {
    requestedSessionId: 'session-a', resolvedSessionId: 'session-a',
  }), /not authorized/);
  assert.equal(transcriptReads, 0);

  const rootBound = attachmentAssetStore.saveImageBufferSync(Buffer.from('root-bound'), {
    displayName: 'root-bound.png', mimeType: 'image/png',
  });
  authority.registerImportedImages(authority.captureImportScope('session-a'), [rootBound]);
  rootRevision = 2;
  assert.throws(() => authority.authorizeManagedSend([rootBound], {
    requestedSessionId: 'session-a', resolvedSessionId: 'session-a',
  }), /not authorized/);
  assert.equal(transcriptReads, 0);
});

test('receipt-free historical image reuse falls back to canonical session history', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-attachment-history-fallback-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const attachmentAssetStore = new AttachmentAssetStore({ rootDir, nativeImage: null });
  const historical = attachmentAssetStore.saveImageBufferSync(Buffer.from('historical'), {
    displayName: 'historical.png', mimeType: 'image/png',
  });
  const summary = {
    id: 'session-a', project_id: 'project-a', created_at: '2026-09-09T00:00:00.000Z',
  };
  let transcriptReads = 0;
  const authority = new SessionAttachmentAuthority({
    attachmentAssetStore,
    sessionStore: {
      getSessionSummary: () => summary,
      peekSession() {
        transcriptReads += 1;
        return { ...summary, messages: [{ role: 'user', attachments: [historical] }] };
      },
    },
  });

  assert.equal(authority.authorizeManagedSend([historical], {
    requestedSessionId: 'session-a', resolvedSessionId: 'session-a',
  }).count, 1);
  assert.equal(transcriptReads, 1);
});

test('a throwing partial session create releases the reserved alias for retry', (t) => {
  const { authority, image, session, sessions } = fixture(t);
  const imported = image('partial-create');
  authority.registerImportedImages(authority.captureImportScope(), [imported]);
  const claim = authority.authorizeManagedSend([imported], {
    resolvedSessionId: 'partial-session',
  });

  assert.throws(() => createSessionWithImageAdmission(claim, () => {
    session('partial-session');
    throw new Error('write failed after mutation');
  }), /write failed/);
  sessions.delete('partial-session');
  const retry = authority.authorizeManagedSend([imported], {
    resolvedSessionId: 'retry-session',
  });
  assert.equal(retry.count, 1);
  retry.release();
});

test('finalization rejects a replacement and canonical persistence retires exact receipts', (t) => {
  const { authority, image, session, sessions } = fixture(t, { maxReceipts: 1 });
  const imported = image('bind-once');
  authority.registerImportedImages(authority.captureImportScope(), [imported]);
  const replacedClaim = authority.authorizeManagedSend([imported], {
    resolvedSessionId: 'replaced-session',
  });
  const original = session('replaced-session');
  session('replaced-session', { session_incarnation: 'replacement' });
  assert.throws(
    () => replacedClaim.finalizeCreatedSession(original),
    /binding could not be finalized/
  );
  sessions.delete('replaced-session');

  const claim = authority.authorizeManagedSend([imported], {
    resolvedSessionId: 'committed-session',
  });
  const committed = session('committed-session');
  claim.finalizeCreatedSession(committed);
  committed.messages.push({ role: 'user', attachments: [imported] });
  assert.equal(authority.noteCanonicalAttachmentsPersisted('committed-session'), 1);
  assert.equal(authority.registerImportedImages(
    authority.captureImportScope('committed-session'),
    [image('capacity-reused')]
  ), 1);
});
