'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { BrowserApp } = require('../../renderer/browser/app');
const view = require('../../renderer/browser/browser-view');
const { RECEIPT_OPERATIONS } = require('../../renderer/browser/browser-mutation-recovery');

const AUTHORITY_KEY = `authority_${'a'.repeat(64)}`;

function state() {
  return {
    authenticated: true,
    connectionState: 'connected',
    sessions: [{ session_id: 'session_a', title: 'Browser chat', project_id: 'project_general' }],
    selectedSessionId: 'session_a',
    snapshot: {
      session: {
        session_id: 'session_a', title: 'Browser chat', revision: 'boot:2',
        project_id: 'project_general', plan_mode: false,
      },
      messages: [], pending_approvals: [], pending_questions: [],
    },
    liveProjection: null,
    activeStreamId: '',
    planMode: false,
    draft: '',
    control: { owned: true, ownerClientId: 'client_a', generation: 4 },
    attachments: [],
    authSessions: [],
    authSessionsOpen: false,
    mutationPending: false,
    mutationChecking: false,
    projects: [],
    projectsOpen: false,
    projectsBusy: false,
    projectsError: '',
    projectStorage: null,
    permissionReview: null,
  };
}

function clickTarget(element) {
  return { target: { closest: () => element } };
}

test('browser project controls use scoped commands for roots, assignment, and imported grants', async (t) => {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  t.after(() => {
    delete global.window;
    delete global.document;
    instance.window.close();
  });
  const calls = [];
  const projects = [
    {
      id: 'project_general', name: 'General', root_path: null, root_revision: 0,
      authority_key: `authority_${'b'.repeat(64)}`,
    },
    {
      id: 'project_alpha', name: '<Alpha>', root_path: '/workspace/alpha', root_revision: 3,
      authority_key: AUTHORITY_KEY,
    },
  ];
  let pending = [
    {
      id: 'review_auto', tool_name: '<script>bad()</script>', path_prefix: '/workspace/alpha',
      original_record: {
        match: { tool_id: '<script>bad()</script>', path_prefix: '/workspace/alpha', action: 'create' },
        restrictions: { modes: ['write', '<unsafe>'] },
      },
    },
    { id: 'review_discard', tool_name: 'write_file', path_prefix: '/workspace/old' },
  ];
  const bridge = {
    clientId: 'client_a',
    command: async (operation, options) => {
      calls.push({ operation, options });
      if (operation === 'projects.list') {
        return { ok: true, projects, storage: { read_only: false, reason: null } };
      }
      if (operation === 'permissionReview.getState') {
        return { ok: true, pending_count: pending.length, pending, history: [], read_only: false };
      }
      if (operation === 'projects.assignSession') {
        return {
          ok: true,
          session: { session_id: 'session_a', title: 'Browser chat', project_id: options.params.project_id },
          revision: 'boot:3',
        };
      }
      if (operation === 'permissionReview.resolve') {
        pending = pending.filter((item) => item.id !== options.params.review_id);
        return {
          ok: true, resolved: true,
          review_id: options.params.review_id, decision: options.params.decision,
        };
      }
      return { ok: true, project: projects[1] };
    },
  };
  const root = instance.window.document.getElementById('root');
  const app = new BrowserApp({ root, bridge, state: state(), view });
  t.after(() => app.dispose());

  await app._handleClick(clickTarget(root.querySelector('[data-action="projects-toggle"]')));
  assert.equal(root.querySelector('[data-browser-projects]').hidden, false);
  assert.equal(root.querySelector('[data-browser-projects] script'), null);
  assert.match(root.querySelector('[data-browser-projects]').textContent, /<Alpha>/u);
  assert.match(root.querySelector('[data-browser-projects]').textContent, /"action":"create"/u);
  assert.match(root.querySelector('[data-browser-projects]').textContent, /"restrictions"/u);
  assert.match(root.querySelector('[data-browser-projects]').textContent, /<unsafe>/u);
  const reviewSelect = root.querySelector('#browser-review-project-review_auto');
  assert.equal(reviewSelect.value, '');
  assert.match(reviewSelect.options[1].textContent, /<Alpha> · \/workspace\/alpha/u);

  await app._handleClick(clickTarget(root.querySelector(
    '[data-action="permission-review-auto"][data-review-id="review_auto"]'
  )));
  assert.equal(calls.some((entry) => entry.operation === 'permissionReview.resolve'), false);

  root.querySelector('#browser-project-create-name').value = 'New project';
  await app._handleClick(clickTarget(root.querySelector('[data-action="project-create"]')));
  assert.deepEqual(calls.find((entry) => entry.operation === 'projects.create').options.params, {
    name: 'New project',
  });

  root.querySelector('#browser-project-root-project_alpha').value = '/workspace/new-alpha';
  await app._handleClick(clickTarget(root.querySelector(
    '[data-action="project-save-root"][data-project-id="project_alpha"]'
  )));
  assert.deepEqual(calls.find((entry) => entry.operation === 'projects.bindRoot').options.params, {
    project_id: 'project_alpha', root_path: '/workspace/new-alpha', expected_root_revision: 3,
  });

  await app._handleClick(clickTarget(root.querySelector(
    '[data-action="project-assign"][data-project-id="project_alpha"]'
  )));
  const assignment = calls.find((entry) => entry.operation === 'projects.assignSession');
  assert.equal(assignment.options.sessionId, 'session_a');
  assert.equal(assignment.options.controlGeneration, 4);
  assert.equal(assignment.options.expectedRevision, 'boot:2');
  assert.deepEqual(assignment.options.params, { project_id: 'project_alpha' });
  assert.equal(app.state.snapshot.session.project_id, 'project_alpha');

  root.querySelector('#browser-review-project-review_auto').value = 'project_alpha';
  await app._handleClick(clickTarget(root.querySelector(
    '[data-action="permission-review-auto"][data-review-id="review_auto"]'
  )));
  const automatic = calls.find((entry) => entry.operation === 'permissionReview.resolve');
  assert.deepEqual(automatic.options.params, {
    review_id: 'review_auto', decision: 'auto', project_id: 'project_alpha',
    expected_root_revision: 3, expected_authority_key: AUTHORITY_KEY,
  });
  await app._handleClick(clickTarget(root.querySelector(
    '[data-action="permission-review-dismiss"][data-review-id="review_discard"]'
  )));
  const resolutions = calls.filter((entry) => entry.operation === 'permissionReview.resolve');
  assert.deepEqual(resolutions[1].options.params, {
    review_id: 'review_discard', decision: 'dismiss',
  });
  assert.ok(calls.filter((entry) => entry.operation === 'permissionReview.getState').length >= 3);
  assert.match(root.querySelector('[data-browser-projects]').textContent, /No imported permissions/u);
});

test('permission review pages stay bounded and page controls are accessible', async (t) => {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  t.after(() => {
    delete global.window;
    delete global.document;
    instance.window.close();
  });
  const pending = Array.from({ length: 101 }, (_, index) => ({
    id: `review_${index}`, tool_name: `tool_${index}`, path_prefix: `/workspace/${index}`,
    original_record: { match: { tool_id: `tool_${index}`, action: `action_${index}` } },
  }));
  const bridge = { clientId: 'client_a', command: async (operation) => {
    if (operation === 'projects.list') return { ok: true, projects: [{
      id: 'project_alpha', name: 'Alpha', root_path: '/workspace/alpha', root_revision: 3,
      authority_key: AUTHORITY_KEY,
    }], storage: { read_only: false } };
    return { ok: true, pending_count: pending.length, pending, history: [], read_only: false };
  } };
  const root = instance.window.document.getElementById('root');
  const app = new BrowserApp({ root, bridge, state: state(), view });
  t.after(() => app.dispose());

  await app._handleClick(clickTarget(root.querySelector('[data-action="projects-toggle"]')));
  assert.equal(root.querySelectorAll('.browser-permission-review').length, 50);
  const previous = root.querySelector('[data-action="permission-review-page"][data-direction="previous"]');
  const next = root.querySelector('[data-action="permission-review-page"][data-direction="next"]');
  assert.equal(previous.disabled, true);
  assert.ok(previous.title);
  assert.ok(previous.getAttribute('aria-label'));
  assert.ok(next.title);
  assert.ok(next.getAttribute('aria-label'));
  await app._handleClick(clickTarget(next));
  assert.ok(root.querySelector('[data-review-id="review_50"]'));
  assert.equal(root.querySelector('#browser-review-project-review_50').value, '');
  await app._handleClick(clickTarget(root.querySelector(
    '[data-action="permission-review-page"][data-direction="next"]'
  )));
  assert.equal(root.querySelectorAll('.browser-permission-review').length, 1);
  assert.ok(root.querySelector('[data-review-id="review_100"]'));
  assert.equal(
    root.querySelector('[data-action="permission-review-page"][data-direction="next"]').disabled,
    true
  );
});

test('assignment completion cannot repaint a newly selected session', async (t) => {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  t.after(() => {
    delete global.window;
    delete global.document;
    instance.window.close();
  });
  let releaseReload;
  let projectListCalls = 0;
  const reloadBlocked = new Promise((resolve) => { releaseReload = resolve; });
  const current = state();
  current.projectsOpen = true;
  current.sessions.push({ session_id: 'session_b', title: 'Other chat', project_id: 'project_general' });
  current.projects = [{
    id: 'project_alpha', name: 'Alpha', root_path: '/workspace/alpha', root_revision: 3,
    authority_key: AUTHORITY_KEY,
  }];
  const bridge = { clientId: 'client_a', command: async (operation, options) => {
    if (operation === 'projects.assignSession') return {
      ok: true,
      session: { session_id: options.sessionId, title: 'Browser chat', project_id: 'project_alpha' },
      revision: 'boot:3',
    };
    if (operation === 'projects.list') {
      projectListCalls += 1;
      await reloadBlocked;
      return { ok: true, projects: current.projects, storage: { read_only: false } };
    }
    return { ok: true, pending_count: 0, pending: [], history: [], read_only: false };
  } };
  const root = instance.window.document.getElementById('root');
  const app = new BrowserApp({ root, bridge, state: current, view });
  t.after(() => app.dispose());

  const assignment = app._handleClick(clickTarget(root.querySelector(
    '[data-action="project-assign"][data-project-id="project_alpha"]'
  )));
  while (projectListCalls === 0) await new Promise((resolve) => { setImmediate(resolve); });
  app.state.selectedSessionId = 'session_b';
  app.state.snapshot.session = {
    session_id: 'session_b', title: 'Other chat', revision: 'boot:7',
    project_id: 'project_general', plan_mode: false,
  };
  releaseReload();
  await assignment;

  assert.equal(
    app.state.sessions.find((session) => session.session_id === 'session_a').project_id,
    'project_alpha'
  );
  assert.equal(
    app.state.sessions.find((session) => session.session_id === 'session_b').project_id,
    'project_general'
  );
  assert.equal(app.state.snapshot.session.session_id, 'session_b');
  assert.equal(app.state.snapshot.session.project_id, 'project_general');
});

test('project assignment is disabled without idle-session control and mutations use receipts', () => {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  try {
    const current = state();
    current.projectsOpen = true;
    current.activeStreamId = 'stream_active';
    current.projects = [{
      id: 'project_alpha', name: 'Alpha', root_path: '/workspace/alpha', root_revision: 1,
      authority_key: AUTHORITY_KEY,
    }];
    const app = new BrowserApp({
      root: instance.window.document.getElementById('root'), bridge: {}, state: current, view,
    });
    assert.equal(
      instance.window.document.querySelector('[data-action="project-assign"]').disabled,
      true
    );
    for (const operation of [
      'projects.create', 'projects.rename', 'projects.bindRoot',
      'projects.assignSession', 'permissionReview.resolve',
    ]) assert.equal(RECEIPT_OPERATIONS.has(operation), true, operation);
    app.dispose();
  } finally {
    delete global.window;
    delete global.document;
    instance.window.close();
  }
});
