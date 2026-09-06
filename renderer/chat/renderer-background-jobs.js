/* renderer/chat/renderer-background-jobs.js
 * Background-job chip strip.
 *
 * Renders one chip per tracked backgrounded run_command job in the strip
 * above the composer: command + live elapsed time while running, a Stop
 * button that dispatches backgroundJobs.kill, and a dismissible terminal
 * chip once the job settles. Snapshots arrive over the bridge-event bus
 * (backgroundJobs.onChanged, pushed by services/main/background-job-tracker)
 * — deliberately NOT the turn-scoped chat stream, because a background job
 * outlives the tool call that started it.
 *
 * Completion surfaces as a toast tagged with the owning session when it
 * differs from the active one — never a navigation hijack. All job-derived
 * text (commands, errors) renders via textContent, never innerHTML.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'));
    return;
  }
  // Browser: action-button.js loads later in document order, so the factory
  // receives null and the strip resolves root.inventoryActionButton lazily at
  // chip-build time (the strip only renders after app boot).
  root.rendererBackgroundJobs = factory(null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (injectedActionButton) {
  'use strict';

  var MAX_VISIBLE_CHIPS = 4;
  var MAX_CHIP_COMMAND_CHARS = 60;
  var TICK_INTERVAL_MS = 1000;

  function noop() {}

  function formatElapsed(elapsedMs) {
    var totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    var mm = (minutes < 10 ? '0' : '') + minutes;
    var ss = (seconds < 10 ? '0' : '') + seconds;
    return hours > 0 ? hours + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function chipCommandLabel(command) {
    var text = String(command || '').trim() || 'background job';
    return text.length > MAX_CHIP_COMMAND_CHARS
      ? text.slice(0, MAX_CHIP_COMMAND_CHARS - 1) + '…'
      : text;
  }

  function isActiveState(state) {
    return state === 'running' || state === 'killing';
  }

  function createBackgroundJobsStrip(deps) {
    var settings = deps || {};
    var windowRef = settings.windowRef
      || (typeof globalThis !== 'undefined' ? globalThis : {});
    var container = settings.container || null;
    var doc = (container && container.ownerDocument)
      || (settings.windowRef && settings.windowRef.document)
      || null;
    var jennyShell = settings.jennyShell || null;
    var showToastMessage = typeof settings.showToastMessage === 'function'
      ? settings.showToastMessage
      : noop;
    var getActiveSessionId = typeof settings.getActiveSessionId === 'function'
      ? settings.getActiveSessionId
      : function () { return ''; };
    var nowFn = typeof settings.nowFn === 'function' ? settings.nowFn : Date.now;

    var unsubscribe = null;
    var tickTimer = null;
    var latestJobs = [];
    var hasReceivedPush = false;
    /** Jobs the user dismissed locally (terminal chips only). */
    var dismissedJobIds = {};
    /** Last seen state per job id, for completion-toast edge detection. */
    var lastSeenStates = {};

    function backgroundJobsApi() {
      return jennyShell && jennyShell.backgroundJobs ? jennyShell.backgroundJobs : null;
    }

    function toastCompletionEdges(jobs) {
      for (var i = 0; i < jobs.length; i += 1) {
        var job = jobs[i];
        var previous = lastSeenStates[job.jobId];
        var terminal = !isActiveState(job.state);
        // Toast only on an observed running→terminal transition: a snapshot
        // that already arrives terminal (e.g. initial getState after a
        // reload) has nothing to announce.
        if (terminal && previous && isActiveState(previous)) {
          var label = chipCommandLabel(job.command);
          var activeSessionId = String(getActiveSessionId() || '').trim();
          var sessionSuffix = job.sessionId && activeSessionId && job.sessionId !== activeSessionId
            ? ' (other session)'
            : '';
          var message = job.state === 'completed'
            ? 'Background job finished: ' + label + sessionSuffix
            : 'Background job failed: ' + label + sessionSuffix;
          showToastMessage(message, { dedupeKey: 'background-job-' + job.jobId });
        }
        lastSeenStates[job.jobId] = job.state;
      }
    }

    function stateLabel(job) {
      if (job.state === 'running') {
        return formatElapsed(nowFn() - (Number(job.startedAtMs) || nowFn()));
      }
      if (job.state === 'killing') {
        return 'Stopping…';
      }
      if (job.state === 'completed') {
        return 'Done';
      }
      return 'Failed';
    }

    function handleKillClick(jobId) {
      var api = backgroundJobsApi();
      if (!api || typeof api.kill !== 'function') {
        return;
      }
      Promise.resolve(api.kill(jobId)).then(function (result) {
        if (!result || result.ok !== true) {
          showToastMessage('Could not stop the background job.', {
            dedupeKey: 'background-job-kill-' + jobId,
          });
        }
      }).catch(function () {
        showToastMessage('Could not stop the background job.', {
          dedupeKey: 'background-job-kill-' + jobId,
        });
      });
    }

    function buildChip(job) {
      var chip = doc.createElement('div');
      chip.className = 'background-job-chip';
      chip.dataset.jobId = job.jobId;
      chip.dataset.jobState = job.state;

      var dot = doc.createElement('span');
      dot.className = 'background-job-chip-dot';
      dot.setAttribute('aria-hidden', 'true');
      chip.appendChild(dot);

      var command = doc.createElement('span');
      command.className = 'background-job-chip-command';
      command.textContent = chipCommandLabel(job.command);
      command.title = String(job.command || '').trim();
      chip.appendChild(command);

      var status = doc.createElement('span');
      status.className = 'background-job-chip-status';
      status.textContent = stateLabel(job);
      chip.appendChild(status);

      // Buttons come from the inventory action-button primitive — the
      // raw-HTML-primitives policy forbids creating them directly here.
      var actionButton = typeof injectedActionButton === 'function'
        ? injectedActionButton
        : (typeof windowRef.inventoryActionButton === 'function'
          ? windowRef.inventoryActionButton
          : null);
      if (actionButton) {
        var active = isActiveState(job.state);
        chip.insertAdjacentHTML('beforeend', actionButton({
          plain: true,
          className: 'background-job-chip-action',
          label: active ? 'Stop' : '✕',
          disabled: job.state === 'killing',
          ariaLabel: (active ? 'Stop background job: ' : 'Dismiss background job: ')
            + chipCommandLabel(job.command),
          title: active ? 'Stop this background job' : 'Dismiss this job',
        }));
        var action = chip.lastElementChild;
        if (action) {
          action.addEventListener('click', active
            ? function () { handleKillClick(job.jobId); }
            : function () {
              dismissedJobIds[job.jobId] = true;
              renderJobs(latestJobs);
            });
        }
      }
      return chip;
    }

    function renderJobs(jobs) {
      if (!container || !doc) {
        return;
      }
      var visible = [];
      for (var i = 0; i < jobs.length; i += 1) {
        if (!dismissedJobIds[jobs[i].jobId]) {
          visible.push(jobs[i]);
        }
      }
      container.textContent = '';
      if (!visible.length) {
        container.classList.add('hidden');
        container.setAttribute('aria-hidden', 'true');
        syncTicker();
        return;
      }
      container.classList.remove('hidden');
      container.removeAttribute('aria-hidden');
      var shown = visible.slice(0, MAX_VISIBLE_CHIPS);
      for (var s = 0; s < shown.length; s += 1) {
        container.appendChild(buildChip(shown[s]));
      }
      if (visible.length > MAX_VISIBLE_CHIPS) {
        var overflow = doc.createElement('span');
        overflow.className = 'background-job-chip background-job-chip-overflow';
        overflow.textContent = '+' + (visible.length - MAX_VISIBLE_CHIPS) + ' more';
        container.appendChild(overflow);
      }
      syncTicker();
    }

    function pruneLocalMaps(jobs) {
      var known = {};
      for (var i = 0; i < jobs.length; i += 1) {
        known[jobs[i].jobId] = true;
      }
      Object.keys(dismissedJobIds).forEach(function (jobId) {
        if (!known[jobId]) {
          delete dismissedJobIds[jobId];
        }
      });
      Object.keys(lastSeenStates).forEach(function (jobId) {
        if (!known[jobId]) {
          delete lastSeenStates[jobId];
        }
      });
    }

    function applySnapshot(snapshot) {
      var jobs = snapshot && Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
      toastCompletionEdges(jobs);
      latestJobs = jobs;
      pruneLocalMaps(jobs);
      renderJobs(jobs);
    }

    function tickElapsed() {
      if (!container) {
        return;
      }
      // Patch textContent directly so elapsed updates do not invalidate or pass through the render cache.
      var chips = container.querySelectorAll('.background-job-chip[data-job-state="running"]');
      for (var i = 0; i < chips.length; i += 1) {
        var jobId = chips[i].dataset.jobId;
        for (var j = 0; j < latestJobs.length; j += 1) {
          if (latestJobs[j].jobId === jobId) {
            var status = chips[i].querySelector('.background-job-chip-status');
            if (status) {
              status.textContent = stateLabel(latestJobs[j]);
            }
            break;
          }
        }
      }
    }

    function hasRunningChip() {
      for (var i = 0; i < latestJobs.length; i += 1) {
        if (latestJobs[i].state === 'running' && !dismissedJobIds[latestJobs[i].jobId]) {
          return true;
        }
      }
      return false;
    }

    function syncTicker() {
      if (hasRunningChip()) {
        if (tickTimer === null) {
          tickTimer = setInterval(tickElapsed, TICK_INTERVAL_MS);
        }
      } else if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    }

    function attach() {
      var api = backgroundJobsApi();
      if (!api || !container) {
        return;
      }
      if (typeof api.onChanged === 'function') {
        unsubscribe = api.onChanged(function (snapshot) {
          hasReceivedPush = true;
          applySnapshot(snapshot);
        });
      }
      if (typeof api.getState === 'function') {
        Promise.resolve(api.getState()).then(function (snapshot) {
          // A pushed snapshot may already have arrived; the initial pull only
          // fills the empty case.
          if (!hasReceivedPush) {
            applySnapshot(snapshot);
          }
        }).catch(noop);
      }
    }

    function detach() {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
        unsubscribe = null;
      }
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    }

    return {
      attach: attach,
      detach: detach,
      applySnapshot: applySnapshot,
      tickElapsed: tickElapsed,
    };
  }

  return {
    createBackgroundJobsStrip: createBackgroundJobsStrip,
    formatElapsed: formatElapsed,
  };
});
