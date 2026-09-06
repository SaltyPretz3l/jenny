/* Core Home surface: the info strip (clock / greeting / weather / today
 * digest) rendered directly into #homeInfoStrip by the dashboard manager,
 * plus the local date helpers the calendar family imports. The strip reads
 * existing renderer state slices (state.weather, state.calendar,
 * state.companion, state.scheduler) — no new IPC. Markup builds on the
 * inventory primitives (actionButton HTML strings); no raw form controls.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardWidgetsCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};

  // The ask line's keyboard hint. It is built ONCE and never removed: CSS alone
  // decides whether it is visible, so a screen reader keeps reading it through
  // aria-describedby at every visual state.
  const ASK_HINT_DOM_ID = 'homeAskPillHint';
  const ASK_SEND_DOM_ID = 'homeAskSend';
  // Enter sends, Shift+Enter inserts a newline, and Ctrl/Cmd+Enter drafts without sending, matching the chat composer.
  const ASK_HINT_TEXT = 'Enter to send · Shift+Enter for a new line';

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatClockTime(now) {
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const meridiem = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${meridiem}`;
  }

  function formatClockDate(now) {
    try {
      return now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    } catch (_error) {
      return now.toDateString();
    }
  }

  function pickGreeting(now) {
    const hour = now.getHours();
    if (hour >= 5 && hour < 12) {
      return 'Good morning';
    }
    if (hour >= 12 && hour < 17) {
      return 'Good afternoon';
    }
    if (hour >= 17 && hour < 22) {
      return 'Good evening';
    }
    return 'Up late';
  }

  function formatWeatherSummary(weather) {
    const source = asObject(weather);
    if (!source || source.available !== true) {
      return '';
    }
    const metric = String(source.units || 'metric') !== 'imperial';
    const temp = metric ? source.tempC : source.tempF;
    if (!Number.isFinite(Number(temp))) {
      return '';
    }
    const reading = `${Math.round(Number(temp))}°${metric ? 'C' : 'F'}`;
    const description = String(source.description || '').trim();
    return description ? `${reading} · ${description}` : reading;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function parseLocalDateTime(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!match) {
      return null;
    }
    const parsed = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatLocalDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function addLocalDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function formatTimeShort(date) {
    const hours24 = date.getHours();
    const minutes = date.getMinutes();
    const meridiem = hours24 < 12 ? 'AM' : 'PM';
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    return minutes ? `${hours12}:${pad2(minutes)} ${meridiem}` : `${hours12} ${meridiem}`;
  }

  function formatDigestTime(startString) {
    const match = /T(\d{2}):(\d{2})/.exec(String(startString || ''));
    if (!match) {
      return '';
    }
    const hours24 = Number(match[1]);
    const minutes = match[2];
    const meridiem = hours24 < 12 ? 'AM' : 'PM';
    const hours12 = hours24 % 12 || 12;
    return minutes === '00' ? `${hours12} ${meridiem}` : `${hours12}:${minutes} ${meridiem}`;
  }

  // One-line "today digest": next timed calendar event, open-loop count, and
  // the next scheduled run. Every read is defensive — each segment simply
  // drops out when its source slice is absent or empty, and the whole line
  // disappears when nothing is worth saying.
  function formatTodayDigest(state, now) {
    const segments = [];
    const nowKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
      + `T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const instances = Array.isArray(state?.calendar?.instances) ? state.calendar.instances : [];
    const nextEvent = instances.find((instance) =>
      asObject(instance) && instance.allDay !== true && String(instance.start || '') > nowKey);
    if (nextEvent) {
      const title = String(nextEvent.title || '').trim() || 'event';
      const timeLabel = formatDigestTime(nextEvent.start);
      const sameDay = String(nextEvent.start).slice(0, 10) === nowKey.slice(0, 10);
      let dayLabel = '';
      if (!sameDay) {
        const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(nextEvent.start);
        if (dateMatch) {
          try {
            dayLabel = new Date(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3])
              .toLocaleDateString(undefined, { weekday: 'short' });
          } catch (_error) {
            dayLabel = '';
          }
        }
      }
      segments.push(`Next: ${title}${dayLabel ? ` ${dayLabel}` : ''}${timeLabel ? ` ${sameDay ? 'at ' : ''}${timeLabel}` : ''}`);
      // Tier up with the rest of today so the always-visible strip owns the
      // one-line glance (and the widget owns browse/edit). Only today's timed
      // events after the next one count toward "then" / "+N more today".
      const restToday = instances
        .filter((instance) => asObject(instance)
          && instance.allDay !== true
          && String(instance.start || '').slice(0, 10) === nowKey.slice(0, 10)
          && String(instance.start || '') > String(nextEvent.start || ''))
        .sort((a, b) => (String(a.start) < String(b.start) ? -1 : 1));
      if (restToday.length) {
        const thenTitle = String(restToday[0].title || '').trim() || 'event';
        const thenTime = formatDigestTime(restToday[0].start);
        segments.push(`then ${thenTitle}${thenTime ? ` ${thenTime}` : ''}`);
        if (restToday.length > 1) {
          segments.push(`+${restToday.length - 1} more today`);
        }
      }
    }
    const activeLoops = Number(state?.companion?.openLoopsBoard?.counts?.active);
    if (Number.isFinite(activeLoops) && activeLoops > 0) {
      segments.push(`${activeLoops} open loop${activeLoops === 1 ? '' : 's'}`);
    }
    const nextRun = asObject(state?.scheduler?.upcoming?.[0]);
    if (nextRun && String(nextRun.label || '').trim()) {
      const eta = String(nextRun.eta || '').trim();
      segments.push(`Next run: ${String(nextRun.label).trim()}${eta ? ` ${eta}` : ''}`);
    }
    return segments.join(' · ');
  }

  function createInfoStripRenderer(deps = {}) {
    const nowProvider = typeof deps.nowProvider === 'function'
      ? deps.nowProvider
      : function defaultNowProvider() { return new Date(); };
    const textField = typeof deps.textField === 'function'
      ? deps.textField
      : (typeof windowRef.inventoryTextField === 'function' ? windowRef.inventoryTextField : null);
    const actionButton = typeof deps.actionButton === 'function'
      ? deps.actionButton
      : (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton : null);

    // The hero ask line is built ONCE and then left alone. The manager's 30s
    // clock timer rewrites the strip's chrome via innerHTML; a field living
    // inside that markup would be destroyed mid-typing (value AND focus lost)
    // on every tick, so it gets its own sibling region the repaint never
    // touches.
    //
    // Anatomy: a two-row stack, not a capsule. The field row draws ONE
    // hairline rule under the text; the meta row below it carries the model
    // trigger, the keyboard hint, and the send button. The meta row's height
    // is reserved at every state so nothing on Home shifts as it reveals
    // itself.
    function ensureAskRegion(stripEl) {
      const documentRef = stripEl.ownerDocument;
      let ask = stripEl.querySelector('.home-info-strip__ask');
      if (ask || !documentRef || !textField) {
        return ask;
      }
      ask = documentRef.createElement('div');
      ask.className = 'home-info-strip__ask';
      ask.innerHTML = '<div class="home-ask__shell">'
        + '<div class="home-ask__field-row">'
        + textField({
          id: 'homeAskPill',
          // The field FIRES A MESSAGE, so the accessible name has to state the
          // whole keyboard contract - a control that sends must not read as a
          // plain text box.
          ariaLabel: 'Ask Jenny. Enter starts a new chat and sends; '
            + 'Shift plus Enter adds a new line; Control or Command plus Enter drafts without sending.',
          placeholder: 'Ask Jenny…',
          hint: ASK_HINT_TEXT,
          multiline: true,
          // The autosize FLOOR. No maxLength: the composer this feeds has no
          // cap either, and a silent truncation at paste time is worse than a
          // long prompt.
          rows: 1,
          // Parity with #chatInput, which leaves Chromium's spellchecker on.
          spellcheck: true,
          className: 'home-ask-pill',
          dataset: { 'home-ask-input': '1' },
        })
        + '</div>'
        // The config controller mounts its model trigger + panel in here, at
        // the FRONT of the row; the hint and the send button follow it.
        + '<div class="home-ask__meta"></div>'
        + '</div>';
      stripEl.append(ask);
      const meta = ask.querySelector('.home-ask__meta');
      // The primitive emits no id on its hint and renders it inside the field
      // label; the hint belongs on the meta row, so it is MOVED (never rebuilt)
      // and the describedby wiring is done here. Visual state is CSS-only.
      const hintEl = ask.querySelector('.inv-text-field-hint');
      const controlEl = ask.querySelector('.inv-text-field-control');
      if (hintEl && meta) {
        hintEl.id = ASK_HINT_DOM_ID;
        hintEl.classList.add('home-ask__hint');
        meta.append(hintEl);
      }
      if (hintEl && controlEl) {
        controlEl.setAttribute('aria-describedby', ASK_HINT_DOM_ID);
      }
      // The only mouse path to submit. The daybook controller owns the
      // click, routing it through the SAME onAsk path Enter uses.
      if (meta && actionButton) {
        meta.insertAdjacentHTML('beforeend', actionButton({
          plain: true,
          domId: ASK_SEND_DOM_ID,
          className: 'home-ask__send',
          trustedHtml: '&#8593;',
          ariaLabel: 'Send',
          title: 'Start a new chat with this question',
          dataset: { 'home-ask-send': '1' },
        }));
      }
      return ask;
    }

    function ensureChrome(stripEl) {
      const documentRef = stripEl.ownerDocument;
      let chrome = stripEl.querySelector('.home-info-strip__chrome');
      if (chrome || !documentRef) {
        return chrome;
      }
      // A strip carrying a pre-split (flat) render is cleared once, here.
      stripEl.innerHTML = '';
      chrome = documentRef.createElement('div');
      chrome.className = 'home-info-strip__chrome';
      stripEl.append(chrome);
      return chrome;
    }

    function render(stripEl, ctx = {}) {
      if (!stripEl) {
        return;
      }
      const chromeEl = ensureChrome(stripEl);
      if (!chromeEl) {
        return;
      }
      const now = nowProvider();
      const weatherSummary = formatWeatherSummary(ctx.state?.weather);
      const digest = formatTodayDigest(ctx.state, now);
      // Lead = clock numeral + a stacked greeting/date heading; actions =
      // the weather chip (pushed right — the focus/edit controls moved into
      // the built-once ask region's page menu); digest wraps onto its own
      // full-width line below. Leaf class names are unchanged so the strip's
      // selector-based tests keep matching.
      chromeEl.innerHTML = ''
        + '<div class="home-info-strip__lead">'
        + `<span class="home-info-strip__time">${escapeHtml(formatClockTime(now))}</span>`
        + '<span class="home-info-strip__heading">'
        + `<span class="home-info-strip__greeting">${escapeHtml(pickGreeting(now))}</span>`
        + `<span class="home-info-strip__date">${escapeHtml(formatClockDate(now))}</span>`
        + '</span>'
        + '</div>'
        + '<div class="home-info-strip__actions">'
        + (weatherSummary
          ? `<span class="home-info-strip__weather">${escapeHtml(weatherSummary)}</span>`
          : '')
        + '</div>'
        + (digest
          ? `<div class="home-info-strip__digest">${escapeHtml(digest)}</div>`
          : '');
      ensureAskRegion(stripEl);
      stripEl.hidden = false;
    }

    return { render };
  }

  return {
    createInfoStripRenderer,
    ASK_HINT_DOM_ID,
    ASK_HINT_TEXT,
    formatTodayDigest,
    pickGreeting,
    formatClockTime,
    parseLocalDateTime,
    pad2,
    formatLocalDate,
    startOfLocalDay,
    addLocalDays,
    formatTimeShort,
  };
});
