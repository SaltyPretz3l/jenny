'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeChangesPanel } = require('../renderer/features/renderer-ide-changes-panel');
const { createIdeUiState } = require('../renderer/features/renderer-ide-state');
const { settle } = require('./helpers/renderer-ide-harness');

const CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e2525';
const SECOND_CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e2526';
const TRASH_NAME = '20260904T150311.401Z';
const MISSING_SIGNATURE = {
  kind: 'missing', byte_size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

function outsideUndoSet(overrides = {}) {
  return {
    shell_mutations: 'not_journaled_approval_gated',
    explorer_rename: 'not_journaled_until_wo_27_item_2',
    known_unjournaled_events: [],
    warning: 'Approved shell mutations and Explorer renames may be outside this recovery set.',
    ...overrides,
  };
}

function changeSet(overrides = {}) {
  return {
    change_set_id: CHANGE_SET_ID,
    state: 'committed',
    restore_status: 'not_requested',
    operation_count: 3,
    updated_at: '2026-09-04T00:00:00Z',
    partially_undoable: false,
    warning: '',
    ...overrides,
  };
}

function step(overrides = {}) {
  return {
    sequence: 1,
    inverse_step_id: '1.1',
    kind: 'move_back',
    from_relative_path: 'after/a.txt',
    to_relative_path: 'before/a.txt',
    expected_current_signature: MISSING_SIGNATURE,
    ...overrides,
  };
}

function conflict(overrides = {}) {
  return {
    inverse_step_id: '1.1',
    sequence: 1,
    kind: 'move_back',
    relative_path: 'before/a.txt',
    reasons: ['destination_occupied'],
    expected_signature: MISSING_SIGNATURE,
    current_signature: { ...MISSING_SIGNATURE, kind: 'file' },
    allowed_outcomes: ['skip', 'alternate_name', 'protect_then_replace'],
    ...overrides,
  };
}

function preflight(overrides = {}) {
  return {
    ok: true,
    change_set_id: CHANGE_SET_ID,
    status: 'preflight',
    conflicts: [],
    inverse_plan: [step()],
    staging_entries: [],
    outside_undo_set: outsideUndoSet(),
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    ok: true,
    change_set_id: CHANGE_SET_ID,
    status: 'committed',
    restored: [{ inverse_step_id: '1.1', relative_path: 'before/a.txt' }],
    skipped: [],
    renamed_to: [],
    protected: [],
    outside_undo_set: outsideUndoSet(),
    ...overrides,
  };
}

function createApi(overrides = {}) {
  const calls = { list: [], preflight: [], undo: [], restoreTrash: [] };
  return {
    calls,
    async listChangeSets(payload) {
      calls.list.push(payload);
      return overrides.list || {
        ok: true, workspace_id: 'root_test', change_sets: [changeSet()], outside_undo_set: outsideUndoSet(),
      };
    },
    async preflightUndo(payload) {
      calls.preflight.push(payload);
      return typeof overrides.preflight === 'function' ? overrides.preflight(payload) : (overrides.preflight || preflight());
    },
    async undoChangeSet(payload) {
      calls.undo.push(payload);
      return typeof overrides.undo === 'function' ? overrides.undo(payload) : (overrides.undo || receipt());
    },
    async restoreTrashEntry(payload) {
      calls.restoreTrash.push(payload);
      return typeof overrides.restoreTrash === 'function'
        ? overrides.restoreTrash(payload)
        : (overrides.restoreTrash || {
          ok: true,
          name: TRASH_NAME,
          status: 'committed',
          restored: [{ relative_path: 'deleted.txt' }],
          skipped: [],
          renamed_to: [],
          protected: [],
          outside_undo_set: outsideUndoSet(),
          recovery_retained: true,
        });
    },
  };
}

function createHarness(t, { api = createApi(), confirm = async () => true } = {}) {
  const dom = new JSDOM('<div id="rail"></div>');
  const rail = dom.window.document.getElementById('rail');
  const confirmCalls = [];
  const panel = createIdeChangesPanel({
    getDom: () => ({ ideRailPanel: rail }),
    getIde: () => createIdeUiState(),
    isActivePanel: () => true,
    getChangeLedger: () => ({ changes: [] }),
    getDirtyPaths: () => [],
    getWorkspaceId: () => 'root_test',
    getWorkspaceRecoveryApi: () => api,
    confirmDialog: {
      async confirm(config) {
        confirmCalls.push(config);
        return confirm(config);
      },
    },
  });
  panel.bindEvents();
  t.after(() => {
    panel.dispose();
    dom.window.close();
  });
  return { api, confirmCalls, dom, panel, rail };
}

async function renderLoaded(harness) {
  harness.panel.renderChangesPanel();
  await settle();
  harness.panel.renderChangesPanel();
}

test('newest-first batch rows expose inventory Review and Undo actions', async (t) => {
  const api = createApi({
    list: {
      ok: true,
      workspace_id: 'root_test',
      change_sets: [
        changeSet({ change_set_id: SECOND_CHANGE_SET_ID, operation_count: 2 }),
        changeSet({ operation_count: 1 }),
      ],
      outside_undo_set: outsideUndoSet(),
    },
  });
  const harness = createHarness(t, { api });
  await renderLoaded(harness);

  const rows = [...harness.rail.querySelectorAll('[data-ide-changeset-id]')];
  assert.equal(api.calls.list.length, 2);
  assert.deepEqual(rows.map((row) => row.dataset.ideChangesetId), [SECOND_CHANGE_SET_ID, CHANGE_SET_ID]);
  assert.equal(rows[0].querySelector('[data-ide-changeset-review]').tagName, 'BUTTON');
  assert.equal(rows[0].querySelector('[data-ide-changeset-undo]').tagName, 'BUTTON');
  assert.match(rows[0].textContent, /Jenny changed 2 files/);
});

test('Review renders restore, conflict, trash Restore, and outside-set rows without executing', async (t) => {
  const trashStep = step({
    inverse_step_id: '2.1',
    sequence: 2,
    kind: 'restore_object',
    from_relative_path: `.jenny/trash/${TRASH_NAME}/deleted.txt`,
    to_relative_path: 'deleted.txt',
  });
  const api = createApi({
    preflight: preflight({
      conflicts: [conflict()],
      inverse_plan: [step(), trashStep],
      outside_undo_set: outsideUndoSet({ known_unjournaled_events: ['run_command:approved:abc123'] }),
    }),
  });
  const harness = createHarness(t, { api });
  await renderLoaded(harness);

  harness.rail.querySelector(`[data-ide-changeset-review="${CHANGE_SET_ID}"]`).click();
  await settle();

  assert.deepEqual(api.calls.preflight, [{ changeSetId: CHANGE_SET_ID }]);
  assert.equal(api.calls.undo.length, 0);
  assert.match(harness.rail.textContent, /conflict.*before\/a\.txt/s);
  assert.match(harness.rail.textContent, /restore.*deleted\.txt/s);
  assert.equal(harness.rail.querySelector(`[data-ide-trash-restore="${TRASH_NAME}"]`).tagName, 'BUTTON');
  assert.match(harness.rail.querySelector('.ide-changes-outside-undo').textContent, /outside undo set 1/);
});

test('clean batch Undo confirms, executes, and keeps an honest inventory receipt on the row', async (t) => {
  const api = createApi({
    undo: receipt({
      restored: [{ inverse_step_id: '1.1', relative_path: 'a.txt' }],
      skipped: [{ inverse_step_id: '2.1', relative_path: 'b.txt' }],
      renamed_to: [{ inverse_step_id: '3.1', relative_path: 'c.txt', restored_relative_path: 'c.restored.txt' }],
      protected: [{ object_id: 'backup:one', workspace_relative_path: '.jenny/backups/one', signature: MISSING_SIGNATURE }],
      outside_undo_set: outsideUndoSet({ known_unjournaled_events: ['shell'] }),
    }),
  });
  const harness = createHarness(t, { api });
  await renderLoaded(harness);

  harness.rail.querySelector(`[data-ide-changeset-undo="${CHANGE_SET_ID}"]`).click();
  await settle();

  assert.equal(harness.confirmCalls.length, 1);
  assert.deepEqual(api.calls.undo, [{ changeSetId: CHANGE_SET_ID, decisions: {} }]);
  const notice = harness.rail.querySelector('[data-status-tone="success"]');
  assert.match(notice.textContent, /restored 1 · skipped 1 · renamed 1 · protected 1 · outside undo set 1/);
  const outside = harness.rail.querySelector('.ide-changes-outside-undo');
  outside.open = true;
  assert.match(outside.textContent, /Approved shell commands are not recorded in this undo set\./);
  assert.match(outside.textContent, /Explorer renames are not recorded in this undo set\./);
  assert.doesNotMatch(outside.textContent, /not_journaled_/);
  assert.match(outside.textContent, /Unjournaled event: shell/);

  harness.rail.querySelector(`[data-ide-changeset-review="${CHANGE_SET_ID}"]`).click();
  await settle();
  assert.ok(harness.rail.querySelector('[data-status-tone="success"]'), 'the receipt remains first');
  assert.match(harness.rail.textContent, /restore.*before\/a\.txt/s, 'Review still renders the plan after Undo');
});

test('coverage notes render as copy without an outside count or raw enum tokens', async (t) => {
  const harness = createHarness(t, { api: createApi({ undo: receipt() }) });
  await renderLoaded(harness);
  harness.rail.querySelector(`[data-ide-changeset-undo="${CHANGE_SET_ID}"]`).click();
  await settle();

  const notice = harness.rail.querySelector('[data-status-tone="success"]');
  const outside = harness.rail.querySelector('.ide-changes-outside-undo');
  assert.doesNotMatch(notice.textContent, /outside undo set/);
  assert.equal(outside.querySelector('summary').textContent, 'outside undo set');
  assert.match(outside.textContent, /Approved shell commands are not recorded in this undo set\./);
  assert.match(outside.textContent, /Explorer renames are not recorded in this undo set\./);
  assert.doesNotMatch(outside.textContent, /not_journaled_/);
});

test('Recent batches re-lists on a later panel render while ready', async (t) => {
  const harness = createHarness(t);
  harness.panel.renderChangesPanel();
  await settle();
  assert.equal(harness.api.calls.list.length, 1);

  harness.panel.renderChangesPanel();
  await settle();
  assert.equal(harness.api.calls.list.length, 2);
});

test('conflicting batch Undo uses one modal with exactly three choices per conflict and gates submit', async (t) => {
  const conflicts = [conflict(), conflict({ inverse_step_id: '2.1', sequence: 2, relative_path: 'b.txt' })];
  const api = createApi({
    preflight: preflight({ conflicts, inverse_plan: [step(), step({ inverse_step_id: '2.1', sequence: 2 })] }),
  });
  const harness = createHarness(t, { api });
  await renderLoaded(harness);

  harness.rail.querySelector(`[data-ide-changeset-undo="${CHANGE_SET_ID}"]`).click();
  await settle();

  const dialog = harness.dom.window.document.getElementById('ideChangesRecoveryConflictOverlay');
  const groups = [...dialog.querySelectorAll('[data-recovery-conflict]')];
  const submit = dialog.querySelector('[data-recovery-submit]');
  assert.equal(harness.confirmCalls.length, 0);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.querySelectorAll('[data-recovery-choice]').length), [3, 3]);
  assert.equal(submit.disabled, true);

  groups[0].querySelector('[data-recovery-choice="skip"]').click();
  assert.equal(groups[0].querySelectorAll('[aria-pressed="true"]').length, 1);
  assert.equal(submit.disabled, true);
  groups[1].querySelector('[data-recovery-choice="alternate_name"]').click();
  assert.equal(groups[1].querySelectorAll('[aria-pressed="true"]').length, 1);
  assert.equal(submit.disabled, false);
  submit.click();
  await settle();

  assert.deepEqual(api.calls.undo, [{
    changeSetId: CHANGE_SET_ID,
    decisions: { '1.1': 'skip', '2.1': 'alternate_name' },
  }]);
});

test('needs_review and structured failures preserve the RPC message verbatim', async (t) => {
  const api = createApi({
    undo: {
      ok: false,
      reason: 'restore_needs_review',
      status: 'needs_review',
      message: 'Interrupted restore requires manual review.',
    },
  });
  const harness = createHarness(t, { api });
  await renderLoaded(harness);
  harness.rail.querySelector(`[data-ide-changeset-undo="${CHANGE_SET_ID}"]`).click();
  await settle();

  const notice = harness.rail.querySelector('[data-status-tone="danger"]');
  assert.equal(notice.querySelector('.inv-status-row-label').textContent, 'Undo');
  assert.match(notice.querySelector('.inv-status-row-message').textContent, /Interrupted restore requires manual review\./);
});

test('trash Restore derives the bounded trash name and renders its own receipt', async (t) => {
  const trashStep = step({
    kind: 'restore_object',
    from_relative_path: `.jenny/trash/${TRASH_NAME}/deleted.txt`,
    to_relative_path: 'deleted.txt',
  });
  const api = createApi({ preflight: preflight({ inverse_plan: [trashStep] }) });
  const harness = createHarness(t, { api });
  await renderLoaded(harness);
  harness.rail.querySelector(`[data-ide-changeset-review="${CHANGE_SET_ID}"]`).click();
  await settle();

  harness.rail.querySelector(`[data-ide-trash-restore="${TRASH_NAME}"]`).click();
  await settle();

  assert.deepEqual(api.calls.restoreTrash, [{ name: TRASH_NAME }]);
  const notice = harness.rail.querySelector('[data-status-tone="success"]');
  assert.equal(notice.querySelector('.inv-status-row-label').textContent, 'Restore');
  assert.match(notice.querySelector('.inv-status-row-message').textContent, /restored 1/);
});

test('occupied trash Restore reuses the three-choice modal and forwards the selected outcome', async (t) => {
  const trashStep = step({
    kind: 'restore_object',
    from_relative_path: `.jenny/trash/${TRASH_NAME}/deleted.txt`,
    to_relative_path: 'deleted.txt',
  });
  const trashConflict = conflict({ kind: 'restore_object', relative_path: 'deleted.txt' });
  const api = createApi({ preflight: preflight({ conflicts: [trashConflict], inverse_plan: [trashStep] }) });
  const harness = createHarness(t, { api });
  await renderLoaded(harness);
  harness.rail.querySelector(`[data-ide-changeset-review="${CHANGE_SET_ID}"]`).click();
  await settle();
  harness.rail.querySelector(`[data-ide-trash-restore="${TRASH_NAME}"]`).click();
  await settle();

  const dialog = harness.dom.window.document.getElementById('ideChangesRecoveryConflictOverlay');
  dialog.querySelector('[data-recovery-choice="protect_then_replace"]').click();
  assert.equal(dialog.querySelector('[data-recovery-submit]').disabled, false);
  dialog.querySelector('[data-recovery-submit]').click();
  await settle();

  assert.deepEqual(api.calls.restoreTrash, [{ name: TRASH_NAME, decision: 'protect_then_replace' }]);
});

test('preflight failures render the structured RPC text and never execute Undo', async (t) => {
  const api = createApi({
    preflight: { ok: false, reason: 'change_set_not_restorable', message: 'Server says this set is not restorable.' },
  });
  const harness = createHarness(t, { api });
  await renderLoaded(harness);
  harness.rail.querySelector(`[data-ide-changeset-review="${CHANGE_SET_ID}"]`).click();
  await settle();

  assert.match(harness.rail.textContent, /Server says this set is not restorable\./);
  assert.equal(api.calls.undo.length, 0);
});

test('a failed Recent batches request offers Retry, and Retry re-requests from the error state', async (t) => {
  const api = createApi();
  const listChangeSets = api.listChangeSets.bind(api);
  let failuresLeft = 1;
  api.listChangeSets = async (payload) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      api.calls.list.push(payload);
      throw new Error('sidecar restarting');
    }
    return listChangeSets(payload);
  };
  const harness = createHarness(t, { api });
  harness.panel.renderChangesPanel();
  await settle();
  harness.panel.renderChangesPanel();
  assert.equal(api.calls.list.length, 1, 'an error state does not re-request on an ordinary render');
  assert.match(harness.rail.textContent, /Workspace recovery request failed\./);
  const retry = harness.rail.querySelector('[data-ide-changeset-retry]');
  assert.ok(retry, 'the error state renders a Retry control');

  retry.click();
  await settle();
  assert.equal(api.calls.list.length, 2, 'Retry re-requests the list');
  assert.equal(harness.rail.querySelector('[data-ide-changeset-retry]'), null);
  assert.ok(harness.rail.querySelector('[data-ide-changeset-undo]'), 'rows render once the retried list succeeds');
});
